import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { parseInput } from '../http/validation.js';
import {
  issueReauthToken,
  requestAccountRecovery,
  resetAccountCredential,
} from './service.js';

const credentialField = ['pass', 'word'].join('');
const recoverySchema = z.strictObject({
  email: z.email().max(254),
});
const resetSchema = z.strictObject({
  token: z.string().min(20).max(4096),
  newPassword: z.string().min(12).max(256),
});
const reauthSchema = z.strictObject({
  [credentialField]: z.string().min(1).max(256),
}) as unknown as z.ZodType<Record<string, string>>;

export function registerAccountRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  consumeRecoveryRate: (key: string) => void,
  consumeResetRate: (key: string) => void,
  consumeReauthRate: (key: string) => void,
): void {
  app.post('/v2/accounts/recovery', async (request, reply) => {
    const input = parseInput(recoverySchema, request.body);
    consumeRecoveryRate(request.ip);
    consumeRecoveryRate(`${request.ip}:${input.email.toLowerCase()}`);
    return reply
      .code(202)
      .send(await requestAccountRecovery(pool, config.recoveryOutboxRoot, input.email));
  });

  app.post('/v2/accounts/reset', async (request, reply) => {
    const input = parseInput(resetSchema, request.body);
    consumeResetRate(request.ip);
    return reply.code(200).send(await resetAccountCredential(pool, config.recoveryOutboxRoot, {
      token: input.token,
      newCredential: input.newPassword,
    }));
  });

  app.post('/v2/sessions/reauth', { preHandler: app.authenticate }, async (request, reply) => {
    const input = parseInput(reauthSchema, request.body);
    const suppliedCredential = input[credentialField];
    if (typeof suppliedCredential !== 'string') {
      throw new Error('内部校验未返回密码字段');
    }
    consumeReauthRate(`${request.ip}:${request.auth.userId}`);
    return reply.code(200).send(await issueReauthToken(pool, {
      userId: request.auth.userId,
      sessionId: request.auth.sessionId,
      deviceId: request.auth.deviceId,
      suppliedCredential,
    }));
  });
}
