import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

export const LONG_RUN_FORMAT_VERSION = 1;
export const LONG_RUN_SCENARIO_FORMAT = 'kodex-long-run-acceptance-scenarios';
export const LONG_RUN_CONFIG_FORMAT = 'kodex-long-run-acceptance-config';
export const LONG_RUN_STATE_FORMAT = 'kodex-long-run-acceptance-state';
export const LONG_RUN_RECEIPT_FORMAT = 'kodex-long-run-acceptance-receipt';
export const LONG_RUN_ADAPTER_RESULT_FORMAT = 'kodex-long-run-adapter-result';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ADAPTER_RESULT_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z][a-z0-9.-]{0,95}$/u;
const STABLE_CODE = /^[a-z][a-z0-9_]{0,95}$/u;
const SCENARIO_ID = /^[a-z][a-z0-9-]{0,63}$/u;
export const LONG_RUN_RESOURCE_NAMES = Object.freeze([
  'heapBytes',
  'handleCount',
  'socketCount',
  'databasePoolCount',
  'outboxItemCount',
  'leaseCount',
  'temporaryBytes',
  'diskBytes',
]);
const RESOURCE_NAMES = LONG_RUN_RESOURCE_NAMES;

const RECOVERY_KINDS = Object.freeze(['none', 'reconnect', 'restart']);

export const LONG_RUN_COMMAND_ALLOWLIST = Object.freeze({
  'acceptance.backup-recovery': { kind: 'workload', npmScript: 'test:backup-encryption', recoveryEvidence: 'none' },
  'acceptance.browserless-product-local': { kind: 'workload', npmScript: 'test:full-stack', recoveryEvidence: 'none' },
  'acceptance.electron-lifecycle': { kind: 'workload', npmScript: 'test:desktop-workspace-lifecycle', recoveryEvidence: 'none' },
  'acceptance.email-auth-recovery': { kind: 'workload', npmScript: 'test:email-verification-postgres', recoveryEvidence: 'none' },
  'acceptance.history-reconciliation-rag': { kind: 'workload', npmScript: 'test:history-postgres', recoveryEvidence: 'none' },
  'acceptance.invitation-password-reset': { kind: 'workload', npmScript: 'test:password-reset-postgres', recoveryEvidence: 'none' },
  'acceptance.lifecycle-runtime-isolation': { kind: 'workload', npmScript: 'test:data-lifecycle-postgres', recoveryEvidence: 'none' },
  'acceptance.release-installer-update': { kind: 'workload', npmScript: 'test:release-deployment', recoveryEvidence: 'none' },
  'acceptance.security-recovery-contracts': { kind: 'workload', npmScript: 'security:validate', recoveryEvidence: 'none' },
  'chaos.postgres-session-recovery': { kind: 'chaos', npmScript: 'test:history-postgres', recoveryEvidence: 'restart' },
  'chaos.runtime-restart-recovery': { kind: 'chaos', npmScript: 'test:desktop-full-stack', recoveryEvidence: 'restart' },
  'chaos.update-restart-recovery': { kind: 'chaos', npmScript: 'test:installer', recoveryEvidence: 'restart' },
  'chaos.websocket-reconnect': { kind: 'chaos', npmScript: 'test:full-stack', recoveryEvidence: 'reconnect' },
});

const RESULT_CODES = new Set([
  'completed',
  'aborted',
  'deadline_exceeded',
  'iteration_limit_reached',
  'retry_exhausted',
  'terminal_step_failure',
  'resource_threshold_exceeded',
  'unordered_result',
  'cleanup_failed',
]);

export class LongRunAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LongRunAcceptanceError';
    this.code = code;
  }
}

export class LongRunSimulatedCrash extends Error {
  constructor() {
    super('simulated_crash');
    this.name = 'LongRunSimulatedCrash';
  }
}

function fail(code) {
  throw new LongRunAcceptanceError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function canonicalLongRunJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function digest(value) {
  return createHash('sha256').update(canonicalLongRunJson(value)).digest('hex');
}

function safeAbsoluteFile(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(code);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || path.basename(resolved).length < 1) fail(code);
  return resolved;
}

async function readBoundedCanonicalJson(filename, code) {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch {
    fail(code);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) fail(code);
  let bytes;
  let value;
  try {
    bytes = await readFile(filename);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(code);
  }
  if (!bytes.equals(Buffer.from(canonicalLongRunJson(value), 'utf8'))) fail(code);
  return value;
}

