import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ProjectRecord,
  RepositoryIndexResponse,
  RepositoryPreviewExclusionReason,
  RepositoryPreviewResponse,
} from '@kodex/kodex-api';
import type { KnowledgeScope, KnowledgeService } from '@kodex/product-db';

export const REPOSITORY_INDEX_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxPreviewFiles: 500,
  maxPreviewReadBytes: 16 * 1024 * 1024,
  maxScanEntries: 5_000,
  maxSelectedFiles: 50,
  maxTotalBytes: 2 * 1024 * 1024,
  maxTotalCharacters: 500_000,
  previewTtlMs: 10 * 60_000,
  maxActivePreviews: 256,
});

type RepositoryIndexLimits = typeof REPOSITORY_INDEX_LIMITS;

interface FileFingerprint {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

interface PreviewCandidate extends FileFingerprint {
  absolutePath: string;
  contentChecksum: string;
  relativePath: string;
}

interface StoredPreview {
  candidates: Map<string, PreviewCandidate>;
  createdAt: number;
  expiresAt: number;
  projectId: string;
  rootRealPath: string;
  scopeKey: string;
}

interface SafeTextFile {
  characters: number;
  content: string;
  contentChecksum: string;
  fingerprint: FileFingerprint;
}

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.kodex-data', 'node_modules', 'dist', 'build', 'coverage',
]);

const SECRET_BASENAMES = new Set([
  '.env', 'credentials', 'credentials.json', 'secrets', 'secrets.json',
  'service-account.json', 'service_account.json', 'id_rsa', 'id_dsa',
  'id_ecdsa', 'id_ed25519', '.ssh', '.aws', '.azure', '.gnupg', '.kube',
]);

const SECRET_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore']);
const GIT_POLICY_TIMEOUT_MS = 5_000;

export class RepositoryIndexError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 503,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(code);
    this.name = 'RepositoryIndexError';
  }
}

function scopeKey(scope: KnowledgeScope): string {
  return `${scope.userId}:${scope.workspaceId}`;
}

function fingerprint(stats: Stats): FileFingerprint {
  return { dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function portableRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function hasUnsafeDisplayCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1F
      || (code >= 0x7F && code <= 0x9F)
      || (code >= 0x202A && code <= 0x202E)
      || (code >= 0x2066 && code <= 0x2069);
  });
}

function isSafeRelativePath(relativePath: string): boolean {
  return relativePath.length >= 1
    && relativePath.length <= 1_000
    && relativePath === relativePath.normalize('NFC')
    && !hasUnsafeDisplayCharacter(relativePath)
    && relativePath.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function safeProjectLabel(value: unknown): string {
  if (typeof value !== 'string') return 'Project';
  const filtered = [...value.normalize('NFC')]
    .filter((character) => !hasUnsafeDisplayCharacter(character))
    .join('')
    .trim();
  return Array.from(filtered || 'Project').slice(0, 120).join('');
}

function isSecretPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (SECRET_BASENAMES.has(basename) || basename.startsWith('.env.')) return true;
  if (SECRET_EXTENSIONS.has(path.posix.extname(basename))) return true;
  return /(?:^|[._-])(?:credential|secret|private[-_]?key)(?:[._-]|$)/iu.test(basename);
}

function hasBinaryControls(value: string): boolean {
  let controls = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) return true;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) controls += 1;
  }
  return controls > Math.max(4, Math.floor(Array.from(value).length / 100));
}

function decodeText(buffer: Buffer): { characters: number; content: string } {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new RepositoryIndexError(409, 'file_changed', 'A selected file is no longer eligible. Create a new preview.');
  }
  if (!content.trim() || hasBinaryControls(content)) {
    throw new RepositoryIndexError(409, 'file_changed', 'A selected file is no longer eligible. Create a new preview.');
  }
  return { content, characters: Array.from(content).length };
}

