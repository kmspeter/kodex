import { appendFileSync } from 'node:fs';

const EMBEDDING_URL = 'https://api.openai.com/v1/embeddings';
const dimensions = Number(process.env.OPENAI_EMBEDDING_DIMENSIONS ?? 3);
const model = process.env.OPENAI_EMBEDDING_MODEL ?? 'kodex-acceptance-embedding-v1';
const logPath = process.env.KODEX_ACCEPTANCE_EMBEDDING_LOG;
const originalFetch = globalThis.fetch.bind(globalThis);

function vector(text) {
  const normalized = text.toUpperCase();
  if (normalized.includes('REPOSITORY_ACCEPTANCE_ALPHA')) return [1, 0, 0];
  if (normalized.includes('MANUAL_KNOWLEDGE_BRAVO')) return [0, 1, 0];
  if (normalized.includes('FOREIGN_TENANT_CHARLIE')) return [0, 0, 1];
  const fallback = 1 / Math.sqrt(3);
  return [fallback, fallback, fallback];
}

globalThis.fetch = async (input, init) => {
  const target = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (target !== EMBEDDING_URL) return originalFetch(input, init);
  const parsed = JSON.parse(String(init?.body ?? '{}'));
  const inputs = Array.isArray(parsed.input) ? parsed.input : [];
  if (parsed.model !== model || dimensions !== 3) {
    return new Response(JSON.stringify({ error: { message: 'fixture configuration mismatch' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ inputs, model, pid: process.pid })}\n`, 'utf8');
  return new Response(JSON.stringify({
    object: 'list', model,
    data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vector(String(text)) })),
    usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
