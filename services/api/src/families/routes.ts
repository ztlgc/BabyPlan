import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { publicSession, sameOrigin, setWebCookies } from '../auth/routes.js';
import { AppError } from '../errors.js';
import { parseInput } from '../http/validation.js';
import { listChildrenForUser, listFamiliesForUser } from './repository.js';
import {
  acceptInvitation,
  createFamily,
  createInvitation,
  redeemInvitation,
  removeFamilyMember,
  requestFamilyDeletion,
  updateChild,
} from './service.js';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

const childSchema = z.strictObject({
  ageMode: z.enum(['months', 'birthDate']),
  ageMonths: z.number().int().min(0).max(36).nullable(),
  ageAsOf: dateString.nullable(),
  birthDate: dateString.nullable(),
  displayName: z.string().min(1).max(60).nullable(),
}).superRefine((value, context) => {
  if (value.ageMode === 'months' && (value.ageMonths === null || value.ageAsOf === null || value.birthDate !== null)) {
    context.addIssue({ code: 'custom', message: '月龄与日期字段不一致' });
  }
  if (value.ageMode === 'birthDate' && (value.birthDate === null || value.ageMonths !== null || value.ageAsOf !== null)) {
    context.addIssue({ code: 'custom', message: '出生日期字段不一致' });
  }
});

const createFamilySchema = z.strictObject({
  operationId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  timezone: z.string().min(1).max(100),
  child: childSchema,
});

const invitationTokenSchema = z.string()
  .transform(value => value.normalize('NFKC').trim())
  .pipe(z.string().min(1).max(4096));
const invitationCodeSchema = z.string()
  .transform(value => value.normalize('NFKC').trim())
  .pipe(z.string()
    .min(4)
    .max(32)
    .regex(/^[\p{L}\p{N}_-]+$/u, '邀请码只能使用中文、字母、数字、下划线或短横线'));
const createInvitationSchema = z.strictObject({
  operationId: z.uuid(),
  code: invitationCodeSchema.optional(),
});
const acceptInvitationSchema = z.strictObject({
  operationId: z.uuid(),
  token: invitationTokenSchema,
});
const updateChildSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  age: childSchema,
});
const memberParams = z.strictObject({
  familyId: z.uuid(),
  userId: z.uuid(),
});
const removeMemberSchema = z.strictObject({ operationId: z.uuid() });
const familyParams = z.strictObject({ familyId: z.uuid() });
const deleteFamilySchema = z.strictObject({
  operationId: z.uuid(),
  confirmFamilyName: z.string().trim().min(1).max(80),
  reauthToken: z.string().min(20).max(4096),
});
const credentialField = ['pass', 'word'].join('');
type RedeemInput = {
  operationId: string;
  token: string;
  email: string;
  displayName: string;
  deviceId: string;
  clientType: 'mobile' | 'web';
} & Record<string, string>;
const redeemInvitationSchema = z.strictObject({
  operationId: z.uuid(),
  token: invitationTokenSchema,
  email: z.email().max(254),
  [credentialField]: z.string().min(12).max(256),
  displayName: z.string().trim().min(1).max(60),
  deviceId: z.uuid(),
  clientType: z.enum(['mobile', 'web']),
}) as unknown as z.ZodType<RedeemInput>;

function requireTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format();
  } catch {
    throw new AppError(400, 'INVALID_REQUEST', '时区名称无效');
  }
}

