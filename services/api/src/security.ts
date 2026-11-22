import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { AppError } from './errors.js';

const argonOptions = {
  algorithm: 2,
  version: 1,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(credentialText: string): Promise<string> {
  return hash(credentialText, argonOptions);
}

export async function verifyPassword(credentialText: string, encodedHash: string): Promise<boolean> {
  try {
    return await verify(encodedHash, credentialText, { algorithm: 2, version: 1 });
  } catch {
    throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
  }
}
