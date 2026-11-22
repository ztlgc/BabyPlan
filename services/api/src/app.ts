import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyError, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import { registerAccountRoutes } from './accounts/routes.js';
import { authenticateRequest, registerAuthRoutes } from './auth/routes.js';
import { registerContentRoutes } from './content/routes.js';
import { activeFamilyRole, childFamilyId } from './families/repository.js';
import { registerFamilyRoutes } from './families/routes.js';
import { registerGrowthRoutes } from './growth/routes.js';
import { registerExportRoutes } from './exports/routes.js';
import { createFixedWindowLimiter } from './http/rate-limit.js';
import { registerMediaRoutes } from './media/routes.js';
import { LocalPrivateMediaStorage } from './media/storage.js';
import { resumeQueuedExports } from './exports/service.js';
import { processFamilyDeletion, resumeFamilyDeletionJobs } from './jobs/service.js';
import { registerJobRoutes } from './jobs/routes.js';
import { DeletionJournal, type DeletionEvent, pendingDeletions, prepareJournal } from './jobs/deletion-journal.js';
import { cleanupDeletion, replayJournal } from './jobs/deletions.js';
import { resumeProcessingMedia } from './media/service.js';
import { registerPlanRoutes } from './plans/routes.js';
import { registerReminderRoutes } from './reminders/routes.js';

export function buildApp(config: AppConfig, pool: Pool, logger?: FastifyServerOptions['logger']) {
  const storage = new LocalPrivateMediaStorage(config.mediaRoot);
  const journal = config.deletionJournalRoot ? new DeletionJournal(config.deletionJournalRoot) : null;
  const deletionWork = new Set<Promise<void>>();
  const app = Fastify({
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-refresh-token"]', 'req.body', 'res.headers["set-cookie"]'],
      serializers: {
        req: request => ({ id: request.id, method: request.method }),
        res: response => ({ statusCode: response.statusCode }),
        err: (error: FastifyError) => ({
          type: 'Error',
          message: '内部错误，详细资料不写入请求日志',
          stack: error.stack ?? '',
        }),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    requestTimeout: 15_000,
  });

  app.register(cookie);
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
  app.decorate('authenticate', async request => {
    request.auth = await authenticateRequest(pool, request);
  });
  app.decorate('requireFamilyRole', (source: 'params' | 'child', roles?: ReadonlyArray<'owner' | 'caregiver'>) => async request => {
    let familyId: string;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (source === 'child') {
      const childId = (request.params as { childId?: string }).childId;
      if (!childId || !uuidPattern.test(childId)) throw new AppError(404, 'NOT_FOUND', '内容不存在或当前无法访问');
      familyId = await childFamilyId(pool, childId, request.auth.userId);
    } else {
      const value = (request.params as { familyId?: string }).familyId;
      if (!value || !uuidPattern.test(value)) throw new AppError(404, 'NOT_FOUND', '内容不存在或当前无法访问');
      familyId = value;
    }
    const role = await activeFamilyRole(pool, familyId, request.auth.userId);
    if (!role) throw new AppError(404, 'NOT_FOUND', '内容不存在或当前无法访问');
    if (roles && !roles.includes(role)) throw new AppError(403, 'INSUFFICIENT_ROLE', '当前角色不能执行此操作');
  });

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ event: 'request_complete', method: request.method, route: request.routeOptions.url ?? 'unmatched', statusCode: reply.statusCode });
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message, requestId: request.id, ...(error.details ? { details: error.details } : {}) });
    }
    if ('validation' in error && error.validation) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: '输入格式不正确，请检查后重试', requestId: request.id });
    }
    if (error.statusCode === 413) {
      return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE', message: '提交的内容过大', requestId: request.id });
    }
    if (error.statusCode === 400) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: '请求格式不正确', requestId: request.id });
    }
    request.log.error({ event: 'request_failed', code: 'INTERNAL_ERROR' });
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '暂时无法完成，请稍后重试', requestId: request.id });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: '内容不存在或当前无法访问', requestId: request.id }));

  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const result = await pool.query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM app.schema_migrations WHERE name='0008_deletion_replay.sql') AS present");
      if (!result.rows[0]?.present) throw new Error('migration_pending');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
  const consumeLoginRate = createFixedWindowLimiter(5, 60_000);
  const consumeRecoveryRate = createFixedWindowLimiter(3, 10 * 60_000);
  const consumeResetRate = createFixedWindowLimiter(5, 10 * 60_000);
  const consumeReauthRate = createFixedWindowLimiter(5, 60_000);
  const consumeInvitationRate = createFixedWindowLimiter(15, 10 * 60_000);
  registerAccountRoutes(app, pool, config, consumeRecoveryRate, consumeResetRate, consumeReauthRate);
  registerAuthRoutes(app, pool, config, consumeLoginRate);
  function trackDeletion(work: Promise<void>): void {
    const tracked = work.catch(() => {
      app.log.error({ event: 'deletion_cleanup_pending' });
    }).finally(() => deletionWork.delete(tracked));
    deletionWork.add(tracked);
  }
  function onDeletion(event: DeletionEvent): void {
    trackDeletion(cleanupDeletion(pool, storage, event));
  }
  registerFamilyRoutes(app, pool, config, journal, jobId => {
    trackDeletion(processFamilyDeletion(pool, storage, jobId));
  }, consumeInvitationRate);
  registerContentRoutes(app, pool, config);
  registerPlanRoutes(app, pool, config);
  registerGrowthRoutes(app, pool, journal, onDeletion);
  registerReminderRoutes(app, pool);
  registerMediaRoutes(app, pool, config, storage, journal, onDeletion);
  registerExportRoutes(app, pool, config, storage);
  registerJobRoutes(app, pool);
  app.addHook('onReady', async () => {
    if (journal) {
      const id = await prepareJournal(pool, journal);
      await replayJournal(pool, storage, journal, id);
    }
    await resumeFamilyDeletionJobs(pool, storage);
    await resumeProcessingMedia(pool, storage);
    await resumeQueuedExports(pool, storage);
  });
  // 除了启动补做，也重试运行中因磁盘暂不可用而挂起的清理。
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onListen', async () => {
    retryTimer = setInterval(() => {
      if (deletionWork.size) return;
      trackDeletion((async () => {
        for (const event of await pendingDeletions(pool)) await cleanupDeletion(pool, storage, event);
      })());
    }, 60_000);
    retryTimer.unref();
  });
  app.addHook('onClose', async () => {
    if (retryTimer) clearInterval(retryTimer);
    await Promise.all(deletionWork);
  });
  return app;
}
