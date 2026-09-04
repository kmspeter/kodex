import { redactSecrets } from '@kodex/shared';
import path from 'node:path';

const SENSITIVE_FIELD = /(?:authorization|cookie|credential|password|passphrase|secret|token|api.?key|private.?key|encrypted)/iu;
const SENSITIVE_HEADER = /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n]+/giu;
const SECRET_ASSIGNMENT = /\b(?:OPENAI_API_KEY|DATABASE_URL|AUTH_COOKIE_SECRET|PASSWORD|TOKEN|SECRET)\s*=\s*[^\s,;]+/giu;
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const PATH_FIELD = /^(?:cwd|path)$/iu;

export interface HistorySanitizeLimits {
  maxArrayEntries: number;
  maxDepth: number;
  maxObjectEntries: number;
  maxStringLength: number;
}

export const defaultHistorySanitizeLimits: HistorySanitizeLimits = {
  maxArrayEntries: 100,
  maxDepth: 8,
  maxObjectEntries: 100,
  maxStringLength: 8_192,
};

function cleanString(value: string, limit: number): string {
  const redacted = redactSecrets(value)
    .replace(SENSITIVE_HEADER, (match) => `${match.slice(0, match.indexOf(':') + 1)} [REDACTED]`)
    .replace(SECRET_ASSIGNMENT, (match) => `${match.slice(0, match.indexOf('=') + 1)}[REDACTED]`)
    .replace(URI_CREDENTIALS, '$1[REDACTED]@');
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit)}…[TRUNCATED]`;
}

export function sanitizeHistoryValue(
  value: unknown,
  limits: HistorySanitizeLimits = defaultHistorySanitizeLimits,
  depth = 0,
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return cleanString(value, limits.maxStringLength);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return '[OMITTED]';
  }
  if (depth >= limits.maxDepth) return '[DEPTH_LIMIT]';
  if (Array.isArray(value)) {
    const entries = value.slice(0, limits.maxArrayEntries)
      .map((entry) => sanitizeHistoryValue(entry, limits, depth + 1));
    if (value.length > limits.maxArrayEntries) entries.push('[ARRAY_TRUNCATED]');
    return entries;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return '[BINARY_REDACTED]';
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, limits.maxObjectEntries);
    for (const [rawKey, entry] of entries) {
      const key = cleanString(rawKey, 128);
      output[key] = SENSITIVE_FIELD.test(rawKey)
        ? '[REDACTED]'
        : PATH_FIELD.test(rawKey) && typeof entry === 'string' && path.isAbsolute(entry)
          ? '[ABSOLUTE_PATH_REDACTED]'
        : sanitizeHistoryValue(entry, limits, depth + 1);
    }
    if (Object.keys(value).length > limits.maxObjectEntries) {
      output.__truncated__ = '[OBJECT_TRUNCATED]';
    }
    return output;
  }
  return '[OMITTED]';
}

export function sanitizedRecordWithinBytes<T extends Record<string, unknown>>(
  value: T,
  maxBytes: number,
): T {
  const sanitized = sanitizeHistoryValue(value) as T;
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') <= maxBytes) return sanitized;
  const compact = { ...sanitized } as Record<string, unknown>;
  if ('payload' in compact) compact.payload = { truncated: true, reason: 'event_size_limit' };
  if ('item' in compact && compact.item && typeof compact.item === 'object') {
    compact.item = {
      ...(compact.item as Record<string, unknown>),
      payload: { truncated: true, reason: 'event_size_limit' },
    };
  }
  if ('toolCall' in compact && compact.toolCall && typeof compact.toolCall === 'object') {
    compact.toolCall = {
      ...(compact.toolCall as Record<string, unknown>),
      arguments: { truncated: true, reason: 'event_size_limit' },
      result: { truncated: true, reason: 'event_size_limit' },
    };
  }
  if ('approval' in compact && compact.approval && typeof compact.approval === 'object') {
    compact.approval = {
      ...(compact.approval as Record<string, unknown>),
      requestPayload: { truncated: true, reason: 'event_size_limit' },
      responsePayload: { truncated: true, reason: 'event_size_limit' },
    };
  }
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') > maxBytes) {
    throw new Error('Sanitized history event exceeds its configured size limit.');
  }
  return compact as T;
}
