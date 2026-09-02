import http from 'node:http';

export interface ResponsesLoopbackRequest {
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  url: string;
}

export interface ResponsesLoopbackFixture {
  baseUrl: string;
  close(): Promise<void>;
  requests: ResponsesLoopbackRequest[];
  sawToolOutput(): boolean;
  toolOutputContainsExpectedText(): boolean;
  toolOutputSucceeded(): boolean;
}

function event(value: unknown): string {
  const type = (value as { type: string }).type;
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function completed(id: string): unknown {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      },
    },
  };
}

/** Keyless loopback Responses SSE fixture shared by real App Server integration tests. */
export async function startResponsesLoopbackFixture(): Promise<ResponsesLoopbackFixture> {
  const requests: ResponsesLoopbackRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let toolOutputObserved = false;
  let expectedToolOutputObserved = false;
  let successfulToolOutputObserved = false;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ url: request.url ?? '', headers: request.headers, body });
    const input = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
    toolOutputObserved ||= input.some(
      (item) => item.type === 'function_call_output' && item.call_id === 'call-local-1',
    );
    expectedToolOutputObserved ||= input.some(
      (item) => item.type === 'function_call_output'
        && item.call_id === 'call-local-1'
        && JSON.stringify(item).includes('kodex-loopback-tool'),
    );
    successfulToolOutputObserved ||= input.some((item) => {
      if (item.type !== 'function_call_output' || item.call_id !== 'call-local-1') return false;
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
      if (/Process exited with code 0|Exit code:\s*0/iu.test(output)) return true;
      try {
        const parsed = JSON.parse(output) as { metadata?: { exit_code?: unknown } };
        return parsed.metadata?.exit_code === 0;
      } catch {
        return false;
      }
    });
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    if (!toolOutputObserved) {
      const args = JSON.stringify({
        cmd: process.platform === 'win32'
          ? 'cmd.exe /d /c echo kodex-loopback-tool'
          : 'printf kodex-loopback-tool',
        yield_time_ms: 500,
      });
      response.end([
        event({ type: 'response.created', response: { id: 'resp-local-tool' } }),
        event({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call-local-1',
            name: 'exec_command',
            arguments: args,
          },
        }),
        event(completed('resp-local-tool')),
      ].join(''));
      return;
    }
    response.end([
      event({ type: 'response.created', response: { id: 'resp-local-message' } }),
      event({
        type: 'response.output_item.added',
        item: {
          type: 'message',
          role: 'assistant',
          id: 'message-local-1',
          content: [{ type: 'output_text', text: '' }],
        },
      }),
      event({ type: 'response.output_text.delta', delta: 'local stream ok' }),
      event({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          id: 'message-local-1',
          content: [{ type: 'output_text', text: 'local stream ok' }],
        },
      }),
      event(completed('resp-local-message')),
    ].join(''));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback Responses fixture did not bind.');
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    sawToolOutput: () => toolOutputObserved,
    toolOutputContainsExpectedText: () => expectedToolOutputObserved,
    toolOutputSucceeded: () => successfulToolOutputObserved,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
