import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalLongRunJson,
  createProcessLongRunAdapter,
  LongRunAcceptanceError,
  LongRunSimulatedCrash,
  parseLongRunAdapterResult,
  parseLongRunReceipt,
  parseLongRunScenarioCatalog,
  readExternalLongRunAdapterResult,
  readLongRunState,
  resolveNpmCliInvocation,
  runLongRunAcceptance,
} from './lib/long-run-acceptance.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-long-run-fixture-'));
const runId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const actionId = 'chaos.websocket-reconnect';
const catalog = parseLongRunScenarioCatalog({
  format: 'kodex-long-run-acceptance-scenarios',
  formatVersion: 1,
  commands: [{ id: actionId, kind: 'chaos', npmScript: 'test:full-stack', recoveryEvidence: 'reconnect' }],
  scenarios: [{
    id: 'fixture-soak',
    minimumDurationSeconds: 1,
    maximumDurationSeconds: 120,
    steps: [actionId],
  }],
});

function config(overrides = {}) {
  return {
    format: 'kodex-long-run-acceptance-config',
    formatVersion: 1,
    scenarioId: 'fixture-soak',
    durationSeconds: 2,
    iterationLimit: 20,
    lease: { durationSeconds: 10, heartbeatSeconds: 2 },
    retry: { maximumAttempts: 2, initialBackoffMilliseconds: 1, maximumBackoffMilliseconds: 2 },
    stepTimeoutSeconds: 1,
    thresholds: Object.fromEntries([
      'heapBytes', 'handleCount', 'socketCount', 'databasePoolCount', 'outboxItemCount',
      'leaseCount', 'temporaryBytes', 'diskBytes',
    ].map((name) => [name, { maximum: 1_000_000, maximumGrowth: 1_000_000 }])),
    ...overrides,
  };
}
function clock(start = '2026-09-05T00:00:00.000Z') {
  let milliseconds = Date.parse(start);
  return {
    now: () => new Date(milliseconds),
    advance: (amount) => { milliseconds += amount; },
  };
}

function sample(overrides = {}) {
  return {
    heapBytes: { observed: true, value: 100 },
    handleCount: { observed: true, value: 2 },
    socketCount: { observed: true, value: 1 },
    databasePoolCount: { observed: true, value: 1 },
    outboxItemCount: { observed: true, value: 0 },
    leaseCount: { observed: true, value: 1 },
    temporaryBytes: { observed: true, value: 0 },
    diskBytes: { observed: true, value: 100 },
    ...overrides,
  };
}

function passed(invocation, overrides = {}) {
  return {
    format: 'kodex-long-run-adapter-result',
    formatVersion: 1,
    invocationId: invocation.invocationId,
    actionId: invocation.actionId,
    iteration: invocation.iteration,
    stepIndex: invocation.stepIndex,
    attempt: invocation.attempt,
    completedAt: invocation.startedAt,
    observationSource: 'fixture',
    outcome: 'passed',
    resultCode: 'fixture_passed',
    duplicate: false,
    metrics: sample(),
    recovery: { kind: 'reconnect', observed: true, count: 1 },
    ...overrides,
  };
}

function fixtureAdapter(execute, cleanupCounter = { count: 0 }) {
  return {
    execute,
    async cleanup() {
      cleanupCounter.count += 1;
      return { format: 'kodex-long-run-cleanup-result', formatVersion: 1, code: 'cleanup_complete' };
    },
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof LongRunAcceptanceError && error.code === code);
}

