import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const mode = process.argv[2] ?? 'normal';
const counterPath = process.argv[3];
let processCount = 1;
if (counterPath) {
  processCount = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) + 1 : 1;
  writeFileSync(counterPath, String(processCount));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex', platformFamily: 'windows', platformOs: 'windows', codexHome: 'fake' } });
    if (mode === 'exit-once' && processCount === 1) setTimeout(() => process.exit(7), 25);
    return;
  }
  if (message.method === 'initialized') {
    process.stderr.write(`child-key:${process.env.OPENAI_API_KEY ?? ''}\n`);
    if (mode === 'always-exit') { setTimeout(() => process.exit(9), 5); return; }
    process.stdout.write('malformed-json\n');
    send({ method: 'warning', params: { message: `fake warning ${process.env.OPENAI_API_KEY ?? ''}` } });
    send({ method: 'item/commandExecution/requestApproval', id: 'approval-1', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: Date.now(), environmentId: null, reason: 'test', command: 'npm test', cwd: process.cwd(), commandActions: [], proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null } });
    return;
  }
  if (message.method === 'test/correlation') {
    setTimeout(() => send({ id: message.id, result: { token: message.params.token } }), message.params.delay);
    return;
  }
  if (message.method === 'thread/list') {
    send({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: null } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: `thread-${processCount}` } } });
    return;
  }
  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: `turn-${processCount}`, status: 'inProgress', items: [], itemsView: 'full', error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    return;
  }
  if (Object.hasOwn(message, 'id') && !message.method) {
    process.stderr.write(`server-response:${JSON.stringify(message.result)}\n`);
    return;
  }
  if (Object.hasOwn(message, 'id')) send({ id: message.id, result: {} });
});
