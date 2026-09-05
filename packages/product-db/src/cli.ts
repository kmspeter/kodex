import { migrateProductDatabaseForDeployment } from './privileges.js';

await migrateProductDatabaseForDeployment();
process.stdout.write('Product database migration contract completed.\n');
