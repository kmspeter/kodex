import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('argon2');
await import(pathToFileURL(path.join(appRoot, 'product-api', 'server.js')).href);
const migrationsModule = await import(pathToFileURL(path.join(
  appRoot,
  'node_modules',
  '@kodex',
  'product-db',
  'dist',
  'migrations.js',
)).href);
const migrations = await migrationsModule.loadMigrations();
if (
  migrations.length !== 4
  || path.resolve(migrationsModule.defaultMigrationsDirectory)
    !== path.join(appRoot, 'node_modules', '@kodex', 'product-db', 'migrations')
) {
  throw new Error('Runtime migration directory verification failed.');
}
process.stdout.write('Runtime Product API, Argon2, and migrations verified.\n');
