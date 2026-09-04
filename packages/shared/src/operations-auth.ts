import { timingSafeEqual } from 'node:crypto';

const TOKEN_MINIMUM_CHARACTERS = 32;
const TOKEN_MAXIMUM_CHARACTERS = 512;

export function operationsBearerTokenFromEnv(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  const hasUnsafeCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 || /\s/u.test(character);
  });
  if (
    value.length < TOKEN_MINIMUM_CHARACTERS
    || value.length > TOKEN_MAXIMUM_CHARACTERS
    || hasUnsafeCharacter
  ) {
    throw new Error(`${name} must be a 32 to 512 character secret without whitespace or control characters.`);
  }
  return value;
}

export function verifyOperationsBearer(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const prefix = 'Bearer ';
  const supplied = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedToken);
  return suppliedBuffer.length === expectedBuffer.length
    && timingSafeEqual(suppliedBuffer, expectedBuffer);
}
