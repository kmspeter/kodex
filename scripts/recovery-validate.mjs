import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DatabaseRecoveryError,
  verifyDatabaseRecoveryRepositoryContracts,
} from './lib/database-recovery.mjs';

if (process.argv.length !== 2) {
  process.stderr.write(`${JSON.stringify({ code: 'invalid_arguments', kind: 'kodex_database_recovery_error', ok: false })}\n`);
  process.exitCode = 1;
} else {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const result = await verifyDatabaseRecoveryRepositoryContracts(repositoryRoot);
    process.stdout.write(`${JSON.stringify({
      code: 'recovery_contracts_valid',
      documentContractCount: result.documentContractCount,
      formatVersion: result.policyFormatVersion,
      kind: 'kodex_database_recovery_repository_validation',
      ok: true,
      policyDigest: result.policyDigest,
    })}\n`);
  } catch (error) {
    const code = error instanceof DatabaseRecoveryError ? error.code : 'recovery_validation_failed';
    process.stderr.write(`${JSON.stringify({ code, kind: 'kodex_database_recovery_error', ok: false })}\n`);
    process.exitCode = 1;
  }
}
