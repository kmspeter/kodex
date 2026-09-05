import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createProcessLongRunAdapter,
  LongRunAcceptanceError,
  readLongRunConfig,
  readLongRunScenarioCatalog,
  runLongRunAcceptance,
  writeLongRunReceipt,
} from './lib/long-run-acceptance.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argumentsList = process.argv.slice(2);

function parseArguments(args) {
  if (!['start', 'resume'].includes(args[0])) throw new LongRunAcceptanceError('invalid_arguments');
  const output = { mode: args[0] };
  const accepted = new Set(['--config', '--state', '--receipt', '--result-dir', '--run-id']);
  for (let index = 1; index < args.length; index += 2) {
    if (!accepted.has(args[index]) || typeof args[index + 1] !== 'string' || args[index + 1].length < 1) {
      throw new LongRunAcceptanceError('invalid_arguments');
    }
    const key = args[index].slice(2).replace(/-([a-z])/gu, (_match, character) => character.toUpperCase());
    if (Object.hasOwn(output, key)) throw new LongRunAcceptanceError('invalid_arguments');
    output[key] = args[index + 1];
  }
  if (!output.config || !output.state || !output.receipt || (output.mode === 'resume' && output.runId)) {
    throw new LongRunAcceptanceError('invalid_arguments');
  }
  if (![output.config, output.state, output.receipt, output.resultDir]
    .filter((entry) => entry !== undefined)
    .every((entry) => path.isAbsolute(entry))) {
    throw new LongRunAcceptanceError('absolute_path_required');
  }
  return output;
}
const abortController = new AbortController();
const requestAbort = () => abortController.abort();
process.once('SIGINT', requestAbort);
process.once('SIGTERM', requestAbort);

try {
  const options = parseArguments(argumentsList);
  const catalog = await readLongRunScenarioCatalog(path.join(repositoryRoot, 'config', 'long-run-acceptance-scenarios.json'));
  const parsedConfig = await readLongRunConfig(options.config, catalog);
  const result = await runLongRunAcceptance({
    mode: options.mode,
    catalog,
    config: parsedConfig.config,
    statePath: options.state,
    receiptPath: options.receipt,
    runId: options.runId,
    signal: abortController.signal,
    adapter: createProcessLongRunAdapter(repositoryRoot, catalog, { resultDirectory: options.resultDir }),
  });
  await writeLongRunReceipt(options.receipt, result);
  const ok = result.receipt.resultCode === 'completed';
  const summary = {
    code: ok ? 'long_run_acceptance_completed' : `long_run_acceptance_${result.receipt.resultCode}`,
    formatVersion: 1,
    iterationCount: result.receipt.iterationsCompleted,
    kind: 'kodex_long_run_acceptance_result',
    ok,
    receiptDigest: result.receiptDigest,
    scenarioId: result.receipt.scenarioId,
    stepCount: result.receipt.stepsCompleted,
  };
  (ok ? process.stdout : process.stderr).write(`${JSON.stringify(summary)}\n`);
  if (!ok) process.exitCode = 1;
} catch (error) {
  const code = error instanceof LongRunAcceptanceError ? error.code : 'long_run_acceptance_failed';
  process.stderr.write(`${JSON.stringify({ code, formatVersion: 1, kind: 'kodex_long_run_acceptance_error', ok: false })}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', requestAbort);
  process.removeListener('SIGTERM', requestAbort);
}
