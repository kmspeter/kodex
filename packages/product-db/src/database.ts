import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import {
  productDatabaseConfigFromEnv,
  requireProductDatabaseConfig,
  type ProductDatabaseConfig,
} from './config.js';
import { migrateProductDatabase, verifyProductDatabaseMigrations, type AppliedMigration } from './migrations.js';

export interface ProductDatabaseOptions {
  onPoolError?: (error: Error) => void;
}

export class ProductDatabase {
  readonly pool: Pool;
  #closed = false;
  #lastPoolError: Error | undefined;

  constructor(config: ProductDatabaseConfig, options: ProductDatabaseOptions = {}) {
    this.pool = new Pool(config);
    this.pool.on('error', (error) => {
      this.#lastPoolError = error;
      options.onPoolError?.(error);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get lastPoolError(): Error | undefined {
    return this.#lastPoolError;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.#assertOpen();
    return this.pool.query<Row>(text, values);
  }

  async transaction<Result>(operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    this.#assertOpen();
    const client = await this.pool.connect();
    try {
      return await this.transactionWithClient(client, operation);
    } finally {
      client.release();
    }
  }

  async transactionWithClient<Result>(
    client: PoolClient,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    this.#assertOpen();
    let transactionStarted = false;

    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const result = await operation(client);
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the operation error when the connection is already unusable.
        }
      }
      throw error;
    }
  }

  async migrate(): Promise<AppliedMigration[]> {
    this.#assertOpen();
    return migrateProductDatabase(this.pool);
  }

  async verifyMigrations(): Promise<AppliedMigration[]> {
    this.#assertOpen();
    return verifyProductDatabaseMigrations(this.pool);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.pool.end();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Product database pool is closed');
    }
  }
}

export function createProductDatabase(
  config: ProductDatabaseConfig,
  options?: ProductDatabaseOptions,
): ProductDatabase {
  return new ProductDatabase(config, options);
}

export function createProductDatabaseFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductDatabase | undefined {
  const config = productDatabaseConfigFromEnv(env);
  return config ? createProductDatabase(config) : undefined;
}

export function requireProductDatabaseFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductDatabase {
  return createProductDatabase(requireProductDatabaseConfig(env));
}
