import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import { parseInput } from '../http/validation.js';
import {
  createContentRevision,
  createReviewEvidence,
  getContentOptions,
  getContentRelease,
  getContentRevision,
  getReviewEvidence,
  listContentReleases,
  listContentRevisions,
  listContentSources,
  publishContentWorkflowRelease,
  requireContentRole,
  reviewContentRevision,
  submitContentRevision,
  withdrawContentRelease,
} from './workflow.js';

const activityKind = z.enum([
  'movement',
  'explore',
  'reading',
  'english',
  'child-led',
  'calm',
]);
const ageBand = z.enum(['m12_14', 'm15_17', 'm18_23', 'm24_29', 'm30_35', 'm36']);
const reviewCheck = z.enum(['sources', 'age_safety', 'language', 'rights']);
const releaseEnvironment = z.enum(['private_trial', 'public']);
const dateTime = z.string().refine(
  value => Number.isFinite(Date.parse(value)),
  '必须是有效日期时间',
);

const activitySchema = z.strictObject({
  id: z.string().min(1).max(60),
  revision: z.number().int().min(1),
  title: z.string().min(1).max(60),
  kind: activityKind,
  ageBands: z.array(ageBand).min(1).max(6),
  support: z.string().min(1).max(300),
  materials: z.array(z.string().min(1).max(150)).max(12),
  steps: z.array(z.string().min(1).max(400)).min(1).max(5),
  dialogue: z.strictObject({
    opening: z.string().min(1).max(300),
    engaged: z.string().min(1).max(300),
    observing: z.string().min(1).max(300),
    stopping: z.string().min(1).max(300),
  }),
  english: z.strictObject({
    phrase: z.string().min(1).max(200),
    meaning: z.string().min(1).max(200),
    when: z.string().min(1).max(300),
  }),
  easier: z.string().min(1).max(300),
  next: z.string().min(1).max(300),
  safety: z.string().min(1).max(700),
  sourceIds: z.array(z.string().min(1).max(60)).min(1).max(10),
  reviewState: z.enum(['draft', 'reviewed']),
  rights: z.enum(['original', 'licensed']),
  withdrawn: z.boolean(),
});

const reviewEvidenceSchema = z.strictObject({
  id: z.string().min(1).max(100),
  kind: z.enum([
    'editorial_review',
    'expert_review',
    'family_trial',
    'rights_license',
  ]),
  cardId: z.string().min(1).max(60),
  revision: z.number().int().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  actorId: z.string().min(1).max(100),
  actorKind: z.literal('human'),
  createdAt: dateTime,
  decision: z.enum(['approved', 'rejected']),
  evidenceRef: z.string().min(1).max(1000),
  authorId: z.string().min(1).max(100).optional(),
  selfReviewed: z.boolean().optional(),
  checks: z.array(reviewCheck).min(4).max(4).refine(
    values => new Set(values).size === values.length,
  ).optional(),
  qualificationRef: z.string().min(1).max(1000).optional(),
  completedAt: dateTime.optional(),
  authorizationRef: z.string().min(1).max(1000).optional(),
  scope: z.string().min(1).max(1000).optional(),
  allowedEnvironments: z.array(releaseEnvironment).min(1).max(2).refine(
    values => new Set(values).size === values.length,
  ).optional(),
}).superRefine((value, context) => {
  if (
    (value.kind === 'editorial_review' || value.kind === 'expert_review')
    && (value.authorId === undefined || value.selfReviewed === undefined)
  ) {
    context.addIssue({ code: 'custom', message: '审读证据必须绑定作者与自审关系' });
  }
  if (value.kind === 'editorial_review' && value.checks === undefined) {
    context.addIssue({ code: 'custom', message: '编辑审读必须提供四项检查' });
  }
  if (value.kind === 'expert_review' && value.qualificationRef === undefined) {
    context.addIssue({ code: 'custom', message: '专业审读必须提供资质引用' });
  }
  if (value.kind === 'family_trial' && value.completedAt === undefined) {
    context.addIssue({ code: 'custom', message: '家庭试玩必须提供完成时间' });
  }
  if (
    value.kind === 'rights_license'
    && (
      value.authorizationRef === undefined
      || value.scope === undefined
      || value.allowedEnvironments === undefined
    )
  ) {
    context.addIssue({ code: 'custom', message: '授权证据必须提供范围和适用环境' });
  }
});

