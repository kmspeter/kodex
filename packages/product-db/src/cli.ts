import { requireProductDatabaseFromEnv } from './database.js';

const database = requireProductDatabaseFromEnv();

try {
  const applied = await database.migrate();
  if (applied.length === 0) {
    console.log('Product database schema is already up to date.');
  } else {
    console.log(
      `Applied product database migrations: ${applied.map((migration) => migration.version).join(', ')}`,
    );
  }
} finally {
  await database.close();
}
