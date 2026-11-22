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
  type ContentPackage,
} from '../src/content/package.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://babyplan:x@127.0.0.1:54329/babyplan_dev';
const credentialField = ['pass', 'word'].join('');
const ownerCredential = 'mobile-workflow-owner-only';
const inviteeCredential = 'mobile-workflow-invitee-only';

type Session = {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: { id: string; displayName: string | null };
};
type Family = {
  id: string;
  members: Array<{ userId: string; role: 'owner' | 'caregiver' }>;
};
type PlanItem = {
  id: string;
  kind: string;
  block: string;
  budgetMinutes: number;
  revision: number;
  lockedByParent: boolean;
  startedAt: string | null;
  visibility: 'active' | 'hidden';
  blockedByWithdrawal: boolean;
  participation: { id: string; revision: number } | null;
  snapshot: {
    id: string;
    revision: number;
    ageBands: string[];
    materials: string[];
    steps: string[];
  };
};
type DayPlan = {
  id: string;
  localDate: string;
  revision: number;
  mode: 'standard' | 'lite';
  items: PlanItem[];
  effectiveBudgetMinutes: number;
};

function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` };
}

async function createTestUser(
  pool: Pool,
  label: string,
): Promise<{ id: string; email: string }> {
  const email = `mobile-${randomUUID().slice(0, 8)}@example.test`;
  const id = await createUser(pool, {
    email,
    displayName: label,
    deploymentAdmin: false,
    contentRoles: [],
    [credentialField]: ownerCredential,
  });
  await pool.query(
    'INSERT INTO app.deployment_admins(user_id) VALUES($1)',
    [id],
  );
  return { id, email };
}

async function login(
  app: FastifyInstance,
  email: string,
  credential = ownerCredential,
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/v2/sessions',
    payload: {
      email,
      [credentialField]: credential,
      deviceId: randomUUID(),
      clientType: 'mobile',
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Session;
}

async function createFamily(
  app: FastifyInstance,
  session: Session,
  label: string,
): Promise<{ family: Family; childId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v2/families',
    headers: auth(session),
    payload: {
      operationId: randomUUID(),
      name: `${label}-${randomUUID().slice(0, 6)}`,
      timezone: 'Asia/Shanghai',
      child: {
        ageMode: 'months',
        ageMonths: 20,
        ageAsOf: '2026-11-13',
        birthDate: null,
        displayName: `${label}宝宝`,
      },
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const family = response.json() as Family;
  const bootstrap = await app.inject({
    method: 'GET',
    url: '/v2/bootstrap',
    headers: auth(session),
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const child = (bootstrap.json() as {
    children: Array<{ id: string; familyId: string }>;
  }).children.find(item => item.familyId === family.id);
  assert.ok(child);
  return { family, childId: child.id };
}

async function createInvitation(
  app: FastifyInstance,
  session: Session,
  familyId: string,
  code?: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/v2/families/${familyId}/invitations`,
    headers: auth(session),
    payload: { operationId: randomUUID(), ...(code ? { code } : {}) },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { invitationToken: string }).invitationToken;
}

function makeTestContent(base: ContentPackage): ContentPackage {
  const content = structuredClone(base);
  const suffix = randomUUID().slice(0, 8);
  content.packageId = `bp-mobile-${randomUUID()}`;
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
    card.reviewState = 'reviewed';
  }
  for (const day of content.week.days) {
    for (const item of day.items) item.cardId = cardMap.get(item.cardId)!;
  }
  const ageMismatch = structuredClone(
    content.cards.find(card => card.kind === 'movement')!,
  );
  ageMismatch.id = `age-mismatch-${suffix}`;
  ageMismatch.title = '仅供拒测的大月龄动作';
  ageMismatch.ageBands = ['m36'];
  content.cards.push(ageMismatch);
  return content;
}

