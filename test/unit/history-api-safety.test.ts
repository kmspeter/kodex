import { PRODUCT_HISTORY_PREVIEW_CHARACTERS } from '@kodex/product-contract';
import { describe, expect, it } from 'vitest';
import { publicHistoryPreview } from '../../apps/api/src/server';

describe('saved history API preview boundary', () => {
  it('omits nested internal/RAG fields and redacts nested secret fields and secret text', () => {
    const preview = publicHistoryPreview({
      safe: 'visible',
      nested: {
        sourceInstance: 'worker-internal',
        'source-event-id': 'event-internal',
        contentChecksum: 'checksum-internal',
        embeddingVector: [0.1, 0.2],
        ragMetadata: { documentId: 'rag-internal' },
        databaseId: 'db-internal',
        sessionToken: 'session-internal',
        headers: 'Authorization: Bearer sk-browser-secret-value',
        endpoint: 'https://username:password@example.test/private',
      },
    });
    expect(preview.content).toContain('visible');
    for (const forbidden of [
      'worker-internal', 'event-internal', 'checksum-internal', 'embeddingVector',
      'ragMetadata', 'rag-internal', 'db-internal', 'session-internal',
      'sk-browser-secret-value', 'username:password',
    ]) expect(preview.content).not.toContain(forbidden);
    expect(preview.content).toContain('[redacted]');
    expect(preview.truncated).toBe(true);
  });

  it('handles circular, deep, wide, bigint, and long input within the DTO bound', () => {
    const circular: Record<string, unknown> = { value: 1n };
    circular.self = circular;
    const circularPreview = publicHistoryPreview(circular);
    expect(circularPreview.content).toContain('[circular reference]');
    expect(circularPreview.truncated).toBe(true);

    const preview = publicHistoryPreview({
      long: '가'.repeat(10_000),
      deep: { one: { two: { three: { four: { five: { six: 'hidden' } } } } } },
      wide: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`field${index}`, index])),
    });
    expect(preview.truncated).toBe(true);
    expect(preview.content.length).toBeLessThanOrEqual(PRODUCT_HISTORY_PREVIEW_CHARACTERS);
  });
});
