import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  scanReleaseInputSecrets,
  scanTrackedSecrets,
  verifyDeploymentContracts,
  verifyRepositoryProvenance,
} from './lib/security-validation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--release-input' || !args[1])) {
  throw new Error('Usage: security-validate [--release-input <directory>]');
}

const provenance = await verifyRepositoryProvenance(repositoryRoot, { requireBinary: false });
const secrets = await scanTrackedSecrets(repositoryRoot);
const deployment = await verifyDeploymentContracts(repositoryRoot);
let releaseInput;
if (args.length === 2) releaseInput = await scanReleaseInputSecrets(path.resolve(args[1]));

process.stdout.write(`${JSON.stringify({
  kind: 'kodex_security_validation_passed',
  binaryPresent: provenance.binaryPresent,
  dependencyCount: provenance.dependencyCount,
  deploymentContractCount: deployment.contractCount,
  releaseInputFileCount: releaseInput?.fileCount ?? 0,
  scannedTrackedFileCount: secrets.fileCount,
  vendorFileCount: provenance.vendorFileCount,
  workspaceCount: provenance.workspaceCount,
})}\n`);
