import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalLongRunJson,
  createProcessLongRunAdapter,
  LongRunAcceptanceError,
  LongRunSimulatedCrash,
  parseLongRunReceipt,
  parseLongRunScenarioCatalog,
  readLongRunState,
  runLongRunAcceptance,
} from './lib/long-run-acceptance.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-long-run-fixture-'));
const runId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const actionId = 'acceptance.browserless-product-local';
const catalog = parseLongRunScenarioCatalog({
  format: 'kodex-long-run-acceptance-scenarios',
  formatVersion: 1,
  commands: [{ id: actionId, kind: 'workload', npmScript: 'test:full-stack' }],
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
    heapBytes: 100,
    handleCount: 2,
    socketCount: 1,
    databasePoolCount: 1,
    outboxItemCount: 0,
    leaseCount: 1,
    temporaryBytes: 0,
    diskBytes: 100,
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
    outcome: 'passed',
    resultCode: 'fixture_passed',
    duplicate: false,
    metrics: sample(),
    recovery: { reconnects: 0, restarts: 0 },
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
  if (process.platform === 'win32' && process.env.npm_execpath) {
    assert.doesNotThrow(() => createProcessLongRunAdapter(process.cwd(), catalog));
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
      return passed(invocation, { duplicate: true, recovery: { reconnects: 1, restarts: 1 } });
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
    adapter: fixtureAdapter(async (invocation) => passed(invocation, { metrics: sample({ heapBytes: 101 }) })),
  });
  assert.equal(leak.receipt.resultCode, 'resource_threshold_exceeded');

  const unordered = await runLongRunAcceptance({
    mode: 'start', catalog, config: config(), statePath: path.join(root, 'unordered.json'), runId, ownerId,
    now: clock().now,
    adapter: fixtureAdapter(async (invocation) => passed(invocation, { stepIndex: invocation.stepIndex + 1 })),
  });
  assert.equal(unordered.receipt.resultCode, 'unordered_result');

  const forbiddenCatalog = {
    format: 'kodex-long-run-acceptance-scenarios',
    formatVersion: 1,
    commands: [{ id: 'chaos.delete-database', kind: 'chaos', npmScript: 'test:full-stack' }],
    scenarios: [{ id: 'unsafe', minimumDurationSeconds: 1, maximumDurationSeconds: 1, steps: ['chaos.delete-database'] }],
  };
  assert.throws(() => parseLongRunScenarioCatalog(forbiddenCatalog), (error) => (
    error instanceof LongRunAcceptanceError && error.code === 'chaos_action_forbidden'
  ));

  await mkdir(path.join(root, 'kept'), { recursive: true });
  process.stdout.write(`${JSON.stringify({
    code: 'long_run_acceptance_fixture_passed',
    fixtureCount: 13,
    formatVersion: 1,
    kind: 'kodex_long_run_acceptance_fixture',
    ok: true,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
