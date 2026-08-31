import type { ProductDatabase } from './database.js';
import {
  OpenAIEmbeddingProvider,
  openAIEmbeddingConfigFromEnv,
} from './embedding-provider.js';
import { PostgresKnowledgeRepository } from './knowledge-repository.js';
import { KnowledgeService } from './knowledge-service.js';
import type { EmbeddingProvider } from './knowledge-types.js';
import { ragConfigFromEnv, type RagConfig } from './rag-config.js';

export interface KnowledgeRuntime {
  config: RagConfig;
  service?: KnowledgeService;
}

export interface KnowledgeRuntimeOptions {
  createEmbeddingProvider?: (env: NodeJS.ProcessEnv) => EmbeddingProvider;
}

export function createKnowledgeRuntimeFromEnv(
  database: ProductDatabase,
  env: NodeJS.ProcessEnv = process.env,
  options: KnowledgeRuntimeOptions = {},
): KnowledgeRuntime {
  const config = ragConfigFromEnv(env);
  if (!config.enabled) return { config };

  const embeddingProvider = options.createEmbeddingProvider?.(env)
    ?? new OpenAIEmbeddingProvider(openAIEmbeddingConfigFromEnv(env));
  return {
    config,
    service: new KnowledgeService(
      new PostgresKnowledgeRepository(database),
      embeddingProvider,
      config,
    ),
  };
}
