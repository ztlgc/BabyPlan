import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { notFound } from '../errors.js';
import { parseInput } from '../http/validation.js';
import { createFamilySnapshotReader } from './snapshots.js';
import {
  createPlaySession,
  deleteParticipation,
  ensureSevenDays,
  getDay,
  getPreferences,
  listChanges,
  putParticipation,
  putPreferences,
  replacePlanItem,
  setDayMode,
  setPlanItemProtection,
  startPlanItem,
} from './service.js';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const operationSchema = z.strictObject({ operationId: z.uuid() });

const participationSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  status: z.enum(['played', 'skipped']),
  participantIds: z.array(z.uuid()).max(20),
  note: z.string().max(2000),
  actualMinutes: z.number().int().min(0).max(1440).nullable(),
  again: z.boolean(),
});

const playSessionSchema = z.strictObject({
  operationId: z.uuid(),
  id: z.uuid(),
  planItemId: z.uuid().nullable(),
  localDate: dateString,
  activityId: z.string().min(1).max(60),
  activityRevision: z.number().int().min(1),
  participantIds: z.array(z.uuid()).min(1).max(20),
  note: z.string().max(2000),
});

const preferencesSchema = z.strictObject({
  availableMaterials: z.array(z.string().min(1).max(150)).max(200).refine(values => new Set(values).size === values.length),
  excludedMaterials: z.array(z.string().min(1).max(150)).max(200).refine(values => new Set(values).size === values.length),
  languageMode: z.enum(['zh', 'zh_with_english']),
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
});

const dayModeSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  mode: z.enum(['standard', 'lite']),
});

const replaceItemSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  activityId: z.string().min(1).max(60),
  activityRevision: z.number().int().min(1),
});

const itemOperationSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
});

const protectionSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  lockedByParent: z.boolean(),
  clearStarted: z.boolean(),
});

export function registerPlanRoutes(app: FastifyInstance, pool: Pool, config: AppConfig): void {
  const snapshots = createFamilySnapshotReader(pool);
  app.addHook('onClose', async () => snapshots.close());
  app.post('/v2/children/:childId/plans/ensure', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async request => {
    const params = parseInput(z.strictObject({ childId: z.uuid() }), request.params);
    const body = parseInput(operationSchema, request.body);
    const family = await pool.query(`
      SELECT c.family_id FROM app.children c
      JOIN app.family_members m ON m.family_id=c.family_id AND m.user_id=$2 AND m.active
      WHERE c.id=$1 AND c.deleted_at IS NULL
    `, [params.childId, request.auth.userId]);
    if (!family.rows[0]) throw notFound();
    return ensureSevenDays(pool, config.contentEnvironment, {
      familyId: family.rows[0].family_id,
      actorUserId: request.auth.userId,
      operationId: body.operationId,
      deviceId: request.auth.deviceId,
    }, params.childId);
  });

  app.get('/v2/children/:childId/days/:date', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async request => {
    const params = parseInput(z.strictObject({ childId: z.uuid(), date: dateString }), request.params);
    return getDay(pool, request.auth.userId, params.childId, params.date);
  });

  app.put('/v2/plan-items/:itemId/participation', { preHandler: app.authenticate }, async request => {
    const params = parseInput(z.strictObject({ itemId: z.uuid() }), request.params);
    const body = parseInput(participationSchema, request.body);
    return putParticipation(pool, request.auth.userId, request.auth.deviceId, params.itemId, body);
  });

  app.delete('/v2/plan-items/:itemId/participation', { preHandler: app.authenticate }, async request => {
    const params = parseInput(z.strictObject({ itemId: z.uuid() }), request.params);
    const body = parseInput(z.strictObject({ operationId: z.uuid(), baseRevision: z.number().int().min(0) }), request.body);
    return deleteParticipation(pool, request.auth.userId, request.auth.deviceId, params.itemId, body);
  });

  app.put('/v2/days/:dayId/mode', { preHandler: app.authenticate }, async request => {
    const params = parseInput(z.strictObject({ dayId: z.uuid() }), request.params);
    const body = parseInput(dayModeSchema, request.body);
    return setDayMode(pool, request.auth.userId, request.auth.deviceId, params.dayId, body);
  });

  app.post('/v2/plan-items/:itemId/replace', { preHandler: app.authenticate }, async request => {
    const params = parseInput(z.strictObject({ itemId: z.uuid() }), request.params);
    const body = parseInput(replaceItemSchema, request.body);
    return replacePlanItem(
      pool,
      config.contentEnvironment,
      request.auth.userId,
      request.auth.deviceId,
      params.itemId,
      body,
    );
  });

  app.post('/v2/plan-items/:itemId/start', { preHandler: app.authenticate }, async request => {
    const params = parseInput(z.strictObject({ itemId: z.uuid() }), request.params);
    const body = parseInput(itemOperationSchema, request.body);
    return startPlanItem(
      pool,
      request.auth.userId,
      request.auth.deviceId,
      params.itemId,
      body,
    );
  });

  app.put('/v2/plan-items/:itemId/protection', { preHandler: app.authenticate }, async request => {
    const params = parseInput(z.strictObject({ itemId: z.uuid() }), request.params);
    const body = parseInput(protectionSchema, request.body);
    return setPlanItemProtection(
      pool,
      request.auth.userId,
      request.auth.deviceId,
      params.itemId,
      body,
    );
  });

  app.post('/v2/children/:childId/sessions', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async (request, reply) => {
    const params = parseInput(z.strictObject({ childId: z.uuid() }), request.params);
    const body = parseInput(playSessionSchema, request.body);
    const session = await createPlaySession(pool, config.contentEnvironment, request.auth.userId, request.auth.deviceId, params.childId, body);
    return reply.code(201).send(session);
  });

  app.get('/v2/families/:familyId/changes', {
    preHandler: [app.authenticate, app.requireFamilyRole('params')],
  }, async request => {
    const params = parseInput(z.strictObject({ familyId: z.uuid() }), request.params);
    const query = parseInput(z.strictObject({
      cursor: z.string().min(1).max(4096).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }), request.query);
    return listChanges(pool, request.auth.userId, params.familyId, query.cursor, query.limit);
  });

  app.get('/v2/families/:familyId/snapshot', {
    preHandler: [app.authenticate, app.requireFamilyRole('params')],
  }, async request => {
    const params = parseInput(z.strictObject({ familyId: z.uuid() }), request.params);
    const query = parseInput(z.strictObject({
      pageToken: z.string().min(1).max(4096).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }), request.query);
    return snapshots.read(params.familyId, request.auth.userId, query.pageToken, query.limit);
  });

  app.get('/v2/families/:familyId/preferences', {
    preHandler: [app.authenticate, app.requireFamilyRole('params')],
  }, async request => {
    const params = parseInput(z.strictObject({ familyId: z.uuid() }), request.params);
    return getPreferences(pool, request.auth.userId, params.familyId);
  });

  app.put('/v2/families/:familyId/preferences', {
    preHandler: [app.authenticate, app.requireFamilyRole('params')],
  }, async request => {
    const params = parseInput(z.strictObject({ familyId: z.uuid() }), request.params);
    const body = parseInput(preferencesSchema, request.body);
    return putPreferences(pool, request.auth.userId, request.auth.deviceId, params.familyId, body);
  });
}
