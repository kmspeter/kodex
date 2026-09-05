import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.join(repositoryRoot, 'apps', 'ui');
const distRoot = path.join(uiRoot, 'dist');
const uiPackage = JSON.parse(await readFile(path.join(uiRoot, 'package.json'), 'utf8'));
const contractPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'packages', 'product-contract', 'package.json'), 'utf8'));

if (uiPackage.dependencies?.['@kodex/product-db']) {
  throw new Error('UI package must not depend on @kodex/product-db.');
}
for (const dependency of Object.keys(contractPackage.dependencies ?? {})) {
  if (['argon2', 'pg', '@kodex/product-db'].includes(dependency)) {
    throw new Error(`Browser-safe product contract unexpectedly depends on ${dependency}.`);
  }
}

async function files(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await files(filename));
    else if (/\.(?:html|js)$/u.test(entry.name)) output.push(filename);
  }
  return output;
}

const source = (await Promise.all((await files(distRoot)).map((filename) => readFile(filename, 'utf8')))).join('\n');
for (const forbidden of [
  'AUTH_COOKIE_SECRET',
  'AUTH_EMAIL_DELIVERY_BEARER_TOKEN',
  'AUTH_PASSWORD_RESET_DELIVERY_BEARER_TOKEN',
  'DATABASE_URL',
  'PRODUCT_DB_PASSWORD',
  'kodex_product_session',
  'node-postgres',
  'postgresql://',
  'argon2id',
]) {
  if (source.toLocaleLowerCase().includes(forbidden.toLocaleLowerCase())) {
    throw new Error(`UI bundle contains forbidden server marker: ${forbidden}`);
  }
}
for (const required of ['X-Kodex-Workspace-Id', 'workspace_id']) {
  if (!source.includes(required)) throw new Error(`UI bundle is missing tenant scope marker: ${required}`);
}
if (!source.includes('kodex-product-api-origin')) {
  throw new Error('UI bundle is missing the runtime Product API origin marker.');
}

process.stdout.write('Verified browser bundle excludes product DB, password hashing, cookie bearer, and server secrets and requires runtime Product API configuration.\n');
