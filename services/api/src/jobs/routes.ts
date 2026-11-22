import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { parseInput } from '../http/validation.js';
import { getJob } from './service.js';

const jobParams = z.strictObject({ jobId: z.uuid() });

export function registerJobRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/v2/jobs/:jobId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(jobParams, request.params);
    return getJob(pool, request.auth.userId, params.jobId);
  });
}