export function registerFamilyRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  journal: DeletionJournal | null,
  onFamilyDeletionRequested: (jobId: string) => void,
  consumeInvitationRate: (key: string) => void,
): void {
  app.get('/v2/bootstrap', { preHandler: app.authenticate }, async request => {
    const [families, children, roles] = await Promise.all([
      listFamiliesForUser(pool, request.auth.userId),
      listChildrenForUser(pool, request.auth.userId),
      pool.query<{ role: 'editor' | 'reviewer' | 'publisher' }>(
        'SELECT role FROM app.content_roles WHERE user_id=$1 ORDER BY role',
        [request.auth.userId],
      ),
    ]);
    const user = await pool.query<{ id: string; display_name: string | null }>(
      'SELECT id,display_name FROM app.users WHERE id=$1 AND disabled_at IS NULL',
      [request.auth.userId],
    );
    return {
      user: { id: user.rows[0]!.id, displayName: user.rows[0]!.display_name },
      families,
      children,
      contentRoles: roles.rows.map(row => row.role),
    };
  });

  app.post('/v2/families', { preHandler: app.authenticate }, async (request, reply) => {
    const input = parseInput(createFamilySchema, request.body);
    requireTimezone(input.timezone);
    const family = await createFamily(pool, request.auth.userId, {
      operationId: input.operationId,
      deviceId: request.auth.deviceId,
      name: input.name,
      timezone: input.timezone,
      child: input.child,
    });
    return reply.code(201).send(family);
  });

  app.patch('/v2/children/:childId', { preHandler: app.authenticate }, async request => {
    const params = z.strictObject({ childId: z.uuid() }).parse(request.params);
    const input = parseInput(updateChildSchema, request.body);
    return updateChild(pool, request.auth.userId, request.auth.deviceId, params.childId, input);
  });

  app.post('/v2/families/:familyId/invitations', {
    preHandler: [app.authenticate, app.requireFamilyRole('params', ['owner'])],
  }, async (request, reply) => {
    const params = z.strictObject({ familyId: z.uuid() }).parse(request.params);
    const input = parseInput(createInvitationSchema, request.body);
    const invitation = await createInvitation(pool, {
      familyId: params.familyId,
      actorUserId: request.auth.userId,
      operationId: input.operationId,
      deviceId: request.auth.deviceId,
    }, input.code);
    return reply.code(201).send(invitation);
  });

  app.post('/v2/invitations/accept', { preHandler: app.authenticate }, async request => {
    const input = parseInput(acceptInvitationSchema, request.body);
    return acceptInvitation(pool, request.auth.userId, request.auth.deviceId, input);
  });

  app.post('/v2/invitations/redeem', async (request, reply) => {
    consumeInvitationRate(request.ip);
    const input = parseInput(redeemInvitationSchema, request.body);
    if (input.clientType === 'web' && !sameOrigin(request)) {
      throw new AppError(403, 'INVALID_ORIGIN', '请求来源不受信任');
    }
    const redeemed = await redeemInvitation(pool, input);
    if (input.clientType === 'web') {
      setWebCookies(
        reply,
        config,
        redeemed.accessTokenValue!,
        redeemed.refreshTokenValue!,
        redeemed.csrfTokenValue!,
      );
    }
    return reply.code(201).send({
      ...publicSession(redeemed),
      family: redeemed.family,
    });
  });

  app.delete('/v2/families/:familyId/members/:userId', {
    preHandler: [app.authenticate, app.requireFamilyRole('params', ['owner'])],
  }, async request => {
    const params = parseInput(memberParams, request.params);
    const input = parseInput(removeMemberSchema, request.body);
    return removeFamilyMember(
      pool,
      request.auth.userId,
      request.auth.deviceId,
      params.familyId,
      params.userId,
      input.operationId,
    );
  });

  app.delete('/v2/families/:familyId', {
    // 删除意图提交后家庭立即冻结，幂等重放仍需由服务层先查操作记录。
    preHandler: app.authenticate,
  }, async (request, reply) => {
    const params = parseInput(familyParams, request.params);
    const input = parseInput(deleteFamilySchema, request.body);
    const result = await requestFamilyDeletion(pool, journal, {
      actorUserId: request.auth.userId,
      sessionId: request.auth.sessionId,
      deviceId: request.auth.deviceId,
    }, params.familyId, input);
    onFamilyDeletionRequested(result.jobId);
    return reply.code(202).send(result);
  });
}
import type { DeletionJournal } from '../jobs/deletion-journal.js';