const revisionParams = z.strictObject({ revisionId: z.uuid() });
const activityParams = z.strictObject({ activityId: z.string().min(1).max(60) });
const releaseParams = z.strictObject({ releaseId: z.uuid() });
const evidenceParams = z.strictObject({
  evidenceId: z.string().min(1).max(100),
});
const operationRevisionSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
});
const createRevisionSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  activity: activitySchema,
  changeNote: z.string().max(2000),
});
const reviewSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  decision: z.enum(['approve', 'reject']),
  checks: z.array(reviewCheck).max(4).refine(
    values => new Set(values).size === values.length,
  ),
  note: z.string().max(2000),
  selfReviewed: z.boolean(),
  evidenceRefs: z.array(z.string().min(1).max(100)).max(100).refine(
    values => new Set(values).size === values.length,
  ),
});
const publishSchema = z.strictObject({
  operationId: z.uuid(),
  revisionIds: z.array(z.uuid()).min(1).max(500).refine(
    values => new Set(values).size === values.length,
  ),
  environment: releaseEnvironment,
  evidenceRefs: z.array(z.string().min(1).max(100)).min(1).max(3000).refine(
    values => new Set(values).size === values.length,
  ),
});
const withdrawSchema = z.strictObject({
  operationId: z.uuid(),
  kind: z.enum(['editorial', 'safety']),
  reason: z.string().min(1).max(1000),
});
const listQuery = z.strictObject({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const revisionListQuery = z.strictObject({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum([
    'draft',
    'in_review',
    'approved',
    'published',
    'withdrawn',
  ]).optional(),
});

export function registerContentRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AppConfig,
): void {
  const anyContentRole = requireContentRole(pool);
  const editor = requireContentRole(pool, ['editor']);
  const reviewer = requireContentRole(pool, ['reviewer']);
  const publisher = requireContentRole(pool, ['publisher']);

  app.get('/v2/content/options', {
    preHandler: app.authenticate,
  }, async request => getContentOptions(
    pool,
    request.auth.userId,
    config.contentEnvironment,
    config.environment === 'test',
  ));

  app.post('/v2/admin/activities/:activityId/revisions', {
    preHandler: [app.authenticate, editor],
  }, async (request, reply) => {
    const params = parseInput(activityParams, request.params);
    const body = parseInput(createRevisionSchema, request.body);
    const revision = await createContentRevision(pool, request.auth.userId, {
      activityId: params.activityId,
      ...body,
    });
    return reply.code(201).send(revision);
  });

  app.post('/v2/admin/revisions/:revisionId/submit', {
    preHandler: [app.authenticate, editor],
  }, async request => {
    const params = parseInput(revisionParams, request.params);
    const body = parseInput(operationRevisionSchema, request.body);
    return submitContentRevision(
      pool,
      request.auth.userId,
      params.revisionId,
      body,
    );
  });

  app.post('/v2/admin/revisions/:revisionId/review', {
    preHandler: [app.authenticate, reviewer],
  }, async request => {
    const params = parseInput(revisionParams, request.params);
    const body = parseInput(reviewSchema, request.body);
    return reviewContentRevision(
      pool,
      request.auth.userId,
      params.revisionId,
      body,
    );
  });

  app.get('/v2/admin/revisions', {
    preHandler: [app.authenticate, anyContentRole],
  }, async request => {
    const query = parseInput(revisionListQuery, request.query);
    return listContentRevisions(pool, query);
  });

  app.get('/v2/admin/revisions/:revisionId', {
    preHandler: [app.authenticate, anyContentRole],
  }, async request => {
    const params = parseInput(revisionParams, request.params);
    return getContentRevision(pool, params.revisionId);
  });

  app.get('/v2/admin/sources', {
    preHandler: [app.authenticate, anyContentRole],
  }, async () => listContentSources(pool));

  app.post('/v2/admin/evidence', {
    preHandler: [app.authenticate, reviewer],
  }, async (request, reply) => {
    const body = parseInput(z.strictObject({
      operationId: z.uuid(),
      record: reviewEvidenceSchema,
    }), request.body);
    const evidence = await createReviewEvidence(
      pool,
      request.auth.userId,
      body.operationId,
      body.record,
    );
    return reply.code(201).send(evidence);
  });

  app.get('/v2/admin/evidence/:evidenceId', {
    preHandler: [app.authenticate, anyContentRole],
  }, async request => {
    const params = parseInput(evidenceParams, request.params);
    return getReviewEvidence(pool, params.evidenceId);
  });

  app.post('/v2/admin/releases', {
    preHandler: [app.authenticate, publisher],
  }, async (request, reply) => {
    const body = parseInput(publishSchema, request.body);
    const release = await publishContentWorkflowRelease(
      pool,
      request.auth.userId,
      body,
    );
    return reply.code(201).send(release);
  });

  app.get('/v2/admin/releases', {
    preHandler: [app.authenticate, anyContentRole],
  }, async request => {
    const query = parseInput(listQuery, request.query);
    return listContentReleases(pool, query);
  });

  app.get('/v2/admin/releases/:releaseId', {
    preHandler: [app.authenticate, anyContentRole],
  }, async request => {
    const params = parseInput(releaseParams, request.params);
    return getContentRelease(pool, params.releaseId);
  });

  app.post('/v2/admin/releases/:releaseId/withdraw', {
    preHandler: [app.authenticate, publisher],
  }, async request => {
    const params = parseInput(releaseParams, request.params);
    const body = parseInput(withdrawSchema, request.body);
    return withdrawContentRelease(
      pool,
      request.auth.userId,
      params.releaseId,
      body,
    );
  });
}
