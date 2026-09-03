import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

async function runtimeDependencyClosure(seedNames) {
  const pending = [...seedNames];
  const packages = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || packages.has(name)) continue;
    const packageRoot = path.join(root, 'node_modules', ...name.split('/'));
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    } catch {
      throw new Error(`Required runtime dependency is missing: ${name}`);
    }
    packages.add(name);
    for (const dependency of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]) {
      if (!packages.has(dependency)) pending.push(dependency);
    }
  }
  return [...packages].sort();
}

async function walk(relative = '') {
  const output = [];
  for (const entry of await readdir(path.join(appRoot, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...await walk(child));
    else output.push(child);
  }
  return output;
}

if (process.platform !== 'win32') throw new Error('The Kodex runtime bundle script currently targets Windows only.');
await Promise.all([
  required('apps/api/dist/main.js'), required('apps/local-server/dist/main.js'),
  required('apps/ui/dist/index.html'), required('bin/codex.exe'),
  required('node_modules/electron/dist/electron.exe'),
  required('node_modules/argon2/prebuilds/win32-x64/argon2.glibc.node'),
]);

await rm(output, { recursive: true, force: true });
await mkdir(path.dirname(output), { recursive: true });
await cp(path.join(root, 'node_modules', 'electron', 'dist'), output, { recursive: true });
await cp(path.join(output, 'electron.exe'), path.join(output, 'Kodex.exe'));
await mkdir(appRoot, { recursive: true });

await Promise.all([
  copy('apps/desktop/main.mjs', 'desktop/main.mjs'),
  copy('apps/desktop/preload.cjs', 'desktop/preload.cjs'),
  copy('apps/desktop/runtime-processes.mjs', 'desktop/runtime-processes.mjs'),
  copy('apps/desktop/smoke-service.mjs', 'desktop/smoke-service.mjs'),
  copy('apps/desktop/verify-runtime.mjs', 'desktop/verify-runtime.mjs'),
  copy('apps/api/dist', 'product-api'),
  copy('apps/local-server/dist', 'server'),
  copy('apps/ui/dist', 'ui'),
  copy('packages/codex-protocol/dist', 'node_modules/@kodex/codex-protocol/dist'),
  copy('packages/kodex-api/dist', 'node_modules/@kodex/kodex-api/dist'),
  copy('packages/shared/dist', 'node_modules/@kodex/shared/dist'),
  copy('packages/product-contract/dist', 'node_modules/@kodex/product-contract/dist'),
  copy('packages/product-db/dist', 'node_modules/@kodex/product-db/dist'),
  copy('packages/product-db/migrations', 'node_modules/@kodex/product-db/migrations'),
  copy('bin/codex.exe', 'bin/codex.exe'),
  copy('bin/codex-build.json', 'bin/codex-build.json'),
  copy('packages/codex-protocol/codex-version.json', 'metadata/codex-version.json'),
  copy('CODEX_UPSTREAM_COMMIT', 'metadata/CODEX_UPSTREAM_COMMIT'),
  copy('VENDOR_SOURCE_SHA256.json', 'metadata/VENDOR_SOURCE_SHA256.json'),
  copy('THIRD_PARTY.md', 'licenses/THIRD_PARTY.md'),
  copy('vendor/openai-codex/LICENSE', 'licenses/openai-codex-LICENSE'),
  copy('vendor/openai-codex/NOTICE', 'licenses/openai-codex-NOTICE'),
]);

for (const dependency of await runtimeDependencyClosure(['argon2', 'dotenv', 'pg', 'ws'])) {
  await copy(path.join('node_modules', ...dependency.split('/')), path.join('node_modules', ...dependency.split('/')));
}

for (const name of ['codex-protocol', 'kodex-api', 'product-contract', 'product-db', 'shared']) {
  const packageName = name === 'codex-protocol' ? '@kodex/codex-protocol' : `@kodex/${name}`;
  await writeFile(path.join(appRoot, 'node_modules', '@kodex', name, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.2.0', type: 'module', main: 'dist/index.js', exports: './dist/index.js' }, null, 2)}\n`, 'utf8');
}
await writeFile(path.join(appRoot, 'package.json'), `${JSON.stringify({ name: 'kodex-runtime', version: '0.2.0', private: true, type: 'module', main: 'desktop/main.mjs' }, null, 2)}\n`, 'utf8');
await writeFile(path.join(output, 'Kodex.cmd'), '@echo off\r\n"%~dp0electron.exe" "%~dp0resources\\app" %*\r\n', 'utf8');

const bundledFiles = await walk();
for (const filename of bundledFiles) {
  const normalized = filename.replaceAll('\\', '/').toLowerCase();
  if (
    /(^|\/)\.env(?:\.|$)/u.test(normalized)
    || /(^|\/)kodex\.env$/u.test(normalized)
    || /(^|\/)instance\.lock$/u.test(normalized)
    || normalized.includes('/.kodex-data/')
    || normalized.includes('/tenants/users/')
  ) {
    throw new Error(`Forbidden local configuration or tenant data entered the runtime: ${filename}`);
  }
}
for (const relative of [
  'product-api/main.js',
  'node_modules/@kodex/product-contract/dist/index.js',
  'node_modules/@kodex/product-db/dist/index.js',
  'node_modules/@kodex/product-db/migrations/0001_initial_product_schema.sql',
  'node_modules/@kodex/product-db/migrations/0004_user_scoped_rag.sql',
  'node_modules/@kodex/product-db/migrations/0005_default_embedding_hnsw.sql',
  'node_modules/@kodex/product-db/migrations/0006_auth_lifecycle.sql',
  'node_modules/@kodex/product-db/migrations/0007_workspace_invitations.sql',
  'node_modules/@kodex/product-db/migrations/0008_workspace_management_pagination.sql',
  'node_modules/@kodex/product-db/migrations/0009_terminal_auth_invitation_retention.sql',
  'node_modules/argon2/prebuilds/win32-x64/argon2.glibc.node',
]) await required(path.relative(root, path.join(appRoot, relative)));

await import(pathToFileURL(path.join(appRoot, 'product-api', 'server.js')).href);
const migrationsModule = await import(pathToFileURL(path.join(appRoot, 'node_modules', '@kodex', 'product-db', 'dist', 'migrations.js')).href);
const migrations = await migrationsModule.loadMigrations();
if (migrations.length !== 9 || path.resolve(migrationsModule.defaultMigrationsDirectory) !== path.join(appRoot, 'node_modules', '@kodex', 'product-db', 'migrations')) {
  throw new Error('Bundled Product DB migrations did not resolve to the packaged migration directory.');
}
const verificationEnvironment = {
  ELECTRON_RUN_AS_NODE: '1',
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};
const runtimeVerification = spawnSync(
  path.join(output, 'electron.exe'),
  [path.join(appRoot, 'desktop', 'verify-runtime.mjs')],
  {
    cwd: appRoot,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(verificationEnvironment).filter(([, value]) => value !== undefined)),
    shell: false,
    windowsHide: true,
  },
);
if (runtimeVerification.status !== 0) {
  throw new Error('Bundled Electron could not import the Product API, Argon2 native runtime, or migrations.');
}
process.stdout.write(`Windows runtime bundle created at ${output}\nRun ${path.join(output, 'Kodex.exe')} or the Device Guard-compatible ${path.join(output, 'Kodex.cmd')}\n`);
