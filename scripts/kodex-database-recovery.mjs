import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createDatabaseRecoveryDrillPlan,
  DatabaseRecoveryError,
  databaseRecoveryPolicyValidationResult,
  databaseRecoveryReceiptValidationResult,
  databaseRecoveryStatusResult,
  readDatabaseRecoveryPolicy,
  readDatabaseRecoveryReceipt,
  validateDatabaseRecoveryReceipt,
} from './lib/database-recovery.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPolicyPath = path.join(repositoryRoot, 'config', 'database-recovery-policy.json');

function invalidArguments() {
  throw new DatabaseRecoveryError('invalid_arguments');
}

function parseFlags(values) {
  if (values.length % 2 !== 0) invalidArguments();
  const flags = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!/^--[a-z-]+$/u.test(name) || typeof value !== 'string' || !value || value.startsWith('--') || flags.has(name)) {
      invalidArguments();
    }
    flags.set(name, value);
  }
  return flags;
}

function exactFlags(flags, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((flag) => !flags.has(flag)) || [...flags.keys()].some((flag) => !allowed.has(flag))) {
    invalidArguments();
  }
}

function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) invalidArguments();
  return path.resolve(value);
}

export async function runDatabaseRecoveryCommand(values) {
  const [command, ...rest] = values;
  const flags = parseFlags(rest);
  if (command === 'validate' || command === 'drill-plan') {
    exactFlags(flags, [], ['--policy']);
    const policy = await readDatabaseRecoveryPolicy(flags.has('--policy')
      ? absolutePath(flags.get('--policy'))
      : defaultPolicyPath);
    return command === 'validate'
      ? databaseRecoveryPolicyValidationResult(policy)
      : createDatabaseRecoveryDrillPlan(policy);
  }
  if (command === 'receipt-validate' || command === 'status') {
    exactFlags(flags, ['--at', '--receipt'], ['--policy']);
    const policy = await readDatabaseRecoveryPolicy(flags.has('--policy')
      ? absolutePath(flags.get('--policy'))
      : defaultPolicyPath);
    const receipt = await readDatabaseRecoveryReceipt(absolutePath(flags.get('--receipt')));
    const validation = validateDatabaseRecoveryReceipt(policy, receipt, flags.get('--at'));
    return command === 'receipt-validate'
      ? databaseRecoveryReceiptValidationResult(policy, validation)
      : databaseRecoveryStatusResult(policy, validation);
  }
  invalidArguments();
}

export function databaseRecoveryErrorOutput(error) {
  const code = error instanceof DatabaseRecoveryError ? error.code : 'recovery_validation_failed';
  return { code, kind: 'kodex_database_recovery_error', ok: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await runDatabaseRecoveryCommand(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(databaseRecoveryErrorOutput(error))}\n`);
    process.exitCode = 1;
  }
}