async function atomicWriteJson(filename, value) {
  const target = safeAbsoluteFile(filename, 'checkpoint_path_invalid');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail('checkpoint_path_invalid');
  } catch (error) {
    if (error instanceof LongRunAcceptanceError || error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(canonicalLongRunJson(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    try {
      const directory = await open(path.dirname(target), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (!['EINVAL', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function parseLongRunScenarioCatalog(value, options = {}) {
  if (
    !exactKeys(value, ['commands', 'format', 'formatVersion', 'scenarios'])
    || value.format !== LONG_RUN_SCENARIO_FORMAT
    || value.formatVersion !== LONG_RUN_FORMAT_VERSION
    || !Array.isArray(value.commands)
    || value.commands.length < 1
    || value.commands.length > 64
    || !Array.isArray(value.scenarios)
    || value.scenarios.length < 1
    || value.scenarios.length > 16
  ) fail('scenario_contract_invalid');
  const allowlist = options.commandAllowlist ?? LONG_RUN_COMMAND_ALLOWLIST;
  const commands = new Map();
  let previousCommand = '';
  for (const command of value.commands) {
    if (
      !exactKeys(command, ['id', 'kind', 'npmScript', 'recoveryEvidence'])
      || !IDENTIFIER.test(command.id)
      || command.id <= previousCommand
      || !['workload', 'chaos'].includes(command.kind)
      || !RECOVERY_KINDS.includes(command.recoveryEvidence)
      || (command.kind === 'workload' && command.recoveryEvidence !== 'none')
      || (command.kind === 'chaos' && command.recoveryEvidence === 'none')
      || typeof command.npmScript !== 'string'
      || !/^[a-z][a-z0-9:-]{0,95}$/u.test(command.npmScript)
    ) fail('scenario_contract_invalid');
    const allowed = allowlist[command.id];
    if (
      !allowed
      || allowed.kind !== command.kind
      || allowed.npmScript !== command.npmScript
      || allowed.recoveryEvidence !== command.recoveryEvidence
    ) {
      fail(command.kind === 'chaos' ? 'chaos_action_forbidden' : 'command_not_allowlisted');
    }
    if (
      command.kind === 'chaos'
      && /(?:delete|destroy|drop|daemon|volume|auto-approve|bypass)/u.test(command.id)
    ) fail('chaos_action_forbidden');
    commands.set(command.id, command);
    previousCommand = command.id;
  }
  const scenarios = new Map();
  let previousScenario = '';
  for (const scenario of value.scenarios) {
    if (
      !exactKeys(scenario, ['id', 'maximumDurationSeconds', 'minimumDurationSeconds', 'steps'])
      || !SCENARIO_ID.test(scenario.id)
      || scenario.id <= previousScenario
      || !boundedInteger(scenario.minimumDurationSeconds, 1, 259_200)
      || !boundedInteger(scenario.maximumDurationSeconds, scenario.minimumDurationSeconds, 259_200)
      || !Array.isArray(scenario.steps)
      || scenario.steps.length < 1
      || scenario.steps.length > 64
      || scenario.steps.some((step) => typeof step !== 'string' || !commands.has(step))
    ) fail('scenario_contract_invalid');
    scenarios.set(scenario.id, scenario);
    previousScenario = scenario.id;
  }
  return { catalog: value, catalogDigest: digest(value), commands, scenarios };
}

export async function readLongRunScenarioCatalog(filename) {
  return parseLongRunScenarioCatalog(await readBoundedCanonicalJson(
    safeAbsoluteFile(filename, 'scenario_input_invalid'),
    'scenario_input_invalid',
  ));
}

function parseThreshold(value) {
  return exactKeys(value, ['maximum', 'maximumGrowth'])
    && boundedInteger(value.maximum, 0, 1_125_899_906_842_624)
    && boundedInteger(value.maximumGrowth, 0, 1_125_899_906_842_624);
}

export function parseLongRunConfig(value, parsedCatalog) {
  if (
    !exactKeys(value, [
      'durationSeconds', 'format', 'formatVersion', 'iterationLimit', 'lease', 'retry',
      'scenarioId', 'stepTimeoutSeconds', 'thresholds',
    ])
    || value.format !== LONG_RUN_CONFIG_FORMAT
    || value.formatVersion !== LONG_RUN_FORMAT_VERSION
    || !SCENARIO_ID.test(value.scenarioId)
    || !isRecord(parsedCatalog)
    || !(parsedCatalog.scenarios instanceof Map)
  ) fail('config_contract_invalid');
  const scenario = parsedCatalog.scenarios.get(value.scenarioId);
  if (
    !scenario
    || !boundedInteger(value.durationSeconds, scenario.minimumDurationSeconds, scenario.maximumDurationSeconds)
    || !boundedInteger(value.iterationLimit, 1, 1_000_000)
    || !boundedInteger(value.stepTimeoutSeconds, 1, 21_600)
    || !exactKeys(value.lease, ['durationSeconds', 'heartbeatSeconds'])
    || !boundedInteger(value.lease.durationSeconds, 10, 3_600)
    || !boundedInteger(value.lease.heartbeatSeconds, 1, 600)
    || value.lease.heartbeatSeconds * 2 >= value.lease.durationSeconds
    || !exactKeys(value.retry, ['initialBackoffMilliseconds', 'maximumAttempts', 'maximumBackoffMilliseconds'])
    || !boundedInteger(value.retry.maximumAttempts, 1, 10)
    || !boundedInteger(value.retry.initialBackoffMilliseconds, 1, 60_000)
    || !boundedInteger(value.retry.maximumBackoffMilliseconds, value.retry.initialBackoffMilliseconds, 300_000)
    || !exactKeys(value.thresholds, RESOURCE_NAMES)
    || RESOURCE_NAMES.some((name) => !parseThreshold(value.thresholds[name]))
  ) fail('config_contract_invalid');
  const plan = {
    catalogDigest: parsedCatalog.catalogDigest,
    config: value,
    scenario: {
      id: scenario.id,
      steps: scenario.steps.map((id) => ({ ...parsedCatalog.commands.get(id) })),
    },
  };
  return { config: value, planDigest: digest(plan), scenario };
}

export async function readLongRunConfig(filename, parsedCatalog) {
  return parseLongRunConfig(await readBoundedCanonicalJson(
    safeAbsoluteFile(filename, 'config_input_invalid'),
    'config_input_invalid',
  ), parsedCatalog);
}

function parseMetricAggregate(value) {
  if (
    !exactKeys(value, ['baseline', 'last', 'observedSampleCount', 'peak'])
    || !boundedInteger(value.observedSampleCount, 0, Number.MAX_SAFE_INTEGER)
  ) return false;
  if (value.observedSampleCount === 0) {
    return value.baseline === null && value.last === null && value.peak === null;
  }
  return boundedInteger(value.baseline, 0, Number.MAX_SAFE_INTEGER)
    && boundedInteger(value.last, 0, Number.MAX_SAFE_INTEGER)
    && boundedInteger(value.peak, value.baseline, Number.MAX_SAFE_INTEGER)
    && value.peak >= value.last;
}

function parseAggregateMetrics(value) {
  return exactKeys(value, [
    'fixtureSampleCount', 'operationalSampleCount', 'processSampleCount', 'sampleCount', ...RESOURCE_NAMES,
  ])
    && boundedInteger(value.sampleCount, 0, Number.MAX_SAFE_INTEGER)
    && boundedInteger(value.fixtureSampleCount, 0, value.sampleCount)
    && boundedInteger(value.operationalSampleCount, 0, value.sampleCount)
    && boundedInteger(value.processSampleCount, 0, value.sampleCount)
    && value.fixtureSampleCount + value.operationalSampleCount + value.processSampleCount === value.sampleCount
    && RESOURCE_NAMES.every((name) => (
      parseMetricAggregate(value[name]) && value[name].observedSampleCount <= value.sampleCount
    ));
}

function parseCounters(value) {
  return exactKeys(value, [
    'duplicateResults', 'failedAttempts', 'passedSteps', 'retries',
  ]) && Object.values(value).every((entry) => boundedInteger(entry, 0, Number.MAX_SAFE_INTEGER));
}

function parseRecoveryEvidenceAggregate(value) {
  if (!exactKeys(value, ['reconnect', 'restart'])) return false;
  return ['reconnect', 'restart'].every((kind) => {
    const entry = value[kind];
    return exactKeys(entry, ['observedActions', 'recoveryCount', 'requiredActions'])
      && boundedInteger(entry.requiredActions, 0, Number.MAX_SAFE_INTEGER)
      && boundedInteger(entry.observedActions, 0, entry.requiredActions)
      && boundedInteger(entry.recoveryCount, 0, Number.MAX_SAFE_INTEGER)
      && (entry.observedActions > 0 || entry.recoveryCount === 0);
  });
}

export function parseLongRunState(value, parsedPlan) {
  if (
    !exactKeys(value, [
      'completedAt', 'counters', 'createdAt', 'deadlineAt', 'format', 'formatVersion', 'lease',
      'metrics', 'planDigest', 'position', 'recoveryEvidence', 'resultCode', 'runId', 'scenarioId', 'status', 'updatedAt',
    ])
    || value.format !== LONG_RUN_STATE_FORMAT
    || value.formatVersion !== LONG_RUN_FORMAT_VERSION
    || !UUID.test(value.runId)
    || !SHA256.test(value.planDigest)
    || !SCENARIO_ID.test(value.scenarioId)
    || !canonicalTimestamp(value.createdAt)
    || !canonicalTimestamp(value.deadlineAt)
    || !canonicalTimestamp(value.updatedAt)
    || Date.parse(value.createdAt) > Date.parse(value.updatedAt)
    || Date.parse(value.updatedAt) > Date.parse(value.deadlineAt) + 86_400_000
    || !['running', 'cleaning', 'completed', 'failed', 'aborted'].includes(value.status)
    || !exactKeys(value.position, ['attempt', 'completedSteps', 'iteration', 'phase', 'stepIndex'])
    || !boundedInteger(value.position.iteration, 0, 1_000_000)
    || !boundedInteger(value.position.stepIndex, 0, 64)
    || !boundedInteger(value.position.attempt, 0, 10)
    || !boundedInteger(value.position.completedSteps, 0, Number.MAX_SAFE_INTEGER)
    || !['ready', 'invoking'].includes(value.position.phase)
    || !parseCounters(value.counters)
    || !parseAggregateMetrics(value.metrics)
    || !parseRecoveryEvidenceAggregate(value.recoveryEvidence)
  ) fail('checkpoint_corrupt');
  if (value.lease !== null && (
    !exactKeys(value.lease, ['acquiredAt', 'expiresAt', 'heartbeatAt', 'ownerId'])
    || !UUID.test(value.lease.ownerId)
    || !canonicalTimestamp(value.lease.acquiredAt)
    || !canonicalTimestamp(value.lease.heartbeatAt)
    || !canonicalTimestamp(value.lease.expiresAt)
    || Date.parse(value.lease.acquiredAt) > Date.parse(value.lease.heartbeatAt)
    || Date.parse(value.lease.heartbeatAt) >= Date.parse(value.lease.expiresAt)
  )) fail('checkpoint_corrupt');
  const terminal = ['completed', 'failed', 'aborted'].includes(value.status);
  if (
    (terminal && (!RESULT_CODES.has(value.resultCode) || !canonicalTimestamp(value.completedAt) || value.lease !== null))
    || (value.status === 'cleaning' && (!RESULT_CODES.has(value.resultCode) || value.completedAt !== null || value.lease === null))
    || (value.status === 'running' && (value.resultCode !== null || value.completedAt !== null))
  ) fail('checkpoint_corrupt');
  if (parsedPlan) {
    if (value.planDigest !== parsedPlan.planDigest || value.scenarioId !== parsedPlan.config.scenarioId) {
      fail('checkpoint_plan_mismatch');
    }
    if (
      value.position.stepIndex >= parsedPlan.scenario.steps.length
      || value.position.iteration > parsedPlan.config.iterationLimit
      || value.position.attempt > parsedPlan.config.retry.maximumAttempts
      || value.position.completedSteps !== (
        value.position.iteration * parsedPlan.scenario.steps.length + value.position.stepIndex
      )
    ) fail('checkpoint_non_monotonic');
  }
  return value;
}

export async function readLongRunState(filename, parsedPlan) {
  return parseLongRunState(await readBoundedCanonicalJson(
    safeAbsoluteFile(filename, 'checkpoint_path_invalid'),
    'checkpoint_corrupt',
  ), parsedPlan);
}

function emptyMetrics() {
  return {
    sampleCount: 0,
    processSampleCount: 0,
    operationalSampleCount: 0,
    fixtureSampleCount: 0,
    ...Object.fromEntries(RESOURCE_NAMES.map((name) => [name, {
      observedSampleCount: 0,
      baseline: null,
      peak: null,
      last: null,
    }])),
  };
}

function emptyRecoveryEvidence() {
  return Object.fromEntries(['reconnect', 'restart'].map((kind) => [kind, {
    requiredActions: 0,
    observedActions: 0,
    recoveryCount: 0,
  }]));
}

function newState(parsedPlan, runId, now) {
  const createdAt = now().toISOString();
  return {
    format: LONG_RUN_STATE_FORMAT,
    formatVersion: LONG_RUN_FORMAT_VERSION,
    runId,
    planDigest: parsedPlan.planDigest,
    scenarioId: parsedPlan.config.scenarioId,
    createdAt,
    deadlineAt: new Date(Date.parse(createdAt) + parsedPlan.config.durationSeconds * 1_000).toISOString(),
    updatedAt: createdAt,
    status: 'running',
    position: { iteration: 0, stepIndex: 0, attempt: 0, phase: 'ready', completedSteps: 0 },
    lease: null,
    counters: {
      passedSteps: 0,
      failedAttempts: 0,
      retries: 0,
      duplicateResults: 0,
    },
    metrics: emptyMetrics(),
    recoveryEvidence: emptyRecoveryEvidence(),
    resultCode: null,
    completedAt: null,
  };
}

function leaseRecord(runId, ownerId, acquiredAt, heartbeatAt, durationSeconds) {
  return {
    format: 'kodex-long-run-acceptance-lease',
    formatVersion: LONG_RUN_FORMAT_VERSION,
    runId,
    ownerId,
    acquiredAt,
    heartbeatAt,
    expiresAt: new Date(Date.parse(heartbeatAt) + durationSeconds * 1_000).toISOString(),
  };
}

function parseLease(value) {
  if (
    !exactKeys(value, ['acquiredAt', 'expiresAt', 'format', 'formatVersion', 'heartbeatAt', 'ownerId', 'runId'])
    || value.format !== 'kodex-long-run-acceptance-lease'
    || value.formatVersion !== LONG_RUN_FORMAT_VERSION
    || !UUID.test(value.runId)
    || !UUID.test(value.ownerId)
    || !canonicalTimestamp(value.acquiredAt)
    || !canonicalTimestamp(value.heartbeatAt)
    || !canonicalTimestamp(value.expiresAt)
    || Date.parse(value.acquiredAt) > Date.parse(value.heartbeatAt)
    || Date.parse(value.heartbeatAt) >= Date.parse(value.expiresAt)
  ) fail('lease_corrupt');
  return value;
}

async function acquireLease(statePath, runId, ownerId, durationSeconds, now) {
  const lockRoot = `${safeAbsoluteFile(statePath, 'checkpoint_path_invalid')}.lease`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(lockRoot, { mode: 0o700 });
      const at = now().toISOString();
      const record = leaseRecord(runId, ownerId, at, at, durationSeconds);
      await atomicWriteJson(path.join(lockRoot, 'lease.json'), record);
      return { lockRoot, record };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = parseLease(await readBoundedCanonicalJson(path.join(lockRoot, 'lease.json'), 'lease_corrupt'));
      } catch (readError) {
        if (readError?.code === 'lease_corrupt') throw readError;
        continue;
      }
      if (Date.parse(existing.expiresAt) > now().getTime()) fail('duplicate_runner');
      const stale = `${lockRoot}.stale-${randomUUID()}`;
      try {
        await rename(lockRoot, stale);
        await rm(stale, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError?.code !== 'ENOENT') throw renameError;
      }
    }
  }
  fail('lease_contention');
}

async function releaseLease(lease, ownerId) {
  if (!lease) return;
  try {
    const record = parseLease(await readBoundedCanonicalJson(path.join(lease.lockRoot, 'lease.json'), 'lease_corrupt'));
    if (record.ownerId !== ownerId) return;
    await rm(lease.lockRoot, { recursive: true, force: true });
  } catch (error) {
    if (!['ENOENT', 'lease_corrupt'].includes(error?.code)) throw error;
  }
}

function parseResourceSample(value) {
  return exactKeys(value, RESOURCE_NAMES)
    && RESOURCE_NAMES.every((name) => (
      exactKeys(value[name], ['observed', 'value'])
      && typeof value[name].observed === 'boolean'
      && (value[name].observed
        ? boundedInteger(value[name].value, 0, Number.MAX_SAFE_INTEGER)
        : value[name].value === null)
    ));
}

export function parseLongRunAdapterResult(value) {
  if (
    !exactKeys(value, [
      'actionId', 'attempt', 'completedAt', 'duplicate', 'format', 'formatVersion', 'invocationId', 'iteration',
      'metrics', 'observationSource', 'outcome', 'recovery', 'resultCode', 'stepIndex',
    ])
    || value.format !== LONG_RUN_ADAPTER_RESULT_FORMAT
    || value.formatVersion !== LONG_RUN_FORMAT_VERSION
    || !IDENTIFIER.test(value.actionId)
    || !SHA256.test(value.invocationId)
    || !boundedInteger(value.iteration, 0, 1_000_000)
    || !boundedInteger(value.stepIndex, 0, 64)
    || !boundedInteger(value.attempt, 1, 10)
    || !canonicalTimestamp(value.completedAt)
    || !['process', 'operational-probe', 'fixture'].includes(value.observationSource)
    || !['passed', 'retryable-failure', 'terminal-failure'].includes(value.outcome)
    || !STABLE_CODE.test(value.resultCode)
    || typeof value.duplicate !== 'boolean'
    || !parseResourceSample(value.metrics)
    || !exactKeys(value.recovery, ['count', 'kind', 'observed'])
    || !RECOVERY_KINDS.includes(value.recovery.kind)
    || typeof value.recovery.observed !== 'boolean'
    || (value.recovery.observed
      ? !boundedInteger(value.recovery.count, 0, 1_000_000)
      : value.recovery.count !== null)
    || (value.recovery.kind === 'none' && (value.recovery.observed || value.recovery.count !== null))
  ) fail('adapter_result_invalid');
  return value;
}

function updateMetrics(state, sample, thresholds, observationSource) {
  state.metrics.sampleCount += 1;
  state.metrics[`${observationSource === 'operational-probe' ? 'operational' : observationSource}SampleCount`] += 1;
  let exceeded = false;
  for (const name of RESOURCE_NAMES) {
    if (!sample[name].observed) continue;
    const aggregate = state.metrics[name];
    const measured = sample[name].value;
    if (aggregate.observedSampleCount === 0) aggregate.baseline = measured;
    aggregate.observedSampleCount += 1;
    aggregate.last = measured;
    aggregate.peak = aggregate.peak === null ? measured : Math.max(aggregate.peak, measured);
    if (
      measured > thresholds[name].maximum
      || aggregate.peak - aggregate.baseline > thresholds[name].maximumGrowth
    ) exceeded = true;
  }
  return exceeded;
}

function receiptFromState(state) {
  if (!['completed', 'failed', 'aborted'].includes(state.status)) fail('receipt_unavailable');
  const receipt = {
    format: LONG_RUN_RECEIPT_FORMAT,
    formatVersion: LONG_RUN_FORMAT_VERSION,
    runId: state.runId,
    planDigest: state.planDigest,
    scenarioId: state.scenarioId,
    startedAt: state.createdAt,
    completedAt: state.completedAt,
    resultCode: state.resultCode,
    iterationsCompleted: state.position.iteration,
    stepsCompleted: state.position.completedSteps,
    counters: state.counters,
    metrics: state.metrics,
    recoveryEvidence: state.recoveryEvidence,
  };
  return { receipt, receiptDigest: digest(receipt) };
}

export function parseLongRunReceipt(value) {
  if (
    !exactKeys(value, [
      'completedAt', 'counters', 'format', 'formatVersion', 'iterationsCompleted', 'metrics', 'planDigest',
      'recoveryEvidence', 'resultCode', 'runId', 'scenarioId', 'startedAt', 'stepsCompleted',
    ])
    || value.format !== LONG_RUN_RECEIPT_FORMAT
    || value.formatVersion !== LONG_RUN_FORMAT_VERSION
    || !UUID.test(value.runId)
    || !SHA256.test(value.planDigest)
    || !SCENARIO_ID.test(value.scenarioId)
    || !canonicalTimestamp(value.startedAt)
    || !canonicalTimestamp(value.completedAt)
    || Date.parse(value.startedAt) > Date.parse(value.completedAt)
    || !RESULT_CODES.has(value.resultCode)
    || !boundedInteger(value.iterationsCompleted, 0, 1_000_000)
    || !boundedInteger(value.stepsCompleted, 0, Number.MAX_SAFE_INTEGER)
    || !parseCounters(value.counters)
    || !parseAggregateMetrics(value.metrics)
    || !parseRecoveryEvidenceAggregate(value.recoveryEvidence)
  ) fail('receipt_contract_invalid');
  return { receipt: value, receiptDigest: digest(value) };
}

export async function readLongRunReceipt(filename) {
  return parseLongRunReceipt(await readBoundedCanonicalJson(
    safeAbsoluteFile(filename, 'receipt_path_invalid'),
    'receipt_contract_invalid',
  ));
}

function operationId(state, actionId) {
  return createHash('sha256').update([
    state.runId,
    state.planDigest,
    String(state.position.iteration),
    String(state.position.stepIndex),
    actionId,
  ].join('\n')).digest('hex');
}

function invocationId(state, actionId) {
  return createHash('sha256').update([
    operationId(state, actionId),
    String(state.position.attempt),
  ].join('\n')).digest('hex');
}

function abortableSleep(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function invokeBounded(adapter, invocation, timeoutMilliseconds, outerSignal) {
  const controller = new AbortController();
  const relay = () => controller.abort();
  outerSignal?.addEventListener('abort', relay, { once: true });
  let timedOut = false;
  let guardTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMilliseconds);
  try {
    const result = await Promise.race([
      adapter.execute(invocation, controller.signal),
      new Promise((resolve) => {
        guardTimer = setTimeout(() => resolve(undefined), timeoutMilliseconds + 10_000);
      }),
    ]);
    if (timedOut || result === undefined) return { kind: 'timeout' };
    return { kind: 'result', result };
  } catch {
    return { kind: controller.signal.aborted ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
    clearTimeout(guardTimer);
    outerSignal?.removeEventListener('abort', relay);
  }
}

export async function runLongRunAcceptance(options) {
  if (!isRecord(options) || !['start', 'resume'].includes(options.mode)) fail('runner_options_invalid');
  const statePath = safeAbsoluteFile(options.statePath, 'checkpoint_path_invalid');
  const parsedPlan = parseLongRunConfig(options.config, options.catalog);
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const runId = options.runId ?? randomUUID();
  const ownerId = options.ownerId ?? randomUUID();
  if (!UUID.test(runId) || !UUID.test(ownerId)) fail('runner_options_invalid');
  if (!isRecord(options.adapter) || typeof options.adapter.execute !== 'function' || typeof options.adapter.cleanup !== 'function') {
    fail('adapter_invalid');
  }
  let state;
  if (options.mode === 'start') {
    try {
      await lstat(statePath);
      fail('checkpoint_exists');
    } catch (error) {
      if (error instanceof LongRunAcceptanceError || error?.code !== 'ENOENT') throw error;
    }
    state = newState(parsedPlan, runId, now);
  } else {
    state = await readLongRunState(statePath, parsedPlan);
    if (['completed', 'failed', 'aborted'].includes(state.status)) return receiptFromState(state);
  }

  let lease;
  let heartbeatTimer;
  let heartbeatPromise = Promise.resolve();
  let heartbeatFailure = false;
  let simulatedCrash = false;
  const checkpoint = async (label) => {
    state.updatedAt = now().toISOString();
    parseLongRunState(state, parsedPlan);
    await atomicWriteJson(statePath, state);
    if (options.faultInjector) await options.faultInjector(label, structuredClone(state));
  };
  const refreshLease = async () => {
    const heartbeatAt = now().toISOString();
    lease.record = leaseRecord(state.runId, ownerId, lease.record.acquiredAt, heartbeatAt, parsedPlan.config.lease.durationSeconds);
    state.lease = {
      ownerId,
      acquiredAt: lease.record.acquiredAt,
      heartbeatAt: lease.record.heartbeatAt,
      expiresAt: lease.record.expiresAt,
    };
    await atomicWriteJson(path.join(lease.lockRoot, 'lease.json'), lease.record);
  };
  const finish = async (resultCode, requestedStatus) => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      await heartbeatPromise;
    }
    state.status = 'cleaning';
    state.position.phase = 'ready';
    state.resultCode = resultCode;
    state.completedAt = null;
    await checkpoint('before-cleanup');
    let cleanupOkay = false;
    try {
      const cleanup = await options.adapter.cleanup({
        format: 'kodex-long-run-cleanup-request',
        formatVersion: LONG_RUN_FORMAT_VERSION,
        runId: state.runId,
        planDigest: state.planDigest,
      });
      cleanupOkay = exactKeys(cleanup, ['code', 'format', 'formatVersion'])
        && cleanup.format === 'kodex-long-run-cleanup-result'
        && cleanup.formatVersion === LONG_RUN_FORMAT_VERSION
        && cleanup.code === 'cleanup_complete';
    } catch {
      cleanupOkay = false;
    }
    state.status = cleanupOkay ? requestedStatus : 'failed';
    state.resultCode = cleanupOkay ? resultCode : 'cleanup_failed';
    state.completedAt = now().toISOString();
    state.lease = null;
    await checkpoint('terminal');
    await releaseLease(lease, ownerId);
    lease = undefined;
    return receiptFromState(state);
  };

  try {
    lease = await acquireLease(statePath, state.runId, ownerId, parsedPlan.config.lease.durationSeconds, now);
    await refreshLease();
    await checkpoint('lease-acquired');
    heartbeatTimer = setInterval(() => {
      heartbeatPromise = heartbeatPromise.then(refreshLease).catch(() => { heartbeatFailure = true; });
    }, parsedPlan.config.lease.heartbeatSeconds * 1_000);
    heartbeatTimer.unref?.();

    if (state.status === 'cleaning') {
      const requestedStatus = state.resultCode === 'completed'
        ? 'completed'
        : state.resultCode === 'aborted' ? 'aborted' : 'failed';
      return finish(state.resultCode, requestedStatus);
    }
    if (state.position.phase === 'invoking') {
      state.counters.failedAttempts += 1;
      if (state.position.attempt >= parsedPlan.config.retry.maximumAttempts) {
        return finish('retry_exhausted', 'failed');
      }
      state.counters.retries += 1;
      state.position.phase = 'ready';
      await checkpoint('resume-inflight');
    }

    while (true) {
      if (heartbeatFailure) return finish('terminal_step_failure', 'failed');
      if (options.signal?.aborted) return finish('aborted', 'aborted');
      if (now().getTime() >= Date.parse(state.deadlineAt)) {
        return finish(state.position.iteration > 0 ? 'completed' : 'deadline_exceeded', state.position.iteration > 0 ? 'completed' : 'failed');
      }
      if (state.position.iteration >= parsedPlan.config.iterationLimit) {
        return finish('iteration_limit_reached', 'failed');
      }
      const actionId = parsedPlan.scenario.steps[state.position.stepIndex];
      const command = options.catalog.commands.get(actionId);
      state.position.attempt += 1;
      state.position.phase = 'invoking';
      await refreshLease();
      await checkpoint('before-invocation');
      const expectedOperationId = operationId(state, actionId);
      const expectedInvocationId = invocationId(state, actionId);
      const invocationStartedAt = now().toISOString();
      const timeoutMilliseconds = Math.max(1, Math.min(
        parsedPlan.config.stepTimeoutSeconds * 1_000,
        Date.parse(state.deadlineAt) - now().getTime(),
      ));
      const invocation = {
        format: 'kodex-long-run-invocation',
        formatVersion: LONG_RUN_FORMAT_VERSION,
        operationId: expectedOperationId,
        invocationId: expectedInvocationId,
        actionId,
        actionKind: command.kind,
        iteration: state.position.iteration,
        stepIndex: state.position.stepIndex,
        attempt: state.position.attempt,
        startedAt: invocationStartedAt,
        deadlineAt: new Date(Math.min(
          Date.parse(state.deadlineAt),
          now().getTime() + timeoutMilliseconds,
        )).toISOString(),
      };
      const invoked = await invokeBounded(options.adapter, invocation, timeoutMilliseconds, options.signal);
      if (options.signal?.aborted) return finish('aborted', 'aborted');

      let outcome = 'retryable-failure';
      let result;
      if (invoked.kind === 'result') {
        try {
          result = parseLongRunAdapterResult(invoked.result);
        } catch {
          return finish('terminal_step_failure', 'failed');
        }
        if (
          result.invocationId !== expectedInvocationId
          || result.actionId !== actionId
          || result.iteration !== state.position.iteration
          || result.stepIndex !== state.position.stepIndex
          || result.attempt !== state.position.attempt
        ) return finish('unordered_result', 'failed');
        if (
          Date.parse(result.completedAt) < Date.parse(invocation.startedAt)
          || Date.parse(result.completedAt) > Date.parse(invocation.deadlineAt)
          || result.recovery.kind !== command.recoveryEvidence
        ) return finish('terminal_step_failure', 'failed');
        outcome = result.outcome;
      }
      if (result && updateMetrics(
        state,
        result.metrics,
        parsedPlan.config.thresholds,
        result.observationSource,
      )) {
        return finish('resource_threshold_exceeded', 'failed');
      }
      if (outcome === 'passed') {
        if (result.duplicate) state.counters.duplicateResults += 1;
        if (command.recoveryEvidence !== 'none') {
          const recovery = state.recoveryEvidence[command.recoveryEvidence];
          recovery.requiredActions += 1;
          if (result.recovery.observed) {
            recovery.observedActions += 1;
            recovery.recoveryCount += result.recovery.count;
          }
        }
        state.counters.passedSteps += 1;
        state.position.completedSteps += 1;
        state.position.stepIndex += 1;
        state.position.attempt = 0;
        state.position.phase = 'ready';
        if (state.position.stepIndex === parsedPlan.scenario.steps.length) {
          state.position.stepIndex = 0;
          state.position.iteration += 1;
        }
        await checkpoint('step-complete');
        continue;
      }
      state.counters.failedAttempts += 1;
      if (outcome === 'terminal-failure') return finish('terminal_step_failure', 'failed');
      if (state.position.attempt >= parsedPlan.config.retry.maximumAttempts) {
        return finish('retry_exhausted', 'failed');
      }
      state.counters.retries += 1;
      state.position.phase = 'ready';
      await checkpoint('retry-scheduled');
      const backoff = Math.min(
        parsedPlan.config.retry.maximumBackoffMilliseconds,
        parsedPlan.config.retry.initialBackoffMilliseconds * (2 ** (state.position.attempt - 1)),
        Math.max(0, Date.parse(state.deadlineAt) - now().getTime()),
      );
      await sleep(backoff, options.signal);
    }
  } catch (error) {
    if (error instanceof LongRunSimulatedCrash) {
      simulatedCrash = true;
      throw error;
    }
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lease && !simulatedCrash) await releaseLease(lease, ownerId);
  }
}

function observed(value) {
  return { observed: true, value };
}

function unobserved() {
  return { observed: false, value: null };
}

function processResourceSample() {
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
  return {
    heapBytes: observed(process.memoryUsage().heapUsed),
    handleCount: observed(handles.length),
    socketCount: observed(handles.filter((entry) => entry?.constructor?.name === 'Socket').length),
    databasePoolCount: unobserved(),
    outboxItemCount: unobserved(),
    leaseCount: unobserved(),
    temporaryBytes: unobserved(),
    diskBytes: unobserved(),
  };
}

export function resolveNpmCliInvocation(npmExecPath = process.env.npm_execpath) {
  if (
    typeof npmExecPath !== 'string'
    || !path.isAbsolute(npmExecPath)
    || path.basename(npmExecPath).toLowerCase() !== 'npm-cli.js'
  ) fail('adapter_invalid');
  const resolved = path.resolve(npmExecPath);
  let metadata;
  try { metadata = lstatSync(resolved); } catch { fail('adapter_invalid'); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('adapter_invalid');
  return { executable: process.execPath, argumentPrefix: [resolved] };
}

function externalResultDirectory(resultDirectory, repositoryRoot) {
  if (resultDirectory === undefined) return null;
  if (typeof resultDirectory !== 'string' || !path.isAbsolute(resultDirectory)) {
    fail('adapter_result_directory_invalid');
  }
  const resolved = path.resolve(resultDirectory);
  let metadata;
  let realDirectory;
  let realRepository;
  try {
    metadata = lstatSync(resolved);
    realDirectory = realpathSync(resolved);
    realRepository = realpathSync(repositoryRoot);
  } catch {
    fail('adapter_result_directory_invalid');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || path.resolve(realDirectory) !== resolved) {
    fail('adapter_result_directory_invalid');
  }
  const relative = path.relative(realRepository, realDirectory);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    fail('adapter_result_directory_must_be_external');
  }
  return realDirectory;
}

async function resultFileExists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    fail('adapter_result_invalid');
  }
}

export async function readExternalLongRunAdapterResult(resultDirectory, repositoryRoot, invocation, options = {}) {
  const directory = externalResultDirectory(resultDirectory, repositoryRoot);
  if (!isRecord(invocation) || !SHA256.test(invocation.invocationId)) fail('adapter_result_invalid');
  const consumed = options.consumedInvocationIds ?? new Set();
  if (!(consumed instanceof Set)) fail('adapter_result_invalid');
  if (consumed.has(invocation.invocationId)) fail('adapter_result_replayed');
  const filename = path.join(directory, `${invocation.invocationId}.json`);
  let metadata;
  try { metadata = await lstat(filename); } catch { fail('adapter_result_missing'); }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 2
    || metadata.size > MAX_ADAPTER_RESULT_BYTES
  ) fail('adapter_result_invalid');
  let bytes;
  let value;
  try {
    bytes = await readFile(filename);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('adapter_result_invalid');
  }
  if (!bytes.equals(Buffer.from(canonicalLongRunJson(value), 'utf8'))) fail('adapter_result_invalid');
  const parsed = parseLongRunAdapterResult(value);
  if (
    parsed.observationSource !== 'operational-probe'
    || parsed.invocationId !== invocation.invocationId
    || parsed.actionId !== invocation.actionId
    || parsed.iteration !== invocation.iteration
    || parsed.stepIndex !== invocation.stepIndex
    || parsed.attempt !== invocation.attempt
  ) fail('adapter_result_mismatch');
  if (
    Date.parse(parsed.completedAt) < Date.parse(invocation.startedAt)
    || Date.parse(parsed.completedAt) > Date.parse(invocation.deadlineAt)
    || metadata.mtimeMs < Date.parse(invocation.startedAt) - 2_000
    || metadata.mtimeMs > Date.parse(invocation.deadlineAt) + 2_000
  ) fail('adapter_result_stale');
  consumed.add(invocation.invocationId);
  return parsed;
}

