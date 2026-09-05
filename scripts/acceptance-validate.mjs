import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ReleaseAcceptanceError,
  verifyAcceptanceRepositoryContracts,
} from './lib/release-acceptance.mjs';

if (process.argv.length !== 2) {
  process.stderr.write(`${JSON.stringify({ code: 'invalid_arguments', formatVersion: 1, kind: 'kodex_acceptance_repository_error', ok: false })}\n`);
  process.exitCode = 1;
} else {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const result = await verifyAcceptanceRepositoryContracts(repositoryRoot);
    process.stdout.write(`${JSON.stringify({
      catalogDigest: result.catalogDigest,
      code: 'acceptance_contracts_valid',
      commandCount: result.commandCount,
      documentContractCount: result.documentContractCount,
      formatVersion: result.formatVersion,
      kind: 'kodex_acceptance_repository_validation',
      longRunScenarioCount: result.longRunScenarioCount,
      ok: true,
      requirementCount: result.requirementCount,
      schemaContractCount: result.schemaContractCount,
    })}\n`);
  } catch (error) {
    const code = error instanceof ReleaseAcceptanceError ? error.code : 'acceptance_validation_failed';
    process.stderr.write(`${JSON.stringify({ code, formatVersion: 1, kind: 'kodex_acceptance_repository_error', ok: false })}\n`);
    process.exitCode = 1;
  }
}
