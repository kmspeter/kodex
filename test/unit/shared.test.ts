import { describe, expect, it } from 'vitest';
import { JsonlDecoder, redactSecrets, SequenceBuffer } from '@kodex/shared';

describe('shared protocol utilities', () => {
  it('parses partial and multiple JSONL frames without duplicating data', () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"id":1}\n{"id"')).toEqual(['{"id":1}']);
    expect(decoder.push(':2}\r\n\n')).toEqual(['{"id":2}']);
    expect(decoder.flush()).toEqual([]);
  });

  it('replays only later sequence values and reports the retained boundary', () => {
    const buffer = new SequenceBuffer<string>(2);
    buffer.push('one');
    buffer.push('two');
    buffer.push('three');
    expect(buffer.oldestSequence).toBe(2);
    expect(buffer.after(2).map((entry) => entry.value)).toEqual(['three']);
  });

  it('masks explicit keys, bearer tokens, and API-key shaped strings', () => {
    const key = 'sk-test-abcdefghijklmnop';
    const masked = redactSecrets(`Authorization: Bearer abc.def ${key}`, [key]);
    expect(masked).not.toContain(key);
    expect(masked).not.toContain('abc.def');
    expect(masked).toContain('[REDACTED]');
  });
});
