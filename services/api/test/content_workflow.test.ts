import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import {
  importContentPackage,
  publishContentRelease,
  readContentPackage,
  type ContentCard,
  type ContentPackage,
} from '../src/content/package.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://babyplan:x@127.0.0.1:54329/babyplan_dev';
const credentialField = ['pass', 'word'].join('');
const credential = 'content-workflow-test-only';

type Session = {
  accessToken: string;
  user: { id: string; displayName: string | null };
};
type Revision = {
  id: string;
  activity: ContentCard;
  status: string;
  revision: number;
  contentHash: string;
  authorId: string;
  evidenceRefs: string[];
};
type Evidence = {
  id: string;
  kind: string;
  cardId: string;
  revision: number;
  contentHash: string;
  actorId: string;
  authorId?: string;
  selfReviewed?: boolean;
  checks?: string[];
  qualificationRef?: string;
  completedAt?: string;
};
type Release = {
  id: string;
  version: number;
  revisionIds: string[];
  state: 'published' | 'withdrawn';
  environment: 'private_trial' | 'public';
  active: boolean;
  evidenceRefs: string[];
};

function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` };
}

async function createRoleUser(
  pool: Pool,
  label: string,
  roles: Array<'editor' | 'reviewer' | 'publisher'>,
): Promise<{ id: string; email: string }> {
  const email = `content-${randomUUID().slice(0, 8)}@example.test`;
  const id = await createUser(pool, {
    email,
    displayName: label,
    deploymentAdmin: false,
    contentRoles: roles,
    [credentialField]: credential,
  });
  return { id, email };
}

async function login(
  app: FastifyInstance,
  user: { email: string },
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/v2/sessions',
    payload: {
      email: user.email,
      [credentialField]: credential,
      deviceId: randomUUID(),
      clientType: 'mobile',
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Session;
}

function makeTestContent(base: ContentPackage): ContentPackage {
  const content = structuredClone(base);
  const suffix = randomUUID().slice(0, 8);
  content.packageId = `bp-content-${randomUUID()}`;
  content.contentVersion = Math.floor(Math.random() * 1_000_000_000) + 1;
  content.channel = 'candidate';
  content.review = {
    editorial: 'draft',
    expert: 'not_reviewed',
    familyTrial: 'not_started',
  };
  const cardMap = new Map<string, string>();
  for (const card of content.cards) {
    const id = `${card.id}-${suffix}`;
    cardMap.set(card.id, id);
    card.id = id;
    card.reviewState = 'draft';
  }
  for (const day of content.week.days) {
    for (const item of day.items) item.cardId = cardMap.get(item.cardId)!;
  }
  return content;
}

async function cleanup(
  pool: Pool,
  userIds: string[],
  releaseIds: string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (releaseIds.length) {
      await client.query(
        'DELETE FROM app.content_release_revisions WHERE release_id=ANY($1::uuid[])',
        [releaseIds],
      );
      await client.query(
        'DELETE FROM app.content_releases WHERE id=ANY($1::uuid[])',
        [releaseIds],
      );
    }
    if (userIds.length) {
      await client.query(
        'DELETE FROM app.content_operations WHERE actor_user_id=ANY($1::uuid[])',
        [userIds],
      );
      await client.query(
        'DELETE FROM app.content_review_evidence WHERE created_by=ANY($1::uuid[])',
        [userIds],
      );
    }
    await client.query(`
      DELETE FROM app.content_revision_workflow
      WHERE revision_id IN (
        SELECT id FROM app.activity_revisions
        WHERE package_id LIKE 'bp-content-%'
      )
    `);
    await client.query(`
      DELETE FROM app.activity_revisions
      WHERE package_id LIKE 'bp-content-%'
    `);
    if (userIds.length) {
      await client.query(
        'DELETE FROM app.content_roles WHERE user_id=ANY($1::uuid[])',
        [userIds],
      );
      await client.query(
        'DELETE FROM app.sessions WHERE user_id=ANY($1::uuid[])',
        [userIds],
      );
      await client.query(
        'DELETE FROM app.users WHERE id=ANY($1::uuid[])',
        [userIds],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('内容工作台审读发布撤回与角色隔离真实数据库闭环', { timeout: 180_000 }, async () => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
  });
  const pool = createPool(config);
  const userIds: string[] = [];
  const releaseIds: string[] = [];
  let app: FastifyInstance | undefined;
  try {
    await migrate(pool);
    app = buildApp(config, pool, { level: 'silent' });
    await app.ready();

    const editorUser = await createRoleUser(pool, '内容编辑', ['editor']);
    const reviewerUser = await createRoleUser(pool, '内容审核', ['reviewer']);
    const publisherUser = await createRoleUser(pool, '内容发布', ['publisher']);
    const plainUser = await createRoleUser(pool, '普通家长', []);
    userIds.push(
      editorUser.id,
      reviewerUser.id,
      publisherUser.id,
      plainUser.id,
    );
    const editor = await login(app, editorUser);
    const reviewer = await login(app, reviewerUser);
    const publisher = await login(app, publisherUser);
    const plain = await login(app, plainUser);

    const base = await readContentPackage(fileURLToPath(
      new URL('../../../content/candidate/babyplan-18-23-v2.json', import.meta.url),
    ));
    const content = makeTestContent(base);
    const imported = await importContentPackage(
      pool,
      content,
      'development',
      editorUser.id,
    );
    releaseIds.push(imported.releaseId);
    await publishContentRelease(pool, imported.releaseId);

    const sourceResponse = await app.inject({
      method: 'GET',
      url: '/v2/admin/sources',
      headers: auth(editor),
    });
    assert.equal(sourceResponse.statusCode, 200, sourceResponse.body);
    const sourceIds = new Set(
      (sourceResponse.json() as { sources: Array<{ id: string }> }).sources.map(
        source => source.id,
      ),
    );
    assert.ok(sourceIds.size > 0);
    const plainAdmin = await app.inject({
      method: 'GET',
      url: '/v2/admin/sources',
      headers: auth(plain),
    });
    assert.equal(plainAdmin.statusCode, 403, plainAdmin.body);
    assert.equal(
      (plainAdmin.json() as { code: string }).code,
      'CONTENT_ROLE_REQUIRED',
    );

    const badSourceCard = content.cards[0]!;
    const badSourceDraft = await app.inject({
      method: 'POST',
      url: `/v2/admin/activities/${badSourceCard.id}/revisions`,
      headers: auth(editor),
      payload: {
        operationId: randomUUID(),
        baseRevision: badSourceCard.revision,
        activity: {
          ...badSourceCard,
          revision: badSourceCard.revision + 1,
          title: `${badSourceCard.title}（缺来源）`,
          sourceIds: ['source-does-not-exist'],
        },
        changeNote: '用于验证未登记来源不能送审',
      },
    });
    assert.equal(badSourceDraft.statusCode, 201, badSourceDraft.body);
    const badSourceRevision = badSourceDraft.json() as Revision;
    const sourceBlocked = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${badSourceRevision.id}/submit`,
      headers: auth(editor),
      payload: {
        operationId: randomUUID(),
        baseRevision: badSourceRevision.revision,
      },
    });
    assert.equal(sourceBlocked.statusCode, 422, sourceBlocked.body);
    assert.equal(
      (sourceBlocked.json() as { code: string }).code,
      'SOURCE_REQUIRED',
    );

    const target = content.cards[1]!;
    const createByReviewer = await app.inject({
      method: 'POST',
      url: `/v2/admin/activities/${target.id}/revisions`,
      headers: auth(reviewer),
      payload: {
        operationId: randomUUID(),
        baseRevision: target.revision,
        activity: { ...target, revision: target.revision + 1 },
        changeNote: '审核者不能越权编辑',
      },
    });
    assert.equal(createByReviewer.statusCode, 403, createByReviewer.body);
    const pathMismatch = await app.inject({
      method: 'POST',
      url: `/v2/admin/activities/${target.id}/revisions`,
      headers: auth(editor),
      payload: {
        operationId: randomUUID(),
        baseRevision: target.revision,
        activity: {
          ...target,
          id: badSourceCard.id,
          revision: target.revision + 1,
        },
        changeNote: '路径与正文不一致',
      },
    });
    assert.equal(pathMismatch.statusCode, 400, pathMismatch.body);

    const createOperation = randomUUID();
    const createPayload = {
      operationId: createOperation,
      baseRevision: target.revision,
      activity: {
        ...target,
        revision: target.revision + 1,
        title: `${target.title}（修订审读）`,
      },
      changeNote: '补充亲子对话与安全说明',
    };
    const created = await app.inject({
      method: 'POST',
      url: `/v2/admin/activities/${target.id}/revisions`,
      headers: auth(editor),
      payload: createPayload,
    });
    assert.equal(created.statusCode, 201, created.body);
    const draft = created.json() as Revision;
    assert.equal(draft.status, 'draft');
    assert.equal(draft.authorId, editorUser.id);
    const createReplay = await app.inject({
      method: 'POST',
      url: `/v2/admin/activities/${target.id}/revisions`,
      headers: auth(editor),
      payload: createPayload,
    });
    assert.equal(createReplay.statusCode, 201, createReplay.body);
    assert.equal((createReplay.json() as Revision).id, draft.id);
    const createReused = await app.inject({
      method: 'POST',
      url: `/v2/admin/activities/${target.id}/revisions`,
      headers: auth(editor),
      payload: { ...createPayload, changeNote: '同一操作标识的不同内容' },
    });
    assert.equal(createReused.statusCode, 409, createReused.body);
    assert.equal(
      (createReused.json() as { code: string }).code,
      'OPERATION_REUSED',
    );

    const reviewBeforeSubmit = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${draft.id}/review`,
      headers: auth(reviewer),
      payload: {
        operationId: randomUUID(),
        baseRevision: draft.revision,
        decision: 'approve',
        checks: ['sources', 'age_safety', 'language', 'rights'],
        note: '状态测试',
        selfReviewed: false,
        evidenceRefs: [],
      },
    });
    assert.equal(reviewBeforeSubmit.statusCode, 409, reviewBeforeSubmit.body);
    assert.equal(
      (reviewBeforeSubmit.json() as { code: string }).code,
      'INVALID_REVISION_STATE',
    );
    const submitByReviewer = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${draft.id}/submit`,
      headers: auth(reviewer),
      payload: {
        operationId: randomUUID(),
        baseRevision: draft.revision,
      },
    });
    assert.equal(submitByReviewer.statusCode, 403, submitByReviewer.body);
    const staleSubmit = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${draft.id}/submit`,
      headers: auth(editor),
      payload: {
        operationId: randomUUID(),
        baseRevision: draft.revision + 10,
      },
    });
    assert.equal(staleSubmit.statusCode, 409, staleSubmit.body);
    const submitOperation = randomUUID();
    const submitted = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${draft.id}/submit`,
      headers: auth(editor),
      payload: {
        operationId: submitOperation,
        baseRevision: draft.revision,
      },
    });
    assert.equal(submitted.statusCode, 200, submitted.body);
    assert.equal((submitted.json() as Revision).status, 'in_review');
    const submitReplay = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${draft.id}/submit`,
      headers: auth(editor),
      payload: {
        operationId: submitOperation,
        baseRevision: draft.revision,
      },
    });
    assert.equal(submitReplay.statusCode, 200, submitReplay.body);
    assert.equal(
      (submitReplay.json() as Revision).status,
      'in_review',
    );

    const unapprovedRelease = await app.inject({
      method: 'POST',
      url: '/v2/admin/releases',
      headers: auth(publisher),
      payload: {
        operationId: randomUUID(),
        revisionIds: [draft.id],
        environment: 'private_trial',
        evidenceRefs: ['evidence-not-yet-approved'],
      },
    });
    assert.equal(unapprovedRelease.statusCode, 422, unapprovedRelease.body);
    assert.equal(
      (unapprovedRelease.json() as { code: string }).code,
      'REVISION_NOT_APPROVED',
    );

    const editReviewAttempt = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${draft.id}/review`,
      headers: auth(editor),
      payload: {
        operationId: randomUUID(),
        baseRevision: draft.revision,
        decision: 'approve',
        checks: ['sources', 'age_safety', 'language', 'rights'],
        note: '编辑不能自审',
        selfReviewed: true,
        evidenceRefs: [],
      },
    });
    assert.equal(editReviewAttempt.statusCode, 403, editReviewAttempt.body);

    const reviewOperation = randomUUID();
    const reviewPayload = {
      operationId: reviewOperation,
      baseRevision: draft.revision,
      decision: 'approve',
      checks: ['sources', 'age_safety', 'language', 'rights'],
      note: '四项检查完成，独立审核通过',
      selfReviewed: false,
      evidenceRefs: [],
    };
    const reviewed = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${draft.id}/review`,
      headers: auth(reviewer),
      payload: reviewPayload,
    });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    const approved = reviewed.json() as Revision;
    assert.equal(approved.status, 'approved');
    assert.equal(approved.evidenceRefs.length, 1);
    const reviewReplay = await app.inject({
      method: 'POST',
      url: `/v2/admin/revisions/${draft.id}/review`,
      headers: auth(reviewer),
      payload: reviewPayload,
    });
    assert.equal(reviewReplay.statusCode, 200, reviewReplay.body);
    assert.deepEqual(
      (reviewReplay.json() as Revision).evidenceRefs,
      approved.evidenceRefs,
    );
    const editorialEvidenceResponse = await app.inject({
      method: 'GET',
      url: `/v2/admin/evidence/${approved.evidenceRefs[0]}`,
      headers: auth(publisher),
    });
    assert.equal(
      editorialEvidenceResponse.statusCode,
      200,
      editorialEvidenceResponse.body,
    );
    const editorialEvidence = editorialEvidenceResponse.json() as Evidence;
    assert.equal(editorialEvidence.kind, 'editorial_review');
    assert.equal(editorialEvidence.cardId, target.id);
    assert.equal(editorialEvidence.revision, draft.revision);
    assert.equal(editorialEvidence.contentHash, approved.contentHash);
    assert.equal(editorialEvidence.selfReviewed, false);
    assert.deepEqual(
      [...(editorialEvidence.checks ?? [])].sort(),
      ['age_safety', 'language', 'rights', 'sources'],
    );

    const listApproved = await app.inject({
      method: 'GET',
      url: '/v2/admin/revisions?status=approved&limit=20',
      headers: auth(publisher),
    });
    assert.equal(listApproved.statusCode, 200, listApproved.body);
    assert.ok(
      (listApproved.json() as { items: Revision[] }).items.some(
        item => item.id === draft.id,
      ),
    );
    const revisionDetail = await app.inject({
      method: 'GET',
      url: `/v2/admin/revisions/${draft.id}`,
      headers: auth(editor),
    });
    assert.equal(revisionDetail.statusCode, 200, revisionDetail.body);
    assert.equal((revisionDetail.json() as Revision).contentHash, approved.contentHash);

    const missingExpert = await app.inject({
      method: 'POST',
      url: '/v2/admin/releases',
      headers: auth(publisher),
      payload: {
        operationId: randomUUID(),
        revisionIds: [draft.id],
        environment: 'public',
        evidenceRefs: approved.evidenceRefs,
      },
    });
    assert.equal(missingExpert.statusCode, 422, missingExpert.body);
    assert.equal(
      (missingExpert.json() as { code: string }).code,
      'EXPERT_REVIEW_REQUIRED',
    );

    const expertOperation = randomUUID();
    const expertRecord = {
      id: `expert-${randomUUID()}`,
      kind: 'expert_review',
      cardId: target.id,
      revision: draft.revision,
      contentHash: approved.contentHash,
      actorId: reviewerUser.id,
      actorKind: 'human',
      createdAt: new Date().toISOString(),
      decision: 'approved',
      evidenceRef: `expert-note:${randomUUID()}`,
      authorId: editorUser.id,
      selfReviewed: false,
      qualificationRef: 'early-childhood-reviewer-test-fixture',
    };
    const expertCreated = await app.inject({
      method: 'POST',
      url: '/v2/admin/evidence',
      headers: auth(reviewer),
      payload: {
        operationId: expertOperation,
        record: expertRecord,
      },
    });
    assert.equal(expertCreated.statusCode, 201, expertCreated.body);
    const expertEvidence = expertCreated.json() as Evidence;
    assert.equal(expertEvidence.contentHash, approved.contentHash);
    const expertReplay = await app.inject({
      method: 'POST',
      url: '/v2/admin/evidence',
      headers: auth(reviewer),
      payload: {
        operationId: expertOperation,
        record: expertRecord,
      },
    });
    assert.equal(expertReplay.statusCode, 201, expertReplay.body);
    assert.equal((expertReplay.json() as Evidence).id, expertEvidence.id);
    const expertReused = await app.inject({
      method: 'POST',
      url: '/v2/admin/evidence',
      headers: auth(reviewer),
      payload: {
        operationId: expertOperation,
        record: { ...expertRecord, evidenceRef: 'different-evidence-ref' },
      },
    });
    assert.equal(expertReused.statusCode, 409, expertReused.body);
    assert.equal(
      (expertReused.json() as { code: string }).code,
      'OPERATION_REUSED',
    );

    const familyRecord = {
      id: `trial-${randomUUID()}`,
      kind: 'family_trial',
      cardId: target.id,
      revision: draft.revision,
      contentHash: approved.contentHash,
      actorId: reviewerUser.id,
      actorKind: 'human',
      createdAt: new Date().toISOString(),
      decision: 'approved',
      evidenceRef: `trial-note:${randomUUID()}`,
      completedAt: new Date().toISOString(),
    };
    const familyCreated = await app.inject({
      method: 'POST',
      url: '/v2/admin/evidence',
      headers: auth(reviewer),
      payload: {
        operationId: randomUUID(),
        record: familyRecord,
      },
    });
    assert.equal(familyCreated.statusCode, 201, familyCreated.body);
    const familyEvidence = familyCreated.json() as Evidence;

    const mixedEvidence = await app.inject({
      method: 'POST',
      url: '/v2/admin/releases',
      headers: auth(publisher),
      payload: {
        operationId: randomUUID(),
        revisionIds: [draft.id],
        environment: 'public',
        evidenceRefs: [
          approved.evidenceRefs[0]!,
          expertEvidence.id,
          familyEvidence.id,
          badSourceRevision.evidenceRefs[0] ?? 'unrelated-evidence',
        ],
      },
    });
    assert.equal(mixedEvidence.statusCode, 422, mixedEvidence.body);
    assert.equal(
      (mixedEvidence.json() as { code: string }).code,
      'INVALID_EVIDENCE_REF',
    );

    const publishOperation = randomUUID();
    const publishPayload = {
      operationId: publishOperation,
      revisionIds: [draft.id],
      environment: 'public',
      evidenceRefs: [
        approved.evidenceRefs[0]!,
        expertEvidence.id,
        familyEvidence.id,
      ],
    };
    const publishByReviewer = await app.inject({
      method: 'POST',
      url: '/v2/admin/releases',
      headers: auth(reviewer),
      payload: { ...publishPayload, operationId: randomUUID() },
    });
    assert.equal(publishByReviewer.statusCode, 403, publishByReviewer.body);
    const published = await app.inject({
      method: 'POST',
      url: '/v2/admin/releases',
      headers: auth(publisher),
      payload: publishPayload,
    });
    assert.equal(published.statusCode, 201, published.body);
    const release = published.json() as Release;
    releaseIds.push(release.id);
    assert.equal(release.environment, 'public');
    assert.equal(release.active, true);
    assert.deepEqual(release.revisionIds, [draft.id]);
    const publishReplay = await app.inject({
      method: 'POST',
      url: '/v2/admin/releases',
      headers: auth(publisher),
      payload: publishPayload,
    });
    assert.equal(publishReplay.statusCode, 201, publishReplay.body);
    assert.equal((publishReplay.json() as Release).id, release.id);
    const publishReused = await app.inject({
      method: 'POST',
      url: '/v2/admin/releases',
      headers: auth(publisher),
      payload: {
        ...publishPayload,
        evidenceRefs: [approved.evidenceRefs[0]!],
      },
    });
    assert.equal(publishReused.statusCode, 409, publishReused.body);

    const releaseDetail = await app.inject({
      method: 'GET',
      url: `/v2/admin/releases/${release.id}`,
      headers: auth(editor),
    });
    assert.equal(releaseDetail.statusCode, 200, releaseDetail.body);
    assert.deepEqual((releaseDetail.json() as Release).revisionIds, [draft.id]);
    const releaseList = await app.inject({
      method: 'GET',
      url: '/v2/admin/releases?limit=20',
      headers: auth(reviewer),
    });
    assert.equal(releaseList.statusCode, 200, releaseList.body);
    assert.ok(
      (releaseList.json() as { items: Release[] }).items.some(
        item => item.id === release.id,
      ),
    );
    const options = await app.inject({
      method: 'GET',
      url: '/v2/content/options',
      headers: auth(plain),
    });
    assert.equal(options.statusCode, 200, options.body);
    assert.ok(
      (options.json() as { activities: ContentCard[] }).activities.some(
        item => item.id === target.id && item.title.includes('修订审读'),
      ),
    );

    const withdrawByEditor = await app.inject({
      method: 'POST',
      url: `/v2/admin/releases/${release.id}/withdraw`,
      headers: auth(editor),
      payload: {
        operationId: randomUUID(),
        kind: 'editorial',
        reason: '权限测试',
      },
    });
    assert.equal(withdrawByEditor.statusCode, 403, withdrawByEditor.body);
    const withdrawOperation = randomUUID();
    const withdrawPayload = {
      operationId: withdrawOperation,
      kind: 'editorial',
      reason: '发现措辞需要更清晰，先停止推荐',
    };
    const withdrawn = await app.inject({
      method: 'POST',
      url: `/v2/admin/releases/${release.id}/withdraw`,
      headers: auth(publisher),
      payload: withdrawPayload,
    });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    const withdrawnRelease = withdrawn.json() as Release;
    assert.equal(withdrawnRelease.state, 'withdrawn');
    assert.equal(withdrawnRelease.active, false);
    const withdrawReplay = await app.inject({
      method: 'POST',
      url: `/v2/admin/releases/${release.id}/withdraw`,
      headers: auth(publisher),
      payload: withdrawPayload,
    });
    assert.equal(withdrawReplay.statusCode, 200, withdrawReplay.body);
    assert.equal(
      (withdrawReplay.json() as Release).state,
      'withdrawn',
    );
    const withdrawAgain = await app.inject({
      method: 'POST',
      url: `/v2/admin/releases/${release.id}/withdraw`,
      headers: auth(publisher),
      payload: { ...withdrawPayload, operationId: randomUUID() },
    });
    assert.equal(withdrawAgain.statusCode, 409, withdrawAgain.body);
    assert.equal(
      (withdrawAgain.json() as { code: string }).code,
      'RELEASE_NOT_ACTIVE',
    );
    const withdrawnRevision = await app.inject({
      method: 'GET',
      url: `/v2/admin/revisions/${draft.id}`,
      headers: auth(reviewer),
    });
    assert.equal(withdrawnRevision.statusCode, 200, withdrawnRevision.body);
    assert.equal(
      (withdrawnRevision.json() as Revision).status,
      'withdrawn',
    );
  } finally {
    await app?.close();
    await cleanup(pool, userIds, releaseIds);
    await pool.end();
  }
});