async function hasGitMarkerAtOrAbove(root: string): Promise<boolean> {
  let current = path.resolve(root);
  while (true) {
    if (await lstat(path.join(current, '.git')).catch(() => undefined)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function safeReadText(
  rootRealPath: string,
  absolutePath: string,
  maximumBytes: number,
): Promise<SafeTextFile> {
  const before = await lstat(absolutePath).catch(() => undefined);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new RepositoryIndexError(409, 'file_changed', 'A selected file is no longer eligible. Create a new preview.');
  }
  const resolved = await realpath(absolutePath).catch(() => '');
  if (!resolved || !isInside(rootRealPath, resolved)) {
    throw new RepositoryIndexError(409, 'file_changed', 'A selected file is no longer eligible. Create a new preview.');
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow).catch(() => undefined);
  if (!handle) {
    throw new RepositoryIndexError(409, 'file_changed', 'A selected file is no longer eligible. Create a new preview.');
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximumBytes) {
      throw new RepositoryIndexError(409, 'file_changed', 'A selected file is no longer eligible. Create a new preview.');
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const contentBuffer = buffer.subarray(0, bytesRead);
    const after = await handle.stat();
    const currentRealPath = await realpath(absolutePath).catch(() => '');
    if (
      contentBuffer.length !== opened.size
      || contentBuffer.length > maximumBytes
      || !sameFingerprint(fingerprint(opened), fingerprint(after))
      || !currentRealPath
      || !isInside(rootRealPath, currentRealPath)
    ) {
      throw new RepositoryIndexError(409, 'file_changed', 'A selected file changed during validation. Create a new preview.');
    }
    const decoded = decodeText(contentBuffer);
    return {
      ...decoded,
      contentChecksum: createHash('sha256').update(contentBuffer).digest('hex'),
      fingerprint: fingerprint(after),
    };
  } finally {
    await handle.close();
  }
}

async function gitIgnoredPaths(root: string, relativePaths: readonly string[]): Promise<Set<string>> {
  if (relativePaths.length === 0) return new Set();
  const hasRepositoryMarker = await hasGitMarkerAtOrAbove(root);
  const insideRepository = await new Promise<boolean>((resolve, reject) => {
    const child = spawn('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new RepositoryIndexError(
        503, 'repository_preview_unavailable', 'Repository ignore rules could not be verified safely.',
      ));
    };
    const timer = setTimeout(() => { child.kill(); fail(); }, GIT_POLICY_TIMEOUT_MS);
    child.once('error', fail);
    child.once('exit', (code) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      } else if (hasRepositoryMarker) {
        fail();
      } else {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
  if (!insideRepository) return new Set();

  return new Promise<Set<string>>((resolve, reject) => {
    const child = spawn('git', ['check-ignore', '--stdin', '-z'], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new RepositoryIndexError(
        503, 'repository_preview_unavailable', 'Repository ignore rules could not be verified safely.',
      ));
    };
    const timer = setTimeout(() => { child.kill(); fail(); }, GIT_POLICY_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) { child.kill(); fail(); }
      else output.push(chunk);
    });
    child.once('error', fail);
    child.once('exit', (code) => {
      if (settled) return;
      if (code !== 0 && code !== 1) {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timer);
      const ignored = Buffer.concat(output).toString('utf8').split('\0').filter(Boolean)
        .map((entry) => entry.replaceAll('\\', '/'));
      resolve(new Set(ignored));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${relativePaths.join('\0')}\0`);
  });
}

function boundedTitle(projectName: string, relativePath: string): string {
  const prefix = `${Array.from(projectName).slice(0, 60).join('')} / `;
  const maximumPath = Math.max(1, 200 - Array.from(prefix).length);
  const pathCharacters = Array.from(relativePath);
  const suffix = pathCharacters.length <= maximumPath
    ? relativePath
    : `…${pathCharacters.slice(-(maximumPath - 1)).join('')}`;
  return `${prefix}${suffix}`;
}

export class RepositoryIndexer {
  readonly limits: RepositoryIndexLimits;
  #previews = new Map<string, StoredPreview>();

  constructor(
    readonly knowledge: KnowledgeService,
    readonly clock: () => number = Date.now,
    limits: Partial<RepositoryIndexLimits> = {},
    readonly excludedRoots: readonly string[] = [],
  ) {
    this.limits = Object.freeze({ ...REPOSITORY_INDEX_LIMITS, ...limits });
  }

  async preview(scope: KnowledgeScope, project: ProjectRecord): Promise<RepositoryPreviewResponse> {
    this.#prune();
    const rootRealPath = await realpath(project.path).catch(() => '');
    if (!rootRealPath) {
      throw new RepositoryIndexError(409, 'project_changed', 'The active project is no longer available.');
    }
    const rootStats = await lstat(project.path).catch(() => undefined);
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
      throw new RepositoryIndexError(409, 'project_changed', 'The active project is no longer available.');
    }
    const excludedRealRoots = await Promise.all(this.excludedRoots.map(async (entry) => (
      realpath(entry).catch(() => path.resolve(entry))
    )));
    if (excludedRealRoots.some((entry) => isInside(entry, rootRealPath))) {
      throw new RepositoryIndexError(409, 'project_changed', 'The active project is not eligible for repository indexing.');
    }

    const excluded = new Map<RepositoryPreviewExclusionReason, number>();
    const exclude = (reason: RepositoryPreviewExclusionReason, count = 1): void => {
      excluded.set(reason, Math.min(this.limits.maxScanEntries, (excluded.get(reason) ?? 0) + count));
    };
    const discovered: Array<Omit<PreviewCandidate, 'contentChecksum'>> = [];
    let scanned = 0;
    let truncated = false;

    const walk = async (directory: string): Promise<void> => {
      if (scanned >= this.limits.maxScanEntries) { truncated = true; return; }
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
      if (!entries) { exclude('unsupported_file'); return; }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (scanned >= this.limits.maxScanEntries) { truncated = true; break; }
        scanned += 1;
        const absolutePath = path.join(directory, entry.name);
        const relativePath = portableRelativePath(rootRealPath, absolutePath);
        if (!isSafeRelativePath(relativePath)) { exclude('unsupported_file'); continue; }
        if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          exclude('default_directory');
          continue;
        }
        if (isSecretPath(relativePath)) { exclude('credential_or_secret'); continue; }
        const entryStats = await lstat(absolutePath).catch(() => undefined);
        if (!entryStats) { exclude('unsupported_file'); continue; }
        if (entryStats.isSymbolicLink()) { exclude('unsafe_link'); continue; }
        if (entryStats.isDirectory()) {
          const directoryRealPath = await realpath(absolutePath).catch(() => '');
          if (excludedRealRoots.some((entry) => isInside(entry, directoryRealPath))) {
            exclude('default_directory');
          } else if (!directoryRealPath || !isInside(rootRealPath, directoryRealPath)) {
            exclude('unsafe_link');
          } else {
            await walk(absolutePath);
          }
          continue;
        }
        if (!entryStats.isFile()) { exclude('unsupported_file'); continue; }
        if (entryStats.size > this.limits.maxFileBytes) { exclude('oversized'); continue; }
        const fileRealPath = await realpath(absolutePath).catch(() => '');
        if (excludedRealRoots.some((entry) => isInside(entry, fileRealPath))) { exclude('default_directory'); continue; }
        if (!fileRealPath || !isInside(rootRealPath, fileRealPath)) { exclude('unsafe_link'); continue; }
        discovered.push({ absolutePath, relativePath, ...fingerprint(entryStats) });
      }
    };
    await walk(rootRealPath);

    const ignored = await gitIgnoredPaths(rootRealPath, discovered.map((entry) => entry.relativePath));
    const candidates = new Map<string, PreviewCandidate>();
    let previewReadBytes = 0;
    for (const candidate of discovered) {
      if (ignored.has(candidate.relativePath)) { exclude('git_ignored'); continue; }
      if (
        candidates.size >= this.limits.maxPreviewFiles
        || previewReadBytes + candidate.size > this.limits.maxPreviewReadBytes
      ) {
        exclude('preview_limit');
        truncated = true;
        continue;
      }
      let text: SafeTextFile;
      try {
        text = await safeReadText(
          rootRealPath,
          candidate.absolutePath,
          Math.min(this.limits.maxFileBytes, this.limits.maxPreviewReadBytes - previewReadBytes),
        );
      } catch {
        exclude('binary_or_invalid_utf8');
        continue;
      }
      if (text.characters > this.knowledge.config.maxDocumentCharacters) {
        exclude('oversized');
        continue;
      }
      previewReadBytes += text.fingerprint.size;
      candidates.set(candidate.relativePath, {
        ...candidate,
        ...text.fingerprint,
        contentChecksum: text.contentChecksum,
      });
    }
    if (truncated) exclude('preview_limit', 0);

    const previewToken = randomUUID();
    const createdAt = this.clock();
    const projectName = safeProjectLabel(project.name);
    const stored: StoredPreview = {
      candidates,
      createdAt,
      expiresAt: createdAt + this.limits.previewTtlMs,
      projectId: project.id,
      rootRealPath,
      scopeKey: scopeKey(scope),
    };
    this.#previews.set(previewToken, stored);
    this.#enforcePreviewCapacity();
    return {
      previewToken,
      project: { id: project.id, name: projectName },
      expiresAt: new Date(stored.expiresAt).toISOString(),
      files: [...candidates.values()].map((entry) => ({
        path: entry.relativePath, sizeBytes: entry.size, status: 'eligible',
      })),
      excluded: [...excluded.entries()].map(([reason, count]) => ({ reason, count })),
      truncated,
      limits: {
        maxFileBytes: this.limits.maxFileBytes,
        maxSelectedFiles: this.limits.maxSelectedFiles,
        maxTotalBytes: this.limits.maxTotalBytes,
        maxTotalCharacters: this.limits.maxTotalCharacters,
      },
    };
  }

  async confirm(
    scope: KnowledgeScope,
    project: ProjectRecord,
    input: { paths: string[]; previewToken: string; projectId: string },
  ): Promise<RepositoryIndexResponse> {
    this.#prune();
    const preview = this.#previews.get(input.previewToken);
    this.#previews.delete(input.previewToken);
    if (!preview) {
      throw new RepositoryIndexError(409, 'preview_expired', 'The repository preview expired. Create a new preview.');
    }
    if (
      preview.scopeKey !== scopeKey(scope)
      || preview.projectId !== input.projectId
      || project.id !== input.projectId
    ) {
      throw new RepositoryIndexError(409, 'project_changed', 'The active project or private scope changed. Create a new preview.');
    }
    const currentRoot = await realpath(project.path).catch(() => '');
    if (!currentRoot || currentRoot !== preview.rootRealPath) {
      throw new RepositoryIndexError(409, 'project_changed', 'The active project changed. Create a new preview.');
    }
    if (input.paths.length < 1 || input.paths.length > this.limits.maxSelectedFiles) {
      throw new RepositoryIndexError(413, 'selection_too_large', 'Select fewer repository files.');
    }
    const uniquePaths = new Set(input.paths);
    if (uniquePaths.size !== input.paths.length) {
      throw new RepositoryIndexError(400, 'invalid_selection', 'Repository file selection is invalid.');
    }

    const selectedCandidates: PreviewCandidate[] = [];
    let selectedBytes = 0;
    for (const relativePath of input.paths) {
      const candidate = preview.candidates.get(relativePath);
      if (!candidate) {
        throw new RepositoryIndexError(400, 'invalid_selection', 'Only files from the current preview may be indexed.');
      }
      selectedBytes += candidate.size;
      if (selectedBytes > this.limits.maxTotalBytes) {
        throw new RepositoryIndexError(413, 'selection_too_large', 'The selected repository files exceed the indexing limit.');
      }
      selectedCandidates.push(candidate);
    }

    const validated: Array<{ candidate: PreviewCandidate; content: string }> = [];
    let totalCharacters = 0;
    for (const candidate of selectedCandidates) {
      const text = await safeReadText(preview.rootRealPath, candidate.absolutePath, this.limits.maxFileBytes);
      if (
        !sameFingerprint(candidate, text.fingerprint)
        || candidate.contentChecksum !== text.contentChecksum
      ) {
        throw new RepositoryIndexError(409, 'file_changed', 'A selected file changed after preview. Create a new preview.');
      }
      if (text.characters > this.knowledge.config.maxDocumentCharacters) {
        throw new RepositoryIndexError(413, 'selection_too_large', 'A selected repository file exceeds the indexing limit.');
      }
      totalCharacters += text.characters;
      if (totalCharacters > this.limits.maxTotalCharacters) {
        throw new RepositoryIndexError(413, 'selection_too_large', 'The selected repository files exceed the indexing limit.');
      }
      validated.push({ candidate, content: text.content });
    }

    const source = await this.knowledge.upsertSource(scope, {
      externalKey: `repository:${project.id}`,
      name: `Repository: ${safeProjectLabel(project.name)}`,
      sourceType: 'repository_file',
    });
    const projectName = safeProjectLabel(project.name);
    const files: RepositoryIndexResponse['files'] = [];
    for (const entry of validated) {
      const result = await this.knowledge.indexTextDocument(scope, {
        content: entry.content,
        sourceId: source.id,
        sourceDocumentId: entry.candidate.relativePath,
        title: boundedTitle(projectName, entry.candidate.relativePath),
      });
      files.push({
        path: entry.candidate.relativePath,
        documentId: result.document.id,
        chunkCount: result.chunkCount,
        status: result.skipped ? 'unchanged' : 'indexed',
      });
    }
    return {
      project: { id: project.id, name: projectName },
      files,
      indexed: files.filter((entry) => entry.status === 'indexed').length,
      unchanged: files.filter((entry) => entry.status === 'unchanged').length,
    };
  }

  #prune(): void {
    const now = this.clock();
    for (const [token, preview] of this.#previews) {
      if (preview.expiresAt <= now) this.#previews.delete(token);
    }
  }

  #enforcePreviewCapacity(): void {
    if (this.#previews.size <= this.limits.maxActivePreviews) return;
    const oldest = [...this.#previews.entries()]
      .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (oldest) this.#previews.delete(oldest[0]);
  }
}
