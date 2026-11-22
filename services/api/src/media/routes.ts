import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { parseInput } from '../http/validation.js';
import type { LocalPrivateMediaStorage } from './storage.js';
import {
  acceptUploadedBytes,
  completeMediaUpload,
  createMediaUpload,
  deleteMedia,
  getMedia,
  readSignedMedia,
} from './service.js';

const mediaParam = z.strictObject({ mediaId: z.uuid() });
const uploadParam = z.strictObject({ token: z.string().min(20).max(512) });
const createUploadSchema = z.strictObject({
  operationId: z.uuid(),
  memoryId: z.uuid(),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  byteSize: z.number().int().min(1).max(20 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const operationSchema = z.strictObject({ operationId: z.uuid() });
const signedQuery = z.strictObject({ token: z.string().min(20).max(512) });

export function registerMediaRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
  storage: LocalPrivateMediaStorage,
  journal: DeletionJournal | null,
  onDeletion: (event: DeletionEvent) => void,
): void {
  app.post('/v2/media/uploads', { preHandler: app.authenticate }, async (request, reply) => {
    const body = parseInput(createUploadSchema, request.body);
    const result = await createMediaUpload(
      pool,
      config,
      request.auth,
      body,
    );
    return reply.code(201).send(result);
  });

  app.put('/v2/media/upload-targets/:token', {
    bodyLimit: 20 * 1024 * 1024,
  }, async (request, reply) => {
    const params = parseInput(uploadParam, request.params);
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(422).send({ code: 'INVALID_IMAGE', message: '上传请求必须包含照片内容' });
    }
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string') {
      return reply.code(422).send({ code: 'INVALID_IMAGE_TYPE', message: '缺少照片类型' });
    }
    await acceptUploadedBytes(pool, storage, params.token, contentType, request.body);
    return reply.code(204).send();
  });

  app.post('/v2/media/:mediaId/complete', { preHandler: app.authenticate }, async (request, reply) => {
    const params = parseInput(mediaParam, request.params);
    const body = parseInput(operationSchema, request.body);
    const media = await completeMediaUpload(
      pool,
      storage,
      request.auth.userId,
      request.auth.deviceId,
      params.mediaId,
      body.operationId,
    );
    return reply.code(202).send(media);
  });

  app.get('/v2/media/:mediaId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(mediaParam, request.params);
    return getMedia(pool, config, request.auth, params.mediaId);
  });

  app.get('/v2/media/:mediaId/content', async (request, reply) => {
    const params = parseInput(mediaParam, request.params);
    const query = parseInput(signedQuery, request.query);
    const media = await readSignedMedia(pool, storage, params.mediaId, query.token);
    reply.header('Content-Type', media.mime);
    reply.header('Content-SHA256', media.sha256);
    reply.header('Content-Disposition', `inline; filename="${params.mediaId}"`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(media.bytes);
  });

  app.delete('/v2/media/:mediaId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(mediaParam, request.params);
    const body = parseInput(operationSchema, request.body);
    return deleteMedia(
      pool,
      journal,
      onDeletion,
      request.auth.userId,
      request.auth.deviceId,
      params.mediaId,
      body.operationId,
    );
  });
}
import type { DeletionEvent, DeletionJournal } from '../jobs/deletion-journal.js';
