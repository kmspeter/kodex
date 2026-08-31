import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Argon2idPasswordHasher,
  AuthService,
  PostgresAuthRepository,
  PostgresHistoryRepository,
  ProductDatabaseConfigurationError,
  requireProductDatabaseFromEnv,
} from '@kodex/product-db';
import dotenv from 'dotenv';
import {
  ProductApiConfigurationError,
  productApiConfigFromEnv,
} from './config.js';
import { ProductApiServer } from './server.js';

const repositoryRoot = process.env.KODEX_RUNTIME_ROOT
  ? path.resolve(process.env.KODEX_RUNTIME_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
if (process.env.KODEX_DISABLE_ENV_FILE !== '1') {
  dotenv.config({ path: path.join(repositoryRoot, '.env.local'), quiet: true });
}

let database: ReturnType<typeof requireProductDatabaseFromEnv> | undefined;
let server: ProductApiServer | undefined;
let stopping = false;

async function stop(exitCode = 0): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await server?.close().catch(() => undefined);
  await database?.close().catch(() => undefined);
  process.exitCode = exitCode;
}

try {
  const config = productApiConfigFromEnv();
  database = requireProductDatabaseFromEnv();
  await database.migrate();
  const repository = new PostgresAuthRepository(database);
  const auth = await AuthService.create(repository, new Argon2idPasswordHasher(), {
    sessionTtlMs: config.sessionTtlMs,
  });
  server = new ProductApiServer(auth, config, new PostgresHistoryRepository(database));
  const port = await server.listen();
  process.stdout.write(`Kodex Product API: http://${config.host}:${port}\n`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void stop());
  }
  process.once('uncaughtException', () => {
    process.stderr.write('Kodex Product API stopped after an uncaught internal error.\n');
    void stop(1);
  });
  process.once('unhandledRejection', () => {
    process.stderr.write('Kodex Product API stopped after an unhandled internal error.\n');
    void stop(1);
  });
} catch (error) {
  if (
    error instanceof ProductApiConfigurationError
    || error instanceof ProductDatabaseConfigurationError
  ) {
    process.stderr.write(`Kodex Product API configuration error: ${error.message}\n`);
  } else {
    process.stderr.write('Kodex Product API failed to start.\n');
  }
  await stop(1);
}
