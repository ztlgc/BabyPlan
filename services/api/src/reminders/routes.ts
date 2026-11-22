import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { parseInput } from '../http/validation.js';
import { getReminderPreference, putReminderPreference } from './service.js';

const localTime = z.string().regex(/^[01][0-9]:[0-5][0-9]$/);
const reminderWriteSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  deviceId: z.uuid().nullable(),
  enabled: z.boolean(),
  localTime,
});

export function registerReminderRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/v2/users/me/reminder', { preHandler: app.authenticate }, async request => {
    return getReminderPreference(pool, request.auth.userId);
  });

  app.put('/v2/users/me/reminder', { preHandler: app.authenticate }, async request => {
    const body = parseInput(reminderWriteSchema, request.body);
    return putReminderPreference(pool, request.auth.userId, body);
  });
}
