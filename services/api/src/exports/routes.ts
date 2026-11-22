import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { parseInput } from '../http/validation.js';
import type { LocalPrivateMediaStorage } from '../media/storage.js';
import {
  createExport,
  getExport,
  processExport,
  readSignedExport,
} from './service.js';

const familyParam = z.strictObject({ familyId: z.uuid() });
const exportParam = z.strictObject({ exportId: z.uuid() });
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const createExportSchema = z.strictObject({
  operationId: z.uuid(),
  from: dateString,
  to: dateString,
  types: z.array(z.enum(['memories', 'measurements', 'sessions', 'plans'])).min(1).max(4),
  includeMedia: z.boolean(),
});
const signedQuery = z.strictObject({ token: z.string().min(20).max(512) });

export function registerExportRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  storage: LocalPrivateMediaStorage,
): void {
  app.post('/v2/families/:familyId/exports', {
    preHandler: [app.authenticate, app.requireFamilyRole('params', ['owner'])],
  }, async (request, reply) => {
    const params = parseInput(familyParam, request.params);
    const body = parseInput(createExportSchema, request.body);
    const created = await createExport(
      pool,
      request.auth.userId,
      request.auth.deviceId,
      params.familyId,
      body,
    );
    setImmediate(() => {
      void processExport(pool, storage, created.id, params.familyId).catch(error => {
        app.log.error({ event: 'export_processing_dispatch_failed', code: error instanceof Error ? error.name : 'UNKNOWN' });
      });
    });
    return reply.code(202).send(created);
  });

  app.get('/v2/exports/:exportId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(exportParam, request.params);
    return getExport(pool, config, request.auth.userId, params.exportId);
  });

  app.get('/v2/exports/:exportId/content', async (request, reply) => {
    const params = parseInput(exportParam, request.params);
    const query = parseInput(signedQuery, request.query);
    const bytes = await readSignedExport(pool, storage, params.exportId, query.token);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="babyplan-${params.exportId}.zip"`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(bytes);
  });
}
