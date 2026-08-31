import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const generated = path.join(repositoryRoot, 'packages', 'codex-protocol', 'src', 'generated');
const schema = path.join(repositoryRoot, 'packages', 'codex-protocol', 'schema');
const commit = readFileSync(path.join(repositoryRoot, 'CODEX_UPSTREAM_COMMIT'), 'utf8').trim();

function run(args) {
  const result = spawnSync(binary, args, { cwd: repositoryRoot, encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `codex ${args.join(' ')} failed`);
  }
  return (result.stdout || result.stderr).trim();
}

try {
  const cliReportedVersion = run(['--version']);
  rmSync(generated, { recursive: true, force: true });
  rmSync(schema, { recursive: true, force: true });
  run(['app-server', 'generate-ts', '--out', generated]);
  run(['app-server', 'generate-json-schema', '--out', schema]);
  writeFileSync(path.join(repositoryRoot, 'packages', 'codex-protocol', 'codex-version.json'), `${JSON.stringify({
    sourceIdentity: `Codex source build ${commit.slice(0, 12)}`,
    cliReportedVersion,
    codexCommit: commit,
    generatedAt: new Date().toISOString(),
    generatedWith: 'bin/codex',
  }, null, 2)}\n`, 'utf8');
  process.stdout.write(`Generated Codex protocol from source commit ${commit} (CLI reports: ${cliReportedVersion}).\n`);
} catch (error) {
  process.stderr.write(`Protocol generation failed: ${error.message}\nRun npm run codex:build first.\n`);
  process.exitCode = 1;
}
