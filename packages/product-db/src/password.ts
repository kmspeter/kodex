import { argon2id, hash, needsRehash, verify } from 'argon2';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  needsRehash(encodedHash: string): boolean;
  verify(encodedHash: string, password: string): Promise<boolean>;
}

export const argon2idParameters = Object.freeze({
  hashLength: 32,
  memoryCost: 19_456,
  parallelism: 1,
  timeCost: 2,
  type: argon2id,
});

export class Argon2idPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return hash(password, argon2idParameters);
  }

  needsRehash(encodedHash: string): boolean {
    return needsRehash(encodedHash, argon2idParameters);
  }

  async verify(encodedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(encodedHash, password);
    } catch {
      // A malformed or unsupported stored credential is authentication failure, not
      // an opportunity to expose hash parser details through the API.
      return false;
    }
  }
}
