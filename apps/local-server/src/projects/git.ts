import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { GitFileStatus, GitStatus } from '@kodex/kodex-api';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

function normalizeGitPath(value: string): string {
  const renamed = value.includes(' -> ') ? value.split(' -> ').at(-1)! : value;
  return renamed.replace(/^"|"$/gu, '').replaceAll('\\', '/');
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  try {
    const [branch, porcelain, numstat] = await Promise.all([
      git(cwd, ['branch', '--show-current']),
      git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
      git(cwd, ['diff', '--numstat', 'HEAD']),
    ]);
    const stats = new Map<string, { added: number; removed: number }>();
    for (const line of numstat.split(/\r?\n/u)) {
      if (!line) continue;
      const [added, removed, ...fileParts] = line.split('\t');
      const file = normalizeGitPath(fileParts.join('\t'));
      stats.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
    }
    const files: GitFileStatus[] = porcelain.split(/\r?\n/u).filter(Boolean).map((line) => {
      const file = normalizeGitPath(line.slice(3));
      const count = stats.get(file) ?? { added: 0, removed: 0 };
      return { path: file, staged: line[0] !== ' ' && line[0] !== '?', unstaged: line[1] !== ' ' || line.startsWith('??'), ...count };
    });
    return {
      isRepository: true,
      branch: branch.trim(),
      files,
      totals: files.reduce((totals, file) => ({ files: totals.files + 1, added: totals.added + file.added, removed: totals.removed + file.removed }), { files: 0, added: 0, removed: 0 }),
    };
  } catch {
    return { isRepository: false, branch: '', files: [], totals: { files: 0, added: 0, removed: 0 } };
  }
}

export async function getGitDiff(cwd: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Git diff path must be relative.');
  const resolved = path.resolve(cwd, relativePath);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Git diff path must stay inside the project.');
  const [unstaged, staged] = await Promise.all([
    git(cwd, ['diff', '--', relativePath]).catch(() => ''),
    git(cwd, ['diff', '--cached', '--', relativePath]).catch(() => ''),
  ]);
  return [staged, unstaged].filter(Boolean).join('\n');
}