function processAdapterResult(invocation, command, outcome, resultCode) {
  const completedMilliseconds = Math.max(
    Date.parse(invocation.startedAt),
    Math.min(Date.now(), Date.parse(invocation.deadlineAt)),
  );
  return {
    format: LONG_RUN_ADAPTER_RESULT_FORMAT,
    formatVersion: LONG_RUN_FORMAT_VERSION,
    invocationId: invocation.invocationId,
    actionId: invocation.actionId,
    iteration: invocation.iteration,
    stepIndex: invocation.stepIndex,
    attempt: invocation.attempt,
    completedAt: new Date(completedMilliseconds).toISOString(),
    observationSource: 'process',
    outcome,
    resultCode,
    duplicate: false,
    metrics: processResourceSample(),
    recovery: { kind: command.recoveryEvidence, observed: false, count: null },
  };
}

export function createProcessLongRunAdapter(repositoryRoot, parsedCatalog, options = {}) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) fail('adapter_invalid');
  const root = path.resolve(repositoryRoot);
  if (!isRecord(parsedCatalog) || !(parsedCatalog.commands instanceof Map) || !isRecord(options)) fail('adapter_invalid');
  const npm = resolveNpmCliInvocation(options.npmExecPath ?? process.env.npm_execpath);
  const resultDirectory = externalResultDirectory(options.resultDirectory, root);
  const consumedInvocationIds = new Set();
  const activeChildren = new Set();
  const stopChild = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', resolve);
        killer.once('exit', resolve);
      });
      return;
    }
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
  };
  return {
    async execute(invocation, signal) {
      const command = parsedCatalog.commands.get(invocation.actionId);
      if (!command) fail('command_not_allowlisted');
      if (resultDirectory !== null && !SHA256.test(invocation.operationId)) fail('adapter_result_invalid');
      const resultFilename = resultDirectory === null
        ? null
        : path.join(resultDirectory, `${invocation.invocationId}.json`);
      if (resultFilename !== null && await resultFileExists(resultFilename)) {
        return processAdapterResult(invocation, command, 'terminal-failure', 'adapter_result_replayed');
      }
      const exitCode = await new Promise((resolve) => {
        const child = spawn(npm.executable, [...npm.argumentPrefix, 'run', command.npmScript], {
          cwd: root,
          env: {
            ...process.env,
            ...(resultFilename === null ? {} : {
              KODEX_ACCEPTANCE_RESULT_FILE: resultFilename,
              KODEX_ACCEPTANCE_OPERATION_ID: invocation.operationId,
              KODEX_ACCEPTANCE_INVOCATION_ID: invocation.invocationId,
              KODEX_ACCEPTANCE_ACTION_ID: invocation.actionId,
              KODEX_ACCEPTANCE_ITERATION: String(invocation.iteration),
              KODEX_ACCEPTANCE_STEP_INDEX: String(invocation.stepIndex),
              KODEX_ACCEPTANCE_ATTEMPT: String(invocation.attempt),
            }),
          },
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        activeChildren.add(child);
        const abort = () => { void stopChild(child); };
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', () => {
          activeChildren.delete(child);
          signal.removeEventListener('abort', abort);
          resolve(-1);
        });
        child.once('exit', (code) => {
          activeChildren.delete(child);
          signal.removeEventListener('abort', abort);
          resolve(code ?? -1);
        });
      });
      const passed = exitCode === 0 && !signal.aborted;
      if (passed && resultDirectory !== null) {
        try {
          return await readExternalLongRunAdapterResult(
            resultDirectory,
            root,
            invocation,
            { consumedInvocationIds },
          );
        } catch (error) {
          const resultCode = error instanceof LongRunAcceptanceError ? error.code : 'adapter_result_invalid';
          return processAdapterResult(invocation, command, 'terminal-failure', resultCode);
        }
      }
      return processAdapterResult(
        invocation,
        command,
        passed ? 'passed' : 'retryable-failure',
        passed ? 'command_passed_without_observation' : signal.aborted ? 'command_aborted' : 'command_failed',
      );
    },
    async cleanup() {
      await Promise.all([...activeChildren].map(stopChild));
      return {
        format: 'kodex-long-run-cleanup-result',
        formatVersion: LONG_RUN_FORMAT_VERSION,
        code: 'cleanup_complete',
      };
    },
  };
}

export async function writeLongRunReceipt(filename, parsedReceipt) {
  const verified = parseLongRunReceipt(parsedReceipt.receipt ?? parsedReceipt);
  await atomicWriteJson(safeAbsoluteFile(filename, 'receipt_path_invalid'), verified.receipt);
  return verified;
}
