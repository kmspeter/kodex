import type { PoolClient } from 'pg';
import type { ProductDatabase } from './database.js';
import { DataLifecycleError } from './data-lifecycle-types.js';

interface JsonValueRow {
  value: unknown;
}

async function boundedRows(
  client: PoolClient,
  sql: string,
  userId: string,
  maximum: number,
): Promise<unknown[]> {
  const result = await client.query<JsonValueRow>(sql, [userId, maximum + 1]);
  if (result.rows.length > maximum) throw new DataLifecycleError('export_limit');
  return result.rows.map((row) => row.value);
}

export async function buildBoundedUserExport(
  database: ProductDatabase,
  userId: string,
  maximumRowsPerCategory: number,
  maximumBytes: number,
): Promise<{ document: unknown; sizeBytes: number }> {
  if (!Number.isSafeInteger(maximumRowsPerCategory) || maximumRowsPerCategory < 1) {
    throw new Error('Export row bound must be a positive integer.');
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1_024 || maximumBytes > 16_777_216) {
    throw new Error('Export byte bound must be between 1 KiB and 16 MiB.');
  }
  return database.transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const userResult = await client.query<JsonValueRow>(
      `SELECT jsonb_build_object(
         'id', id, 'email', email, 'displayName', display_name,
         'status', status, 'emailVerifiedAt', email_verified_at,
         'createdAt', created_at, 'updatedAt', updated_at
       ) AS value
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!userResult.rows[0]) throw new DataLifecycleError('not_found');

    const categories: Record<string, unknown[]> = {};
    categories.workspaces = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', w.id, 'slug', w.slug, 'name', w.name, 'role', wm.role,
        'archivedAt', w.deleted_at, 'createdAt', w.created_at, 'updatedAt', w.updated_at
      ) AS value
      FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = $1 ORDER BY w.created_at, w.id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.projects = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'name', name, 'externalKey', external_key,
        'status', status, 'createdAt', created_at, 'updatedAt', updated_at
      ) AS value
      FROM projects WHERE created_by_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.threads = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'projectId', project_id,
        'codexThreadId', codex_thread_id, 'title', title, 'status', status,
        'createdAt', created_at, 'updatedAt', updated_at, 'sourceUpdatedAt', source_updated_at
      ) AS value
      FROM agent_threads WHERE created_by_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.turns = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'threadId', thread_id,
        'codexTurnId', codex_turn_id, 'ordinal', ordinal, 'status', status,
        'startedAt', started_at, 'completedAt', completed_at,
        'createdAt', created_at, 'updatedAt', updated_at
      ) AS value
      FROM agent_turns WHERE created_by_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.items = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'turnId', turn_id,
        'codexItemId', codex_item_id, 'sequence', sequence, 'itemType', item_type,
        'role', role, 'payload', payload, 'lifecycleStatus', lifecycle_status,
        'startedAt', started_at, 'completedAt', completed_at,
        'createdAt', created_at, 'updatedAt', updated_at
      ) AS value
      FROM agent_items WHERE created_by_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.events = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'threadId', thread_id,
        'turnId', turn_id, 'itemId', item_id, 'eventType', event_type,
        'sequence', sequence, 'payload', payload, 'occurredAt', occurred_at,
        'ingestedAt', ingested_at
      ) AS value
      FROM agent_events WHERE created_by_user_id = $1 ORDER BY occurred_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.toolCalls = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'threadId', thread_id,
        'turnId', turn_id, 'itemId', item_id, 'codexCallId', codex_call_id,
        'toolName', tool_name, 'status', status, 'arguments', arguments, 'result', result,
        'requestedAt', requested_at, 'startedAt', started_at, 'completedAt', completed_at
      ) AS value
      FROM tool_calls WHERE created_by_user_id = $1 ORDER BY requested_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.approvals = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'threadId', thread_id,
        'turnId', turn_id, 'toolCallId', tool_call_id, 'codexRequestId', codex_request_id,
        'approvalType', approval_type, 'status', status,
        'requestPayload', request_payload, 'responsePayload', response_payload,
        'requestedAt', requested_at, 'resolvedAt', resolved_at
      ) AS value
      FROM approvals WHERE created_by_user_id = $1 ORDER BY requested_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.knowledgeSources = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'projectId', project_id,
        'sourceType', source_type, 'externalKey', external_key, 'name', name,
        'status', status, 'lastSyncedAt', last_synced_at,
        'createdAt', created_at, 'updatedAt', updated_at
      ) AS value
      FROM knowledge_sources WHERE created_by_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.documents = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'sourceId', source_id,
        'sourceDocumentId', source_document_id, 'title', title, 'mimeType', mime_type,
        'contentText', content_text, 'sourceUpdatedAt', source_updated_at,
        'createdAt', created_at, 'updatedAt', updated_at
      ) AS value
      FROM documents WHERE created_by_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.documentChunks = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'documentId', document_id,
        'chunkIndex', chunk_index, 'content', content, 'tokenCount', token_count,
        'embeddingModel', embedding_model, 'embeddingDimensions', embedding_dimensions,
        'createdAt', created_at, 'updatedAt', updated_at
      ) AS value
      FROM document_chunks WHERE created_by_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.retrievalRuns = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'threadId', thread_id, 'turnId', turn_id,
        'query', query, 'embeddingModel', embedding_model, 'embeddingDimensions', embedding_dimensions,
        'parameters', parameters, 'status', status, 'errorCode', error_code,
        'startedAt', started_at, 'completedAt', completed_at
      ) AS value
      FROM retrieval_runs WHERE created_by_user_id = $1 ORDER BY started_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.retrievalCitations = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'retrievalRunId', retrieval_run_id,
        'chunkId', chunk_id, 'rank', rank, 'score', score,
        'quotedText', quoted_text, 'metadata', metadata, 'createdAt', created_at
      ) AS value
      FROM retrieval_citations WHERE created_by_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);
    categories.audit = await boundedRows(client, `
      SELECT jsonb_build_object(
        'id', id, 'workspaceId', workspace_id, 'action', action,
        'targetType', target_type, 'createdAt', created_at
      ) AS value
      FROM audit_logs WHERE actor_user_id = $1 ORDER BY created_at, id LIMIT $2`, userId, maximumRowsPerCategory);

    const document = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      user: userResult.rows[0].value,
      data: categories,
      exclusions: [
        'password_credentials',
        'auth_sessions',
        'password_reset_requests',
        'workspace_invitation_tokens',
        'product_abuse_rate_limits',
        'embedding_vectors',
        'provider_credentials',
        'local_tenant_files',
      ],
    };
    const sizeBytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
    if (sizeBytes > maximumBytes) throw new DataLifecycleError('export_limit');
    return { document, sizeBytes };
  });
}
