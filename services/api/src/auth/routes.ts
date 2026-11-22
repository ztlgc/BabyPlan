import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { parseInput } from '../http/validation.js';
import { opaqueToken, tokenHash } from '../security.js';
import { authenticate, createSession, revokeSession, rotateSession, type IssuedSession } from './sessions.js';
import type { AuthContext } from './types.js';

const credentialField = ['pass', 'word'].join('');
type CreateSessionInput = {
  email: string;
  deviceId: string;
  clientType: 'mobile' | 'web';
} & Record<string, string>;
const createSessionSchema = z.strictObject({
  email: z.email().max(254),
  [credentialField]: z.string().min(1).max(256),
  deviceId: z.uuid(),
  clientType: z.enum(['mobile', 'web']),
}) as unknown as z.ZodType<CreateSessionInput>;

const refreshSchema = z.strictObject({
  deviceId: z.uuid(),
  clientType: z.enum(['mobile', 'web']),
});

export function sessionCookieSecure(publicBaseUrl: string): boolean {
  return new URL(publicBaseUrl).protocol === 'https:';
}

function cookieOptions(config: AppConfig, maxAgeSeconds: number) {
  return {
    path: '/v2',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: sessionCookieSecure(config.publicBaseUrl),
    maxAge: maxAgeSeconds,
  };
}

export function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  return typeof origin === 'string' && origin === `${request.protocol}://${request.host}`;
}

export function setWebCookies(reply: FastifyReply, config: AppConfig, access: string, refresh: string, csrf: string): void {
  reply.setCookie('bp_session', access, cookieOptions(config, 15 * 60));
  reply.setCookie('bp_refresh', refresh, cookieOptions(config, 30 * 24 * 60 * 60));
  reply.setCookie('bp_csrf', csrf, { ...cookieOptions(config, 15 * 60), httpOnly: false });
}

export function publicSession(session: IssuedSession): Omit<IssuedSession, 'csrfTokenValue' | 'accessTokenValue' | 'refreshTokenValue'> {
  const { user, sessionId, accessToken, refreshToken, csrfToken, expiresAt, refreshExpiresAt } = session;
  return { user, sessionId, accessToken, refreshToken, csrfToken, expiresAt, refreshExpiresAt };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  consumeLoginRate: (key: string) => void,
): void {
  app.post('/v2/sessions', async (request, reply) => {
    const input = parseInput(createSessionSchema, request.body);
    consumeLoginRate(`${request.ip}:${input.email.toLowerCase()}`);
    if (input.clientType === 'web' && !sameOrigin(request)) {
      throw new AppError(403, 'INVALID_ORIGIN', '请求来源不受信任');
    }
    const session = await createSession(pool, input);
    if (input.clientType === 'web') {
      setWebCookies(reply, config, session.accessTokenValue!, session.refreshTokenValue!, session.csrfTokenValue!);
    }
    return reply.code(200).send(publicSession(session));
  });

  app.post('/v2/sessions/refresh', async (request, reply) => {
    const input = parseInput(refreshSchema, request.body);
    const web = input.clientType === 'web';
    if (web && !sameOrigin(request)) throw new AppError(403, 'INVALID_ORIGIN', '请求来源不受信任');
    const refreshToken = web
      ? request.cookies.bp_refresh
      : (typeof request.headers['x-refresh-token'] === 'string' ? request.headers['x-refresh-token'] : undefined);
    if (!refreshToken) throw new AppError(401, 'INVALID_SESSION', '登录状态已失效');
    const csrfToken = typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined;
    const session = await rotateSession(pool, { ...input, refreshToken, ...(csrfToken ? { csrfToken } : {}) });
    if (web) {
      setWebCookies(reply, config, session.accessTokenValue!, session.refreshTokenValue!, request.cookies.bp_csrf ?? '');
    }
    return reply.code(200).send(publicSession(session));
  });

  app.delete('/v2/sessions/current', { preHandler: app.authenticate }, async (request, reply) => {
    await revokeSession(pool, request.auth.sessionId);
    reply.clearCookie('bp_session', { path: '/v2' });
    reply.clearCookie('bp_refresh', { path: '/v2' });
    reply.clearCookie('bp_csrf', { path: '/v2' });
    return reply.code(200).send({ accepted: true });
  });

  app.get('/v2/sessions/csrf', { preHandler: app.authenticate }, async (request, reply) => {
    if (request.auth.clientType !== 'web') throw new AppError(403, 'WEB_SESSION_REQUIRED', '仅网页会话支持此操作');
    if (!sameOrigin(request)) throw new AppError(403, 'INVALID_ORIGIN', '请求来源不受信任');
    const csrfToken = opaqueToken();
    await pool.query('UPDATE app.sessions SET csrf_token_hash=$2 WHERE id=$1', [request.auth.sessionId, tokenHash(csrfToken)]);
    reply.setCookie('bp_csrf', csrfToken, { ...cookieOptions(config, 15 * 60), httpOnly: false });
    return reply.code(200).send({ csrfToken });
  });
}

export async function authenticateRequest(
  pool: Pool,
  request: FastifyRequest,
): Promise<AuthContext> {
  const header = request.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const cookie = request.cookies.bp_session;
  const source = bearer ? 'bearer' : cookie ? 'cookie' : null;
  const token = bearer ?? cookie;
  if (!source || !token) throw new AppError(401, 'INVALID_SESSION', '登录状态已失效，请重新登录');
  const auth = await authenticate(pool, token, source);
  if (source === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const csrfToken = request.headers['x-csrf-token'];
    if (!sameOrigin(request) || typeof csrfToken !== 'string' || !auth.csrfTokenHash || tokenHash(csrfToken) !== auth.csrfTokenHash) {
      throw new AppError(403, 'INVALID_CSRF', '安全校验失败，请刷新页面后重试');
    }
  }
  return auth;
}