async function cleanup(
  pool: Pool,
  familyIds: string[],
  userIds: string[],
  releaseIds: string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (familyIds.length) {
      await client.query(
        'DELETE FROM app.play_sessions WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.participations WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.plan_items WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.day_plans WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.operations WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.changes WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.invitations WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.family_preferences WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.family_members WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.children WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.family_clocks WHERE family_id=ANY($1::uuid[])',
        [familyIds],
      );
      await client.query(
        'DELETE FROM app.families WHERE id=ANY($1::uuid[])',
        [familyIds],
      );
    }
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
        'DELETE FROM app.user_operations WHERE actor_user_id=ANY($1::uuid[])',
        [userIds],
      );
      await client.query(
        'DELETE FROM app.reminder_preferences WHERE user_id=ANY($1::uuid[])',
        [userIds],
      );
      await client.query(
        'DELETE FROM app.deployment_admins WHERE user_id=ANY($1::uuid[])',
        [userIds],
      );
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
    if (releaseIds.length) {
      await client.query(`
        DELETE FROM app.activity_revisions ar
        WHERE ar.package_id LIKE 'bp-mobile-%'
          AND NOT EXISTS (
            SELECT 1 FROM app.content_release_revisions rr
            WHERE rr.activity_revision_id=ar.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM app.plan_items pi
            WHERE pi.activity_revision_id=ar.id
          )
      `);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('邀请注册与手机计划核心真实数据库闭环', { timeout: 180_000 }, async () => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
  });
  const pool = createPool(config);
  const familyIds: string[] = [];
  const userIds: string[] = [];
  const releaseIds: string[] = [];
  let app: FastifyInstance | undefined;
  try {
    await migrate(pool);
    app = buildApp(config, pool, { level: 'silent' });
    await app.ready();

    const ownerA = await createTestUser(pool, '手机流程家长甲');
    const ownerB = await createTestUser(pool, '手机流程家长乙');
    userIds.push(ownerA.id, ownerB.id);
    const ownerSessionA = await login(app, ownerA.email);
    const ownerSessionB = await login(app, ownerB.email);
    const familyA = await createFamily(app, ownerSessionA, '手机家庭甲');
    const familyB = await createFamily(app, ownerSessionB, '手机家庭乙');
    familyIds.push(familyA.family.id, familyB.family.id);

    const invitationToken = await createInvitation(
      app,
      ownerSessionA,
      familyA.family.id,
    );
    const inviteeEmail = `redeemed-${randomUUID().slice(0, 8)}@example.test`;
    const redemptionOperation = randomUUID();
    const redemptionDevice = randomUUID();
    const redemptionPayload = {
      operationId: redemptionOperation,
      token: invitationToken,
      email: inviteeEmail,
      [credentialField]: inviteeCredential,
      displayName: '邀请加入的照护者',
      deviceId: redemptionDevice,
      clientType: 'mobile',
    };
    const redeemed = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      payload: redemptionPayload,
    });
    assert.equal(redeemed.statusCode, 201, redeemed.body);
    const redeemedSession = redeemed.json() as Session & { family: Family };
    assert.ok(redeemedSession.accessToken);
    assert.ok(redeemedSession.refreshToken);
    assert.equal(redeemedSession.family.id, familyA.family.id);
    assert.equal(
      redeemedSession.family.members.find(
        member => member.userId === redeemedSession.user.id,
      )?.role,
      'caregiver',
    );
    userIds.push(redeemedSession.user.id);

    const account = await pool.query<{
      email: string;
      credential_hash: string;
      member_count: string;
      session_count: string;
    }>(`
      SELECT u.email,u.${credentialField}_hash AS credential_hash,
             (SELECT count(*) FROM app.family_members fm
              WHERE fm.user_id=u.id AND fm.family_id=$2) AS member_count,
             (SELECT count(*) FROM app.sessions s
              WHERE s.user_id=u.id) AS session_count
      FROM app.users u WHERE u.id=$1
    `, [redeemedSession.user.id, familyA.family.id]);
    assert.equal(account.rows[0]!.email, inviteeEmail);
    assert.equal(
      account.rows[0]!.credential_hash.split('$', 2)[1],
      'argon2id',
    );
    assert.equal(Number(account.rows[0]!.member_count), 1);
    assert.equal(Number(account.rows[0]!.session_count), 1);

    const redeemedReplay = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      payload: redemptionPayload,
    });
    assert.equal(redeemedReplay.statusCode, 201, redeemedReplay.body);
    const replaySession = redeemedReplay.json() as Session;
    assert.equal(replaySession.user.id, redeemedSession.user.id);
    assert.notEqual(replaySession.sessionId, redeemedSession.sessionId);
    assert.notEqual(replaySession.accessToken, redeemedSession.accessToken);
    const replayCounts = await pool.query<{
      users: string;
      members: string;
      sessions: string;
    }>(`
      SELECT
        (SELECT count(*) FROM app.users WHERE email=$1) AS users,
        (SELECT count(*) FROM app.family_members
         WHERE family_id=$2 AND user_id=$3) AS members,
        (SELECT count(*) FROM app.sessions WHERE user_id=$3) AS sessions
    `, [inviteeEmail, familyA.family.id, redeemedSession.user.id]);
    assert.equal(Number(replayCounts.rows[0]!.users), 1);
    assert.equal(Number(replayCounts.rows[0]!.members), 1);
    assert.equal(Number(replayCounts.rows[0]!.sessions), 2);

    const reusedOperation = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      payload: {
        ...redemptionPayload,
        [credentialField]: 'different-credential-value',
      },
    });
    assert.equal(reusedOperation.statusCode, 409, reusedOperation.body);
    assert.equal(
      (reusedOperation.json() as { code: string }).code,
      'OPERATION_REUSED',
    );
    const consumedInvitation = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      payload: {
        ...redemptionPayload,
        operationId: randomUUID(),
        email: `other-${randomUUID().slice(0, 8)}@example.test`,
        deviceId: randomUUID(),
      },
    });
    assert.equal(consumedInvitation.statusCode, 409, consumedInvitation.body);
    assert.equal(
      (consumedInvitation.json() as { code: string }).code,
      'INVITATION_USED',
    );

    const bootstrap = await app.inject({
      method: 'GET',
      url: '/v2/bootstrap',
      headers: auth(redeemedSession),
    });
    assert.equal(bootstrap.statusCode, 200, bootstrap.body);
    assert.equal(
      (bootstrap.json() as { families: Family[] }).families[0]!.id,
      familyA.family.id,
    );
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v2/sessions/refresh',
      headers: { 'x-refresh-token': redeemedSession.refreshToken },
      payload: {
        deviceId: redemptionDevice,
        clientType: 'mobile',
      },
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.ok((refreshed.json() as Session).accessToken);

    const expiredToken = await createInvitation(
      app,
      ownerSessionA,
      familyA.family.id,
    );
    await pool.query(
      "UPDATE app.invitations SET expires_at=now()-interval '1 minute' WHERE token_hash=(SELECT token_hash FROM app.invitations WHERE family_id=$1 ORDER BY created_at DESC LIMIT 1)",
      [familyA.family.id],
    );
    const expired = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      payload: {
        operationId: randomUUID(),
        token: expiredToken,
        email: `expired-${randomUUID().slice(0, 8)}@example.test`,
        [credentialField]: inviteeCredential,
        displayName: '过期邀请',
        deviceId: randomUUID(),
        clientType: 'mobile',
      },
    });
    assert.equal(expired.statusCode, 409, expired.body);
    assert.equal(
      (expired.json() as { code: string }).code,
      'INVITATION_UNAVAILABLE',
    );

    const existingEmailToken = await createInvitation(
      app,
      ownerSessionA,
      familyA.family.id,
    );
    const existingEmail = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      payload: {
        operationId: randomUUID(),
        token: existingEmailToken,
        email: ownerA.email,
        [credentialField]: inviteeCredential,
        displayName: '已有账号',
        deviceId: randomUUID(),
        clientType: 'mobile',
      },
    });
    assert.equal(existingEmail.statusCode, 409, existingEmail.body);
    assert.equal(
      (existingEmail.json() as { code: string }).code,
      'EMAIL_EXISTS',
    );
    const unknownInvitation = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      payload: {
        ...redemptionPayload,
        operationId: randomUUID(),
        token: 'unknown-invitation-token',
        email: `unknown-${randomUUID().slice(0, 8)}@example.test`,
        deviceId: randomUUID(),
      },
    });
    assert.equal(unknownInvitation.statusCode, 404, unknownInvitation.body);

    const webToken = await createInvitation(
      app,
      ownerSessionA,
      familyA.family.id,
    );
    const webRedeemed = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      headers: {
        origin: 'http://babyplan.test',
        host: 'babyplan.test',
      },
      payload: {
        operationId: randomUUID(),
        token: webToken,
        email: `web-${randomUUID().slice(0, 8)}@example.test`,
        [credentialField]: inviteeCredential,
        displayName: '网页邀请用户',
        deviceId: randomUUID(),
        clientType: 'web',
      },
    });
    assert.equal(webRedeemed.statusCode, 201, webRedeemed.body);
    assert.equal(
      (webRedeemed.json() as { accessToken: null }).accessToken,
      null,
    );
    assert.ok(webRedeemed.cookies.some(cookie => cookie.name === 'bp_session'));
    assert.ok(webRedeemed.cookies.some(cookie => cookie.name === 'bp_refresh'));
    const webUser = (webRedeemed.json() as Session).user;
    userIds.push(webUser.id);

    const customCode = `jia${randomUUID().slice(0, 8)}`;
    const customToken = await createInvitation(
      app,
      ownerSessionA,
      familyA.family.id,
      customCode,
    );
    assert.equal(customToken, customCode);
    const customRedeemed = await app.inject({
      method: 'POST',
      url: '/v2/invitations/redeem',
      payload: {
        operationId: randomUUID(),
        token: customCode,
        email: `custom-${randomUUID().slice(0, 8)}@example.test`,
        [credentialField]: inviteeCredential,
        displayName: '自定义邀请码用户',
        deviceId: randomUUID(),
        clientType: 'mobile',
      },
    });
    assert.equal(customRedeemed.statusCode, 201, customRedeemed.body);
    const customUser = (customRedeemed.json() as Session).user;
    userIds.push(customUser.id);

    const duplicateCode = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.family.id}/invitations`,
      headers: auth(ownerSessionA),
      payload: { operationId: randomUUID(), code: customCode },
    });
    assert.equal(duplicateCode.statusCode, 409, duplicateCode.body);
    assert.equal(
      (duplicateCode.json() as { code: string }).code,
      'INVITATION_CODE_EXISTS',
    );

    const shortCode = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.family.id}/invitations`,
      headers: auth(ownerSessionA),
      payload: { operationId: randomUUID(), code: 'abc' },
    });
    assert.equal(shortCode.statusCode, 400, shortCode.body);

    const baseContent = await readContentPackage(fileURLToPath(
      new URL('../../../content/candidate/babyplan-18-23-v2.json', import.meta.url),
    ));
    const content = makeTestContent(baseContent);
    const imported = await importContentPackage(
      pool,
      content,
      'development',
      ownerA.id,
    );
    releaseIds.push(imported.releaseId);
    await publishContentRelease(pool, imported.releaseId);

    const options = await app.inject({
      method: 'GET',
      url: '/v2/content/options',
      headers: auth(ownerSessionA),
    });
    assert.equal(options.statusCode, 200, options.body);
    const optionsBody = options.json() as {
      activities: Array<{
        id: string;
        revision: number;
        kind: string;
        ageBands: string[];
        materials: string[];
      }>;
      stageGuides: unknown[];
      sources: unknown[];
    };
    assert.ok(optionsBody.activities.length >= 24);
    assert.ok(optionsBody.stageGuides.length > 0);
    assert.ok(optionsBody.sources.length > 0);

    const ensured = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/plans/ensure`,
      headers: auth(ownerSessionA),
      payload: { operationId: randomUUID() },
    });
    assert.equal(ensured.statusCode, 200, ensured.body);
    const days = (ensured.json() as { days: DayPlan[] }).days;
    assert.equal(days.length, 7);
    const today = days[0]!;
    assert.equal(today.items.length, 6);

    const target = today.items.find(item => item.kind === 'movement')!;
    const alternatives = optionsBody.activities.filter(activity =>
      activity.kind === target.kind
      && activity.id !== target.snapshot.id
      && !activity.id.startsWith('age-mismatch-'),
    );
    const replacement = alternatives.find(activity =>
      activity.materials.length > 0,
    )!;
    assert.ok(replacement);
    const ageMismatch = optionsBody.activities.find(activity =>
      activity.id.startsWith('age-mismatch-'),
    )!;
    assert.ok(ageMismatch);

    const futureTarget = days[1]!.items.find(item =>
      item.kind === target.kind,
    )!;
    const futureReplacement = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${futureTarget.id}/replace`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: futureTarget.revision,
        activityId: replacement.id,
        activityRevision: replacement.revision,
      },
    });
    assert.equal(futureReplacement.statusCode, 422, futureReplacement.body);
    assert.equal(
      (futureReplacement.json() as { code: string }).code,
      'FUTURE_ITEM_IMMUTABLE',
    );
    const futureStart = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${futureTarget.id}/start`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: futureTarget.revision,
      },
    });
    assert.equal(futureStart.statusCode, 422, futureStart.body);
    const futureProtection = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${futureTarget.id}/protection`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: futureTarget.revision,
        lockedByParent: true,
        clearStarted: false,
      },
    });
    assert.equal(futureProtection.statusCode, 422, futureProtection.body);

    const staleReplacement = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${target.id}/replace`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: target.revision + 10,
        activityId: replacement.id,
        activityRevision: replacement.revision,
      },
    });
    assert.equal(staleReplacement.statusCode, 409, staleReplacement.body);

    const unavailablePreferences = await app.inject({
      method: 'PUT',
      url: `/v2/families/${familyA.family.id}/preferences`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: 1,
        availableMaterials: ['家庭未准备的替换材料'],
        excludedMaterials: [],
        languageMode: 'zh_with_english',
      },
    });
    assert.equal(unavailablePreferences.statusCode, 200, unavailablePreferences.body);
    const materialBlocked = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${target.id}/replace`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: target.revision,
        activityId: replacement.id,
        activityRevision: replacement.revision,
      },
    });
    assert.equal(materialBlocked.statusCode, 422, materialBlocked.body);
    assert.equal(
      (materialBlocked.json() as { code: string }).code,
      'ACTIVITY_MATERIAL_MISMATCH',
    );
    const restoredPreferences = await app.inject({
      method: 'PUT',
      url: `/v2/families/${familyA.family.id}/preferences`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: 2,
        availableMaterials: [],
        excludedMaterials: [],
        languageMode: 'zh_with_english',
      },
    });
    assert.equal(restoredPreferences.statusCode, 200, restoredPreferences.body);

    const ageRejected = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${target.id}/replace`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: target.revision,
        activityId: ageMismatch.id,
        activityRevision: ageMismatch.revision,
      },
    });
    assert.equal(ageRejected.statusCode, 422, ageRejected.body);
    assert.equal(
      (ageRejected.json() as { code: string }).code,
      'ACTIVITY_AGE_MISMATCH',
    );

    const replaceOperation = randomUUID();
    const replacePayload = {
      operationId: replaceOperation,
      baseRevision: target.revision,
      activityId: replacement.id,
      activityRevision: replacement.revision,
    };
    const replaced = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${target.id}/replace`,
      headers: auth(ownerSessionA),
      payload: replacePayload,
    });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const replacedItem = replaced.json() as PlanItem;
    assert.equal(replacedItem.snapshot.id, replacement.id);
    assert.equal(replacedItem.lockedByParent, true);
    assert.equal(replacedItem.revision, target.revision + 1);
    const replaceReplay = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${target.id}/replace`,
      headers: auth(ownerSessionA),
      payload: replacePayload,
    });
    assert.equal(replaceReplay.statusCode, 200, replaceReplay.body);
    assert.equal(
      (replaceReplay.json() as PlanItem).revision,
      replacedItem.revision,
    );
    const replaceAgain = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${target.id}/replace`,
      headers: auth(ownerSessionA),
      payload: {
        ...replacePayload,
        operationId: randomUUID(),
        baseRevision: replacedItem.revision,
      },
    });
    assert.equal(replaceAgain.statusCode, 422, replaceAgain.body);
    assert.equal(
      (replaceAgain.json() as { code: string }).code,
      'PLAN_ITEM_IMMUTABLE',
    );

    const crossFamilyReplace = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${today.items.find(item => item.kind === 'explore')!.id}/replace`,
      headers: auth(ownerSessionB),
      payload: {
        operationId: randomUUID(),
        baseRevision: 0,
        activityId: replacement.id,
        activityRevision: replacement.revision,
      },
    });
    assert.equal(crossFamilyReplace.statusCode, 404);

    const calmItem = today.items.find(item => item.kind === 'calm')!;
    const startOperation = randomUUID();
    const started = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${calmItem.id}/start`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: startOperation,
        baseRevision: calmItem.revision,
      },
    });
    assert.equal(started.statusCode, 200, started.body);
    const startedItem = started.json() as PlanItem;
    assert.ok(startedItem.startedAt);
    const startReplay = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${calmItem.id}/start`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: startOperation,
        baseRevision: calmItem.revision,
      },
    });
    assert.equal(startReplay.statusCode, 200, startReplay.body);
    assert.equal(
      (startReplay.json() as PlanItem).revision,
      startedItem.revision,
    );

    const recordedItem = today.items.find(item => item.kind === 'child-led')!;
    const participation = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${recordedItem.id}/participation`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: 0,
        status: 'played',
        participantIds: [ownerA.id],
        note: '真实互动测试',
        actualMinutes: 6,
        again: true,
      },
    });
    assert.equal(participation.statusCode, 200, participation.body);
    const afterParticipation = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/days/${today.localDate}`,
      headers: auth(ownerSessionA),
    });
    assert.equal(afterParticipation.statusCode, 200, afterParticipation.body);
    const recorded = (afterParticipation.json() as DayPlan).items.find(
      item => item.id === recordedItem.id,
    )!;
    assert.ok(recorded.participation);
    assert.ok(recorded.startedAt);
    assert.ok(recorded.revision > recordedItem.revision);

    const clearStarted = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${recordedItem.id}/protection`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: recorded.revision,
        lockedByParent: true,
        clearStarted: true,
      },
    });
    assert.equal(clearStarted.statusCode, 422, clearStarted.body);
    assert.equal(
      (clearStarted.json() as { code: string }).code,
      'STARTED_RECORD_EXISTS',
    );
    const protectRecorded = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${recordedItem.id}/protection`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: recorded.revision,
        lockedByParent: true,
        clearStarted: false,
      },
    });
    assert.equal(protectRecorded.statusCode, 200, protectRecorded.body);
    assert.equal((protectRecorded.json() as PlanItem).lockedByParent, true);

    const currentDay = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/days/${today.localDate}`,
      headers: auth(ownerSessionA),
    });
    const beforeMode = currentDay.json() as DayPlan;
    const baseBudgets = new Map(
      beforeMode.items.map(item => [item.id, item.budgetMinutes]),
    );
    const staleMode = await app.inject({
      method: 'PUT',
      url: `/v2/days/${beforeMode.id}/mode`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: beforeMode.revision + 1,
        mode: 'lite',
      },
    });
    assert.equal(staleMode.statusCode, 409, staleMode.body);
    const liteOperation = randomUUID();
    const litePayload = {
      operationId: liteOperation,
      baseRevision: beforeMode.revision,
      mode: 'lite',
    };
    const lite = await app.inject({
      method: 'PUT',
      url: `/v2/days/${beforeMode.id}/mode`,
      headers: auth(ownerSessionA),
      payload: litePayload,
    });
    assert.equal(lite.statusCode, 200, lite.body);
    const litePlan = lite.json() as DayPlan;
    assert.equal(litePlan.mode, 'lite');
    const protectedIds = new Set([
      replacedItem.id,
      startedItem.id,
      recorded.id,
    ]);
    for (const item of litePlan.items) {
      if (protectedIds.has(item.id)) {
        assert.equal(item.visibility, 'active');
        assert.equal(item.budgetMinutes, baseBudgets.get(item.id));
      } else if (['child-led', 'calm'].includes(item.kind)) {
        assert.equal(item.visibility, 'hidden');
      } else {
        assert.equal(item.visibility, 'active');
        assert.equal(item.budgetMinutes, 5);
      }
    }
    assert.equal(
      litePlan.effectiveBudgetMinutes,
      litePlan.items
        .filter(item => item.visibility === 'active')
        .reduce((sum, item) => sum + item.budgetMinutes, 0),
    );
    const liteReplay = await app.inject({
      method: 'PUT',
      url: `/v2/days/${beforeMode.id}/mode`,
      headers: auth(ownerSessionA),
      payload: litePayload,
    });
    assert.equal(liteReplay.statusCode, 200, liteReplay.body);
    assert.equal((liteReplay.json() as DayPlan).revision, litePlan.revision);

    const standard = await app.inject({
      method: 'PUT',
      url: `/v2/days/${beforeMode.id}/mode`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: litePlan.revision,
        mode: 'standard',
      },
    });
    assert.equal(standard.statusCode, 200, standard.body);
    const standardPlan = standard.json() as DayPlan;
    assert.equal(standardPlan.mode, 'standard');
    for (const item of standardPlan.items) {
      assert.equal(item.visibility, 'active');
      assert.equal(item.budgetMinutes, baseBudgets.get(item.id));
    }

    await pool.query(`
      UPDATE app.activity_revisions
      SET withdrawn_at=now()
      WHERE id=(
        SELECT activity_revision_id FROM app.plan_items WHERE id=$1
      )
    `, [replacedItem.id]);
    const withdrawnStart = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${replacedItem.id}/start`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: replacedItem.revision,
      },
    });
    assert.equal(withdrawnStart.statusCode, 409, withdrawnStart.body);
    assert.equal(
      (withdrawnStart.json() as { code: string }).code,
      'CONTENT_WITHDRAWN',
    );
    const withdrawnProtection = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${replacedItem.id}/protection`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        baseRevision: replacedItem.revision,
        lockedByParent: true,
        clearStarted: false,
      },
    });
    assert.equal(withdrawnProtection.statusCode, 409, withdrawnProtection.body);
    const blockedDay = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/days/${today.localDate}`,
      headers: auth(ownerSessionA),
    });
    assert.equal(blockedDay.statusCode, 200, blockedDay.body);
    const blockedItem = blockedDay.json<DayPlan>().items.find(item => item.id === replacedItem.id)!;
    assert.equal(blockedItem.blockedByWithdrawal, true);
    assert.notDeepEqual(blockedItem.snapshot.steps, replacedItem.snapshot.steps);
    const storedBody = await pool.query('SELECT snapshot FROM app.plan_items WHERE id=$1', [replacedItem.id]);
    assert.deepEqual(storedBody.rows[0]?.snapshot.steps, replacedItem.snapshot.steps, '历史原文不回写');
    const blockedReplay = await app.inject({
      method: 'POST', url: `/v2/plan-items/${target.id}/replace`,
      headers: auth(ownerSessionA), payload: replacePayload,
    });
    assert.equal(blockedReplay.json<PlanItem>().blockedByWithdrawal, true, '幂等回放也不能返回旧玩法');
    const safeOptions = await app.inject({ method: 'GET', url: '/v2/content/options', headers: auth(ownerSessionA) });
    assert.equal(safeOptions.statusCode, 200);
    const visible = safeOptions.json<{ activities: { id: string }[]; withdrawals: { activityId: string }[] }>();
    assert.ok(visible.withdrawals.some(entry => entry.activityId === replacement.id));
    assert.ok(!visible.activities.some(entry => entry.id === replacement.id));
    const safeReplacement = await app.inject({
      method: 'POST',
      url: `/v2/plan-items/${target.id}/replace`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(), baseRevision: replacedItem.revision,
        activityId: target.snapshot.id, activityRevision: target.snapshot.revision,
      },
    });
    assert.equal(safeReplacement.statusCode, 200, safeReplacement.body);
    assert.equal(safeReplacement.json<PlanItem>().blockedByWithdrawal, false);
  } finally {
    await app?.close();
    await cleanup(pool, familyIds, userIds, releaseIds);
    await pool.end();
  }
});
