import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'runtime', 'Kodex-win32-x64');
const appRoot = path.join(output, 'resources', 'app');

async function required(relative) {
  const absolute = path.join(root, relative);
  try { await readFile(absolute); } catch { throw new Error(`Required runtime input is missing: ${relative}`); }
  return absolute;
}

async function copy(relative, destination = relative) {
  await cp(path.join(root, relative), path.join(appRoot, destination), { recursive: true });
}

if (process.platform !== 'win32') throw new Error('The Kodex runtime bundle script currently targets Windows only.');
await Promise.all([
  required('apps/local-server/dist/main.js'), required('apps/ui/dist/index.html'), required('bin/codex.exe'),
  required('node_modules/electron/dist/electron.exe'),
]);

await rm(output, { recursive: true, force: true });
await mkdir(path.dirname(output), { recursive: true });
await cp(path.join(root, 'node_modules', 'electron', 'dist'), output, { recursive: true });
await cp(path.join(output, 'electron.exe'), path.join(output, 'Kodex.exe'));
await mkdir(appRoot, { recursive: true });

await Promise.all([
  copy('apps/desktop/main.mjs', 'desktop/main.mjs'),
  copy('apps/desktop/preload.mjs', 'desktop/preload.mjs'),
  copy('apps/local-server/dist', 'server'),
  copy('apps/ui/dist', 'ui'),
  copy('packages/codex-protocol/dist', 'node_modules/@kodex/codex-protocol/dist'),
  copy('packages/kodex-api/dist', 'node_modules/@kodex/kodex-api/dist'),
  copy('packages/shared/dist', 'node_modules/@kodex/shared/dist'),
  copy('node_modules/ws', 'node_modules/ws'),
  copy('node_modules/dotenv', 'node_modules/dotenv'),
  copy('bin/codex.exe', 'bin/codex.exe'),
  copy('bin/codex-build.json', 'bin/codex-build.json'),
  copy('packages/codex-protocol/codex-version.json', 'metadata/codex-version.json'),
  copy('CODEX_UPSTREAM_COMMIT', 'metadata/CODEX_UPSTREAM_COMMIT'),
  copy('VENDOR_SOURCE_SHA256.json', 'metadata/VENDOR_SOURCE_SHA256.json'),
  copy('THIRD_PARTY.md', 'licenses/THIRD_PARTY.md'),
  copy('vendor/openai-codex/LICENSE', 'licenses/openai-codex-LICENSE'),
  copy('vendor/openai-codex/NOTICE', 'licenses/openai-codex-NOTICE'),
]);

for (const name of ['codex-protocol', 'kodex-api', 'shared']) {
  const packageName = name === 'codex-protocol' ? '@kodex/codex-protocol' : `@kodex/${name}`;
  await writeFile(path.join(appRoot, 'node_modules', '@kodex', name, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.2.0', type: 'module', main: 'dist/index.js', exports: './dist/index.js' }, null, 2)}\n`, 'utf8');
}
await writeFile(path.join(appRoot, 'package.json'), `${JSON.stringify({ name: 'kodex-runtime', version: '0.2.0', private: true, type: 'module', main: 'desktop/main.mjs' }, null, 2)}\n`, 'utf8');
await writeFile(path.join(output, 'Kodex.cmd'), '@echo off\r\n"%~dp0electron.exe" "%~dp0resources\\app" %*\r\n', 'utf8');
process.stdout.write(`Windows runtime bundle created at ${output}\nRun ${path.join(output, 'Kodex.exe')} or the Device Guard-compatible ${path.join(output, 'Kodex.cmd')}\n`);
