import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  releaseReadinessFromRepository,
  ReleaseAcceptanceError,
} from './lib/release-acceptance.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATH_FLAGS = new Set([
  '--evidence-dir', '--trust-store', '--release-artifact', '--install-root', '--recovery-receipt', '--soak-receipt',
]);

function parseArguments(values) {
  if (values[0] !== 'status') throw new ReleaseAcceptanceError('invalid_arguments');
  const output = {};
  const accepted = new Set([...PATH_FLAGS, '--at']);
  for (let index = 1; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!accepted.has(flag) || typeof value !== 'string' || value.length < 1 || Object.hasOwn(output, flag)) {
      throw new ReleaseAcceptanceError('invalid_arguments');
    }
    if (PATH_FLAGS.has(flag) && !path.isAbsolute(value)) throw new ReleaseAcceptanceError('absolute_path_required');
    output[flag] = PATH_FLAGS.has(flag) ? path.resolve(value) : value;
  }
  return output;
}
try {
  const flags = parseArguments(process.argv.slice(2));
  const result = await releaseReadinessFromRepository({
    repositoryRoot,
    evidenceDirectory: flags['--evidence-dir'],
    trustStorePath: flags['--trust-store'],
    releaseArtifactPath: flags['--release-artifact'],
    installRoot: flags['--install-root'],
    recoveryReceiptPath: flags['--recovery-receipt'],
    soakReceiptPath: flags['--soak-receipt'],
    evaluatedAt: flags['--at'],
  });
  (result.ok ? process.stdout : process.stderr).write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const code = error instanceof ReleaseAcceptanceError ? error.code : 'release_readiness_failed';
  process.stderr.write(`${JSON.stringify({ code, formatVersion: 1, kind: 'kodex_release_readiness_error', ok: false })}\n`);
  process.exitCode = 1;
}
