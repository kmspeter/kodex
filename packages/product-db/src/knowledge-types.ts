export interface KnowledgeScope {
  userId: string;
  workspaceId: string;
}

export interface KnowledgeSourceRecord {
  createdAt: Date;
  id: string;
  name: string;
  sourceType: string;
  status: 'pending' | 'syncing' | 'ready' | 'failed' | 'disabled';
  updatedAt: Date;
}

export interface KnowledgeDocumentRecord {
  createdAt: Date;
  id: string;
  sourceId: string;
  sourceType: string;
  title: string | null;
  updatedAt: Date;
}

export interface KnowledgeDocumentPage {
  data: KnowledgeDocumentRecord[];
  nextCursor?: string;
}

export interface RetrievalCitation {
  chunkId: string;
  content: string;
  documentId: string;
  documentTitle: string | null;
  rank: number;
  score: number;
  sourceType: string;
}

export interface RetrievalResult {
  citations: RetrievalCitation[];
  runId: string;
}

export type RagFailureCode =
  | 'configuration'
  | 'provider_rejected'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_invalid_response'
  | 'database_error'
  | 'unknown';

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  embed(inputs: readonly string[]): Promise<number[][]>;
}

export class KnowledgeNotFoundError extends Error {
  constructor() {
    super('Knowledge resource was not found.');
    this.name = 'KnowledgeNotFoundError';
  }
}

export class KnowledgeCursorError extends Error {
  constructor() {
    super('Knowledge cursor is invalid.');
    this.name = 'KnowledgeCursorError';
  }
}

export class KnowledgeOperationError extends Error {
  constructor(readonly code: RagFailureCode, message = 'Knowledge operation could not be completed.') {
    super(message);
    this.name = 'KnowledgeOperationError';
  }
}
