import { OpenAIEmbeddingProvider, openAIEmbeddingConfigFromEnv } from '@kodex/product-db';
import { expect, it } from 'vitest';

it('performs an explicitly opted-in official OpenAI embedding smoke request', async () => {
  const config = openAIEmbeddingConfigFromEnv();
  const provider = new OpenAIEmbeddingProvider({ ...config, batchSize: 1 });
  const embeddings = await provider.embed(['Kodex explicit embedding smoke test.']);
  expect(embeddings).toHaveLength(1);
  expect(embeddings[0]).toHaveLength(config.dimensions);
  expect(embeddings[0].every(Number.isFinite)).toBe(true);
});