try {
  const fakeBin = path.join(root, 'fake-bin');
  await mkdir(fakeBin);
  const fakeNpmCli = path.join(fakeBin, 'npm-cli.js');
  await writeFile(fakeNpmCli, 'process.exitCode = 0;\n', 'utf8');
  const fakePathNpm = path.join(fakeBin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  await writeFile(fakePathNpm, process.platform === 'win32' ? '@exit /b 91\r\n' : '#!/bin/sh\nexit 91\n', 'utf8');
  if (process.platform !== 'win32') await chmod(fakePathNpm, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = fakeBin;
  try {
    const npm = resolveNpmCliInvocation(fakeNpmCli);
    assert.equal(npm.executable, process.execPath);
    assert.deepEqual(npm.argumentPrefix, [fakeNpmCli]);
    const processAdapter = createProcessLongRunAdapter(process.cwd(), catalog, { npmExecPath: fakeNpmCli });
    const startedAt = new Date().toISOString();
    const fallback = await processAdapter.execute({
      invocationId: '9'.repeat(64),
      actionId,
      iteration: 0,
      stepIndex: 0,
      attempt: 1,
      startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + 30_000).toISOString(),
    }, new AbortController().signal);
    assert.equal(fallback.outcome, 'passed');
    assert.deepEqual(fallback.recovery, { kind: 'reconnect', observed: false, count: null });
    assert.deepEqual(fallback.metrics.databasePoolCount, { observed: false, value: null });
    assert.equal(fallback.observationSource, 'process');
    await processAdapter.cleanup();

    const probeBin = path.join(root, 'probe-bin');
    const probeResults = path.join(root, 'probe-results');
    await mkdir(probeBin);
    await mkdir(probeResults);
    const probeNpmCli = path.join(probeBin, 'npm-cli.js');
    await writeFile(probeNpmCli, [
      "const fs = require('node:fs');",
      'const observed = (value) => ({ observed: true, value });',
      'const value = {',
      "  format: 'kodex-long-run-adapter-result', formatVersion: 1,",
      '  invocationId: process.env.KODEX_ACCEPTANCE_INVOCATION_ID,',
      '  actionId: process.env.KODEX_ACCEPTANCE_ACTION_ID,',
      '  iteration: Number(process.env.KODEX_ACCEPTANCE_ITERATION),',
      '  stepIndex: Number(process.env.KODEX_ACCEPTANCE_STEP_INDEX),',
      '  attempt: Number(process.env.KODEX_ACCEPTANCE_ATTEMPT),',
      "  completedAt: new Date().toISOString(), observationSource: 'operational-probe',",
      "  outcome: 'passed', resultCode: 'probe_passed', duplicate: false,",
      '  metrics: { heapBytes: observed(100), handleCount: observed(2), socketCount: observed(1),',
      '    databasePoolCount: observed(1), outboxItemCount: observed(0), leaseCount: observed(1),',
      '    temporaryBytes: observed(0), diskBytes: observed(100) },',
      "  recovery: { kind: 'reconnect', observed: true, count: 1 },",
      '};',
      'const stable = (entry) => Array.isArray(entry) ? entry.map(stable)',
      "  : entry && typeof entry === 'object' ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, stable(entry[key])])) : entry;",
      "fs.writeFileSync(process.env.KODEX_ACCEPTANCE_RESULT_FILE, `${JSON.stringify(stable(value), null, 2)}\\n`, 'utf8');",
    ].join('\n'), 'utf8');
    const probeAdapter = createProcessLongRunAdapter(process.cwd(), catalog, {
      npmExecPath: probeNpmCli,
      resultDirectory: probeResults,
    });
    const probeStartedAt = new Date().toISOString();
    const probeResult = await probeAdapter.execute({
      operationId: '6'.repeat(64),
      invocationId: '7'.repeat(64),
      actionId,
      iteration: 0,
      stepIndex: 0,
      attempt: 1,
      startedAt: probeStartedAt,
      deadlineAt: new Date(Date.parse(probeStartedAt) + 30_000).toISOString(),
    }, new AbortController().signal);
    assert.equal(probeResult.observationSource, 'operational-probe');
    assert.equal(probeResult.metrics.databasePoolCount.observed, true);
    assert.deepEqual(probeResult.recovery, { kind: 'reconnect', observed: true, count: 1 });
    await probeAdapter.cleanup();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  const deterministicReceipts = [];
  for (const suffix of ['a', 'b']) {
    const time = clock();
    const cleanup = { count: 0 };
    const result = await runLongRunAcceptance({
      mode: 'start',
      catalog,
      config: config(),
      statePath: path.join(root, `deterministic-${suffix}.json`),
      runId,
      ownerId,
      now: time.now,
      sleep: async () => undefined,
      adapter: fixtureAdapter(async (invocation) => {
        time.advance(1_000);
        return passed(invocation);
      }, cleanup),
    });
    assert.equal(result.receipt.resultCode, 'completed');
    assert.equal(cleanup.count, 1);
    assert.deepEqual(parseLongRunReceipt(result.receipt), result);
    deterministicReceipts.push(canonicalLongRunJson(result.receipt));
  }
  assert.equal(deterministicReceipts[0], deterministicReceipts[1]);

  const competitionTime = clock();
  const competitionAbort = new AbortController();
  let invocationStarted;
  const started = new Promise((resolve) => { invocationStarted = resolve; });
  const competitionState = path.join(root, 'competition.json');
  const competitionRun = runLongRunAcceptance({
    mode: 'start',
    catalog,
    config: config({ durationSeconds: 30 }),
    statePath: competitionState,
    runId,
    ownerId,
    now: competitionTime.now,
    signal: competitionAbort.signal,
    adapter: fixtureAdapter(async (invocation, signal) => {
      invocationStarted();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return passed(invocation, { outcome: 'retryable-failure', resultCode: 'fixture_aborted' });
    }),
  });
  await started;
  await expectCode(runLongRunAcceptance({
    mode: 'resume',
    catalog,
    config: config({ durationSeconds: 30 }),
    statePath: competitionState,
    ownerId: '33333333-3333-4333-8333-333333333333',
    now: competitionTime.now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation)),
  }), 'duplicate_runner');
  competitionAbort.abort();
  assert.equal((await competitionRun).receipt.resultCode, 'aborted');

  const crashTime = clock();
  const crashState = path.join(root, 'crash.json');
  let faulted = false;
  await assert.rejects(runLongRunAcceptance({
    mode: 'start',
    catalog,
    config: config({ durationSeconds: 30 }),
    statePath: crashState,
    runId,
    ownerId,
    now: crashTime.now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation)),
    faultInjector(label) {
      if (label === 'before-invocation' && !faulted) {
        faulted = true;
        throw new LongRunSimulatedCrash();
      }
    },
  }), LongRunSimulatedCrash);
  crashTime.advance(11_000);
  const resumed = await runLongRunAcceptance({
    mode: 'resume',
    catalog,
    config: config({ durationSeconds: 30 }),
    statePath: crashState,
    ownerId: '44444444-4444-4444-8444-444444444444',
    now: crashTime.now,
    sleep: async () => undefined,
    adapter: fixtureAdapter(async (invocation) => {
      crashTime.advance(20_000);
      return passed(invocation, { duplicate: true });
    }),
  });
  assert.equal(resumed.receipt.resultCode, 'completed');
  assert.equal(resumed.receipt.counters.duplicateResults, 1);
  assert.equal(resumed.receipt.counters.retries, 1);

  const corrupt = path.join(root, 'corrupt.json');
  await writeFile(corrupt, '{"not":"canonical"}', 'utf8');
  await expectCode(readLongRunState(corrupt), 'checkpoint_corrupt');
  const mismatched = path.join(root, 'mismatched.json');
  await writeFile(mismatched, await readFile(path.join(root, 'deterministic-a.json')));
  await expectCode(runLongRunAcceptance({
    mode: 'resume',
    catalog,
    config: config({ durationSeconds: 3 }),
    statePath: mismatched,
    ownerId,
    now: clock().now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation)),
  }), 'checkpoint_plan_mismatch');

  const staleTime = clock();
  const staleState = path.join(root, 'stale.json');
  let staleFaulted = false;
  await assert.rejects(runLongRunAcceptance({
    mode: 'start', catalog, config: config(), statePath: staleState, runId, ownerId, now: staleTime.now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation)),
    faultInjector(label) {
      if (label === 'before-invocation' && !staleFaulted) {
        staleFaulted = true;
        throw new LongRunSimulatedCrash();
      }
    },
  }), LongRunSimulatedCrash);
  staleTime.advance(11_000);
  const stale = await runLongRunAcceptance({
    mode: 'resume', catalog, config: config(), statePath: staleState,
    ownerId: '55555555-5555-4555-8555-555555555555', now: staleTime.now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation)),
  });
  assert.equal(stale.receipt.resultCode, 'deadline_exceeded');

  const timeoutTime = clock();
  let attempts = 0;
  const timeout = await runLongRunAcceptance({
    mode: 'start', catalog, config: config(), statePath: path.join(root, 'timeout.json'), runId, ownerId,
    now: timeoutTime.now, sleep: async () => undefined,
    adapter: fixtureAdapter(async (invocation, signal) => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return passed(invocation, { outcome: 'retryable-failure', resultCode: 'fixture_timeout' });
      }
      timeoutTime.advance(2_000);
      return passed(invocation);
    }),
  });
  assert.equal(timeout.receipt.resultCode, 'completed');
  assert.equal(timeout.receipt.counters.retries, 1);

  const leakTime = clock();
  const lowThresholds = config().thresholds;
  lowThresholds.heapBytes = { maximum: 100, maximumGrowth: 5 };
  const leak = await runLongRunAcceptance({
    mode: 'start', catalog, config: config({ thresholds: lowThresholds }), statePath: path.join(root, 'leak.json'),
    runId, ownerId, now: leakTime.now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation, {
      metrics: sample({ heapBytes: { observed: true, value: 101 } }),
    })),
  });
  assert.equal(leak.receipt.resultCode, 'resource_threshold_exceeded');

  const unordered = await runLongRunAcceptance({
    mode: 'start', catalog, config: config(), statePath: path.join(root, 'unordered.json'), runId, ownerId,
    now: clock().now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation, { stepIndex: invocation.stepIndex + 1 })),
  });
  assert.equal(unordered.receipt.resultCode, 'unordered_result');

  const adapterShapeInvocation = {
    invocationId: '8'.repeat(64),
    actionId,
    iteration: 0,
    stepIndex: 0,
    attempt: 1,
    startedAt: '2026-09-05T00:00:00.000Z',
    deadlineAt: '2026-09-05T00:01:00.000Z',
  };
  assert.throws(() => parseLongRunAdapterResult(passed(adapterShapeInvocation, {
    metrics: sample({ databasePoolCount: { observed: false, value: 0 } }),
  })), (error) => error instanceof LongRunAcceptanceError && error.code === 'adapter_result_invalid');

  const fabricatedRecovery = await runLongRunAcceptance({
    mode: 'start', catalog, config: config(), statePath: path.join(root, 'fabricated-recovery.json'), runId, ownerId,
    now: clock().now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation, {
      recovery: { kind: 'restart', observed: true, count: 1 },
    })),
  });
  assert.equal(fabricatedRecovery.receipt.resultCode, 'terminal_step_failure');
  assert.equal(fabricatedRecovery.receipt.recoveryEvidence.reconnect.requiredActions, 0);

  const coverageTime = clock();
  const missingCoverage = await runLongRunAcceptance({
    mode: 'start', catalog, config: config(), statePath: path.join(root, 'missing-coverage.json'), runId, ownerId,
    now: coverageTime.now,
    adapter: fixtureAdapter(async (invocation) => {
      coverageTime.advance(2_000);
      return passed(invocation, {
        observationSource: 'operational-probe',
        metrics: sample({ databasePoolCount: { observed: false, value: null } }),
      });
    }),
  });
  assert.equal(missingCoverage.receipt.resultCode, 'completed');
  assert.equal(missingCoverage.receipt.metrics.databasePoolCount.observedSampleCount, 0);
  assert.equal(missingCoverage.receipt.metrics.databasePoolCount.baseline, null);
  assert.equal(missingCoverage.receipt.metrics.operationalSampleCount, 1);

  const externalResults = path.join(root, 'external-results');
  await mkdir(externalResults);
  const externalNow = Date.now();
  const externalInvocation = (character) => ({
    invocationId: character.repeat(64),
    actionId,
    iteration: 3,
    stepIndex: 0,
    attempt: 2,
    startedAt: new Date(externalNow - 1_000).toISOString(),
    deadlineAt: new Date(externalNow + 60_000).toISOString(),
  });
  const validInvocation = externalInvocation('a');
  await writeFile(path.join(externalResults, `${validInvocation.invocationId}.json`), canonicalLongRunJson(passed(
    validInvocation,
    { completedAt: new Date(externalNow).toISOString(), observationSource: 'operational-probe' },
  )), 'utf8');
  const consumedInvocationIds = new Set();
  assert.equal((await readExternalLongRunAdapterResult(
    externalResults,
    process.cwd(),
    validInvocation,
    { consumedInvocationIds },
  )).observationSource, 'operational-probe');
  await expectCode(readExternalLongRunAdapterResult(
    externalResults,
    process.cwd(),
    validInvocation,
    { consumedInvocationIds },
  ), 'adapter_result_replayed');

  const mismatchedInvocation = externalInvocation('b');
  await writeFile(path.join(externalResults, `${mismatchedInvocation.invocationId}.json`), canonicalLongRunJson(passed(
    mismatchedInvocation,
    { actionId: 'chaos.runtime-restart-recovery', observationSource: 'operational-probe' },
  )), 'utf8');
  await expectCode(readExternalLongRunAdapterResult(
    externalResults,
    process.cwd(),
    mismatchedInvocation,
  ), 'adapter_result_mismatch');

  const staleInvocation = externalInvocation('c');
  await writeFile(path.join(externalResults, `${staleInvocation.invocationId}.json`), canonicalLongRunJson(passed(
    staleInvocation,
    { completedAt: new Date(externalNow - 2_000).toISOString(), observationSource: 'operational-probe' },
  )), 'utf8');
  await expectCode(readExternalLongRunAdapterResult(
    externalResults,
    process.cwd(),
    staleInvocation,
  ), 'adapter_result_stale');

  const linkedResults = path.join(root, 'external-results-link');
  await symlink(externalResults, linkedResults, process.platform === 'win32' ? 'junction' : 'dir');
  await expectCode(readExternalLongRunAdapterResult(
    linkedResults,
    process.cwd(),
    externalInvocation('d'),
  ), 'adapter_result_directory_invalid');

  const forbiddenCatalog = {
    format: 'kodex-long-run-acceptance-scenarios',
    formatVersion: 1,
    commands: [{
      id: 'chaos.delete-database',
      kind: 'chaos',
      npmScript: 'test:full-stack',
      recoveryEvidence: 'restart',
    }],
    scenarios: [{ id: 'unsafe', minimumDurationSeconds: 1, maximumDurationSeconds: 1, steps: ['chaos.delete-database'] }],
  };
  assert.throws(() => parseLongRunScenarioCatalog(forbiddenCatalog), (error) => (
    error instanceof LongRunAcceptanceError && error.code === 'chaos_action_forbidden'
  ));

  await mkdir(path.join(root, 'kept'), { recursive: true });
  process.stdout.write(`${JSON.stringify({
    code: 'long_run_acceptance_fixture_passed',
    fixtureCount: 21,
    formatVersion: 1,
    kind: 'kodex_long_run_acceptance_fixture',
    ok: true,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
