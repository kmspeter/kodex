import http from 'node:http';

export interface RepositoryRagLoopbackRequest {
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  url: string;
}

export interface RepositoryRagLoopbackFixture {
  baseUrl: string;
  close(): Promise<void>;
  requests: RepositoryRagLoopbackRequest[];
  sawRepositoryContext(): boolean;
}

const SAFE_CITATION = 'Repository Acceptance Fixture / docs/repository-note.md';
const REPOSITORY_MARKER = 'REPOSITORY_ACCEPTANCE_ALPHA';

function event(value: unknown): string {
  const type = (value as { type: string }).type;
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

/** Deterministic, keyless Responses fixture for the repository-RAG desktop acceptance path. */
export async function startRepositoryRagLoopbackFixture(): Promise<RepositoryRagLoopbackFixture> {
  const requests: RepositoryRagLoopbackRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let repositoryContextObserved = false;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ url: request.url ?? '', headers: request.headers, body });
    const serialized = JSON.stringify(body);
    repositoryContextObserved ||= serialized.includes('[KODEX_RAG_CONTEXT_BEGIN]')
      && serialized.includes(REPOSITORY_MARKER)
      && serialized.includes(SAFE_CITATION)
      && serialized.includes('repository_file');

    const text = repositoryContextObserved
      ? `repository citation: ${SAFE_CITATION}`
      : 'repository rag context missing';
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end([
      event({ type: 'response.created', response: { id: 'resp-repository-rag' } }),
      event({
        type: 'response.output_item.added',
        item: {
          type: 'message', role: 'assistant', id: 'message-repository-rag',
          content: [{ type: 'output_text', text: '' }],
        },
      }),
      event({ type: 'response.output_text.delta', delta: text }),
      event({
        type: 'response.output_item.done',
        item: {
          type: 'message', role: 'assistant', id: 'message-repository-rag',
          content: [{ type: 'output_text', text }],
        },
      }),
      event({
        type: 'response.completed',
        response: {
          id: 'resp-repository-rag',
          usage: {
            input_tokens: 1, input_tokens_details: null,
            output_tokens: 1, output_tokens_details: null, total_tokens: 2,
          },
        },
      }),
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
  if (!address || typeof address === 'string') throw new Error('Repository RAG fixture did not bind.');
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    sawRepositoryContext: () => repositoryContextObserved,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
