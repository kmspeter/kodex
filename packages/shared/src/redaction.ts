const SECRET_PATTERNS = [
  /\b(?:sk|sess|proj)-[A-Za-z0-9_-]{8,}\b/giu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu,
  /("?(?:api[_-]?key|token|secret|authorization)"?\s*[:=]\s*)"?[^\s",}]+"?/giu,
];

export function redactSecrets(value: string, explicitSecrets: readonly string[] = []): string {
  let output = [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === '\n' || character === '\r' || character === '\t' || (code >= 32 && code !== 127);
  }).join('');
  output = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu'), '');
  for (const secret of explicitSecrets) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '$1[REDACTED]');
  return output;
}

export function sanitizeUnknown<T>(value: T, explicitSecrets: readonly string[] = []): T {
  if (typeof value === 'string') return redactSecrets(value, explicitSecrets) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeUnknown(entry, explicitSecrets)) as T;
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const credentialField = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization|password|credential)$/iu.test(key);
      clean[key] = credentialField ? '[REDACTED]' : sanitizeUnknown(entry, explicitSecrets);
    }
    return clean as T;
  }
  return value;
}
