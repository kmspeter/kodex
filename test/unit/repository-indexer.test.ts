import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRecord } from '@kodex/kodex-api';
import {
  KnowledgeService,
  type KnowledgeScope,
  type PostgresKnowledgeRepository,
  type RagConfig,
  type StoredDocument,
} from '@kodex/product-db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryIndexer } from '../../apps/local-server/src/rag/repository-indexer';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const scopeA = {
  userId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000001',
};
const scopeB = {
  userId: '10000000-0000-4000-8000-000000000002',
  workspaceId: '20000000-0000-4000-8000-000000000001',
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function projectFixture(): Promise<{ project: ProjectRecord; root: string }> {
  const container = await mkdtemp(path.join(os.tmpdir(), 'kodex-repository-index-'));
  roots.push(container);
  const root = path.join(container, 'project');
  await mkdir(root);
  return {
    root,
    project: {
      id: '30000000-0000-4000-8000-000000000001',
      name: 'Private project',
      path: root,
      createdAt: 0,
      lastOpenedAt: 0,
    },
  };
}

function mockedKnowledge() {
  let sequence = 0;
  return {
    config: { maxDocumentCharacters: 60_000 },
    upsertSource: vi.fn(async () => ({
      id: '40000000-0000-4000-8000-000000000001', sourceType: 'repository_file',
      name: 'Repository', status: 'ready' as const, createdAt: new Date(0), updatedAt: new Date(0),
    })),
    indexTextDocument: vi.fn(async (_scope: KnowledgeScope, input: { sourceDocumentId?: string; title: string }) => ({
      document: {
        id: `50000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
        sourceId: '40000000-0000-4000-8000-000000000001',
        sourceDocumentId: input.sourceDocumentId!, sourceType: 'repository_file', title: input.title,
        contentChecksum: Buffer.alloc(32), indexConfigurationChecksum: Buffer.alloc(32),
        createdAt: new Date(0), updatedAt: new Date(0),
      },
      chunkCount: 1,
      skipped: false,
    })),
  } as unknown as KnowledgeService;
}

describe('consent-bound repository preview', () => {
  it('shows only bounded relative metadata and excludes git-ignored, secret, binary, oversized, and default-directory files', async () => {
    const { project, root } = await projectFixture();
    await execFileAsync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, 'safe.ts'), 'export const safe = true;\n');
    await writeFile(path.join(root, 'ignored.txt'), 'ignored by repository policy\n');
    await writeFile(path.join(root, '.env'), 'DO_NOT_EXPOSE=secret\n');
    await writeFile(path.join(root, 'private-key.pem'), 'secret\n');
    await mkdir(path.join(root, '.ssh'));
    await writeFile(path.join(root, '.ssh', 'config'), 'Host private\n  IdentityFile id_ed25519\n');
    await mkdir(path.join(root, 'secrets'));
    await writeFile(path.join(root, 'secrets', 'config.json'), '{"secret":true}\n');
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(257 * 1024));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules', 'package.js'), 'ignored\n');
    const tenantData = path.join(root, 'custom-tenant-state');
    await mkdir(tenantData);
    await writeFile(path.join(tenantData, 'private.json'), 'must not be indexed\n');

    const preview = await new RepositoryIndexer(mockedKnowledge(), Date.now, {}, [tenantData]).preview(scopeA, project);
    expect(preview.files.map((entry) => entry.path)).toContain('safe.ts');
    expect(preview.files.map((entry) => entry.path)).not.toEqual(expect.arrayContaining([
      'ignored.txt', '.env', 'private-key.pem', '.ssh/config', 'secrets/config.json', 'binary.bin', 'large.txt',
      'node_modules/package.js', 'custom-tenant-state/private.json',
    ]));
    expect(preview.files.every((entry) => !path.isAbsolute(entry.path))).toBe(true);
    expect(preview).not.toHaveProperty('content');
    expect(preview.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'git_ignored' }),
      expect.objectContaining({ reason: 'credential_or_secret' }),
      expect.objectContaining({ reason: 'binary_or_invalid_utf8' }),
      expect.objectContaining({ reason: 'oversized' }),
      expect.objectContaining({ reason: 'default_directory' }),
    ]));
  });

  it('does not follow junctions and rejects preview tampering, scope IDOR, project changes, and TOCTOU changes', async () => {
    const { project, root } = await projectFixture();
    await writeFile(path.join(root, 'safe.txt'), 'safe repository text\n');
    const outside = path.join(path.dirname(root), 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'outside.txt'), 'must never be read\n');
    await symlink(outside, path.join(root, 'escape'), 'junction');
    const knowledge = mockedKnowledge();
    const indexer = new RepositoryIndexer(knowledge);

    const linkedPreview = await indexer.preview(scopeA, project);
    expect(linkedPreview.files.some((entry) => entry.path.includes('outside.txt'))).toBe(false);
    expect(linkedPreview.excluded).toContainEqual(expect.objectContaining({ reason: 'unsafe_link' }));

    const tampered = await indexer.preview(scopeA, project);
    await expect(indexer.confirm(scopeA, project, {
      previewToken: tampered.previewToken, projectId: project.id, paths: ['../outside/outside.txt'],
    })).rejects.toMatchObject({ code: 'invalid_selection' });

    const foreign = await indexer.preview(scopeA, project);
    await expect(indexer.confirm(scopeB, project, {
      previewToken: foreign.previewToken, projectId: project.id, paths: ['safe.txt'],
    })).rejects.toMatchObject({ code: 'project_changed' });

    const changedProject = await indexer.preview(scopeA, project);
    await expect(indexer.confirm(scopeA, { ...project, id: '30000000-0000-4000-8000-000000000002' }, {
      previewToken: changedProject.previewToken,
      projectId: '30000000-0000-4000-8000-000000000002',
      paths: ['safe.txt'],
    })).rejects.toMatchObject({ code: 'project_changed' });

    const changedFile = await indexer.preview(scopeA, project);
    await writeFile(path.join(root, 'safe.txt'), 'changed after preview and longer\n');
    await expect(indexer.confirm(scopeA, project, {
      previewToken: changedFile.previewToken, projectId: project.id, paths: ['safe.txt'],
    })).rejects.toMatchObject({ code: 'file_changed' });
    expect(knowledge.indexTextDocument).not.toHaveBeenCalled();
  });

  it('expires one-time preview selections before any indexing work', async () => {
    const { project, root } = await projectFixture();
    await writeFile(path.join(root, 'safe.txt'), 'safe repository text\n');
    let now = Date.parse('2026-09-03T00:00:00.000Z');
    const knowledge = mockedKnowledge();
    const indexer = new RepositoryIndexer(knowledge, () => now, { previewTtlMs: 1_000 });
    const preview = await indexer.preview(scopeA, project);
    now += 1_001;
    await expect(indexer.confirm(scopeA, project, {
      previewToken: preview.previewToken, projectId: project.id, paths: ['safe.txt'],
    })).rejects.toMatchObject({ code: 'preview_expired' });
    expect(knowledge.indexTextDocument).not.toHaveBeenCalled();
  });

  it('fails closed for a broken git worktree marker and excludes unsafe display paths', async () => {
    const broken = await projectFixture();
    await mkdir(path.join(broken.root, '.git'));
    await writeFile(path.join(broken.root, 'safe.txt'), 'must not bypass broken git policy\n');
    await expect(new RepositoryIndexer(mockedKnowledge()).preview(scopeA, broken.project))
      .rejects.toMatchObject({ code: 'repository_preview_unavailable', status: 503 });

    const display = await projectFixture();
    await writeFile(path.join(display.root, 'safe.txt'), 'safe repository text\n');
    await writeFile(path.join(display.root, `spoof\u202Etxt.exe`), 'unsafe display path\n');
    await writeFile(path.join(display.root, `e\u0301.txt`), 'non-normalized path\n');
    const preview = await new RepositoryIndexer(mockedKnowledge()).preview(scopeA, {
      ...display.project,
      name: 'Spoof\u202E\nProject',
    });
    expect(preview.files.map((entry) => entry.path)).toEqual(['safe.txt']);
    expect(preview.project.name).toBe('SpoofProject');
    expect(preview.excluded).toContainEqual(expect.objectContaining({ reason: 'unsupported_file', count: 2 }));
  });

  it('enforces preview and confirm aggregate byte limits before indexing', async () => {
    const { project, root } = await projectFixture();
    await writeFile(path.join(root, 'a.txt'), 'alpha\n');
    await writeFile(path.join(root, 'b.txt'), 'bravo\n');
    const knowledge = mockedKnowledge();
    const indexer = new RepositoryIndexer(knowledge, Date.now, {
      maxPreviewReadBytes: 12,
      maxTotalBytes: 10,
    });
    const preview = await indexer.preview(scopeA, project);
    expect(preview.files.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
    await expect(indexer.confirm(scopeA, project, {
      previewToken: preview.previewToken,
      projectId: project.id,
      paths: ['a.txt', 'b.txt'],
    })).rejects.toMatchObject({ code: 'selection_too_large', status: 413 });
    expect(knowledge.upsertSource).not.toHaveBeenCalled();
    expect(knowledge.indexTextDocument).not.toHaveBeenCalled();
  });
});

class MemoryKnowledgeRepository {
  readonly source = {
    id: '40000000-0000-4000-8000-000000000001', sourceType: 'repository_file',
    name: 'Repository', status: 'ready' as const, createdAt: new Date(0), updatedAt: new Date(0),
  };
  readonly documents = new Map<string, StoredDocument>();
  readonly chunks = new Map<string, number>();

  async upsertSource() { return this.source; }
  async getSource(_scope: KnowledgeScope, sourceId: string) { return sourceId === this.source.id ? this.source : undefined; }
  async getDocumentBySourceIdentity(_scope: KnowledgeScope, sourceId: string, sourceDocumentId: string) {
    return [...this.documents.values()].find((entry) => entry.sourceId === sourceId && entry.sourceDocumentId === sourceDocumentId);
  }
  async getDocumentBySourceIdentityWithClient(_client: unknown, scope: KnowledgeScope, sourceId: string, sourceDocumentId: string) {
    return this.getDocumentBySourceIdentity(scope, sourceId, sourceDocumentId);
  }
  async getDocument(_scope: KnowledgeScope, documentId: string) { return this.documents.get(documentId); }
  async getDocumentWithClient(_client: unknown, _scope: KnowledgeScope, documentId: string) { return this.documents.get(documentId); }
  async documentIdExists(documentId: string) { return this.documents.has(documentId); }
  async withDocumentLock<T>(_scope: KnowledgeScope, _identity: string, operation: (client: never) => Promise<T>) { return operation({} as never); }
  async countChunksWithClient(_client: unknown, _scope: KnowledgeScope, documentId: string) { return this.chunks.get(documentId) ?? 0; }
  async updateDocumentTitle(_client: unknown, _scope: KnowledgeScope, documentId: string, title: string) {
    const current = this.documents.get(documentId)!;
    const updated = { ...current, title, updatedAt: new Date() };
    this.documents.set(documentId, updated);
    return updated;
  }
  async replaceDocument(
    _client: unknown,
    _scope: KnowledgeScope,
    input: {
      contentChecksum: Buffer; documentId: string; indexConfigurationChecksum: Buffer;
      sourceDocumentId: string; sourceId: string; title: string;
    },
    chunks: readonly unknown[],
  ) {
    const before = this.documents.get(input.documentId);
    const document: StoredDocument = {
      id: input.documentId, sourceId: input.sourceId, sourceDocumentId: input.sourceDocumentId,
      sourceType: 'repository_file', title: input.title, contentChecksum: input.contentChecksum,
      indexConfigurationChecksum: input.indexConfigurationChecksum,
      createdAt: before?.createdAt ?? new Date(), updatedAt: new Date(),
    };
    this.documents.set(document.id, document);
    this.chunks.set(document.id, chunks.length);
    return document;
  }
  async deleteDocument(_client: unknown, _scope: KnowledgeScope, documentId: string) {
    this.chunks.delete(documentId);
    return this.documents.delete(documentId);
  }
}

describe('repository KnowledgeService identity lifecycle', () => {
  it('uses stable project-relative identity for checksum skip, changed reindex, and explicit delete', async () => {
    const { project, root } = await projectFixture();
    const filename = path.join(root, 'src.txt');
    await writeFile(filename, 'first repository content\n');
    const repository = new MemoryKnowledgeRepository();
    const embed = vi.fn(async (inputs: readonly string[]) => inputs.map(() => [1, 0]));
    const config: RagConfig = {
      enabled: true, automationsEnabled: false,
      chunking: { chunkCharacters: 64, overlapCharacters: 8 },
      contextMaxCharacters: 1_000, defaultThreshold: 0.25, defaultTopK: 5,
      maxTopK: 10, maxDocumentCharacters: 60_000, maxQueryCharacters: 1_000,
    };
    const service = new KnowledgeService(repository as unknown as PostgresKnowledgeRepository, {
      dimensions: 2, model: 'test-embedding', embed,
    }, config);
    const indexer = new RepositoryIndexer(service);

    const firstPreview = await indexer.preview(scopeA, project);
    const first = await indexer.confirm(scopeA, project, {
      previewToken: firstPreview.previewToken, projectId: project.id, paths: ['src.txt'],
    });
    expect(first.files[0]?.status).toBe('indexed');
    const documentId = first.files[0]!.documentId;
    expect(embed).toHaveBeenCalledTimes(1);

    const unchangedPreview = await indexer.preview(scopeA, project);
    const unchanged = await indexer.confirm(scopeA, project, {
      previewToken: unchangedPreview.previewToken, projectId: project.id, paths: ['src.txt'],
    });
    expect(unchanged.files[0]).toMatchObject({ documentId, status: 'unchanged' });
    expect(embed).toHaveBeenCalledTimes(1);

    await writeFile(filename, 'second repository content with a checksum change\n');
    const changedPreview = await indexer.preview(scopeA, project);
    const changed = await indexer.confirm(scopeA, project, {
      previewToken: changedPreview.previewToken, projectId: project.id, paths: ['src.txt'],
    });
    expect(changed.files[0]).toMatchObject({ documentId, status: 'indexed' });
    expect(embed).toHaveBeenCalledTimes(2);

    await service.deleteDocument(scopeA, documentId);
    expect(repository.documents.has(documentId)).toBe(false);
    expect(repository.chunks.has(documentId)).toBe(false);
  });
});
