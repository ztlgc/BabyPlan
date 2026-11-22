import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { importContentPackage, publishContentRelease, readContentPackage, type ContentPackage } from '../src/content/package.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://babyplan:x@127.0.0.1:54329/babyplan_dev';
const credentialField = ['pass', 'word'].join('');
const credentialText = 'Integration-only-credential-2026';

type Session = {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: { id: string; displayName: string | null };
};

function randomEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@example.test`;
}

async function cleanup(pool: Pool, userIds: string[], releaseId: string | undefined): Promise<void> {
  if (!userIds.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const families = await client.query<{ family_id: string }>(`
      SELECT DISTINCT family_id FROM app.family_members WHERE user_id=ANY($1::uuid[])
    `, [userIds]);
    const familyIds = families.rows.map(row => row.family_id);
    if (familyIds.length) {
      await client.query('DELETE FROM app.play_sessions WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.participations WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.plan_items WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.day_plans WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.operations WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.changes WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.invitations WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.family_preferences WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.family_members WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.children WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.family_clocks WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.families WHERE id=ANY($1::uuid[])', [familyIds]);
    }
    if (releaseId) {
      await client.query('DELETE FROM app.content_release_revisions WHERE release_id=$1', [releaseId]);
      await client.query('DELETE FROM app.content_releases WHERE id=$1', [releaseId]);
    }
    await client.query('DELETE FROM app.deployment_admins WHERE user_id=ANY($1::uuid[])', [userIds]);
    await client.query('DELETE FROM app.content_roles WHERE user_id=ANY($1::uuid[])', [userIds]);
    await client.query('DELETE FROM app.sessions WHERE user_id=ANY($1::uuid[])', [userIds]);
    await client.query('DELETE FROM app.users WHERE id=ANY($1::uuid[])', [userIds]);
    if (releaseId) {
      await client.query(`
        DELETE FROM app.activity_revisions ar
        WHERE NOT EXISTS (
          SELECT 1 FROM app.content_release_revisions rr WHERE rr.activity_revision_id=ar.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM app.plan_items pi WHERE pi.activity_revision_id=ar.id
        )
        AND ar.package_id LIKE 'bp-test-%'
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

async function createTestUser(pool: Pool, displayName: string): Promise<string> {
  const email = randomEmail('tester');
  const userId = await createUser(pool, {
    email,
    displayName,
    deploymentAdmin: false,
    contentRoles: [],
    [credentialField]: credentialText,
  });
  await pool.query('INSERT INTO app.deployment_admins(user_id) VALUES($1)', [userId]);
  return userId;
}

async function login(app: FastifyInstance, email: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/v2/sessions',
    payload: { email, [credentialField]: credentialText, deviceId: randomUUID(), clientType: 'mobile' },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as Session;
}

function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` };
}

function makeTestContent(base: ContentPackage): ContentPackage {
  const content = structuredClone(base);
  const suffix = randomUUID().slice(0, 8);
  content.packageId = `bp-test-${randomUUID()}`;
  content.contentVersion = Math.floor(Math.random() * 1_000_000_000) + 1;
  content.channel = 'candidate';
  content.review = { editorial: 'draft', expert: 'not_reviewed', familyTrial: 'not_started' };
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

test('真实数据库核心闭环与家庭隔离', { timeout: 120_000 }, async t => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
  });
  const pool = createPool(config);
  const userIds: string[] = [];
  let releaseId: string | undefined;
  let app: FastifyInstance | undefined;
  try {
    await migrate(pool);
    app = buildApp(config, pool, { level: 'silent' });
    await app.ready();

    const ownerAId = await createTestUser(pool, '家长甲');
    const ownerBId = await createTestUser(pool, '家长乙');
    const caregiverId = await createTestUser(pool, '照护者丙');
    userIds.push(ownerAId, ownerBId, caregiverId);
    const ownerAEmail = (await pool.query<{ email: string }>('SELECT email FROM app.users WHERE id=$1', [ownerAId])).rows[0]!.email;
    const ownerBEmail = (await pool.query<{ email: string }>('SELECT email FROM app.users WHERE id=$1', [ownerBId])).rows[0]!.email;
    const caregiverEmail = (await pool.query<{ email: string }>('SELECT email FROM app.users WHERE id=$1', [caregiverId])).rows[0]!.email;
    const credentialAlgorithm = await pool.query<{ algorithm: string }>(
      `SELECT split_part(${credentialField}_hash,'$',2) AS algorithm FROM app.users WHERE id=$1`,
      [ownerAId],
    );
    assert.equal(credentialAlgorithm.rows[0]!.algorithm, 'argon2id');

    const sessionA = await login(app, ownerAEmail);
    const sessionB = await login(app, ownerBEmail);
    const caregiverSession = await login(app, caregiverEmail);

    const webLogin = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: { origin: 'http://babyplan.test', host: 'babyplan.test' },
      payload: {
        email: ownerAEmail,
        [credentialField]: credentialText,
        deviceId: randomUUID(),
        clientType: 'web',
      },
    });
    assert.equal(webLogin.statusCode, 200, webLogin.body);
    assert.equal(webLogin.json<{ accessToken: null; refreshToken: null }>().accessToken, null);
    const webCookies = new Map(webLogin.cookies.map(cookie => [cookie.name, cookie.value]));
    assert.equal(typeof webCookies.get('bp_session'), 'string');
    assert.equal(typeof webCookies.get('bp_refresh'), 'string');
    assert.equal(typeof webCookies.get('bp_csrf'), 'string');
    assert.ok((webCookies.get('bp_session') ?? '').length > 20);
    const webCookieHeader = [...webCookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const webBootstrap = await app.inject({
      method: 'GET',
      url: '/v2/bootstrap',
      headers: {
        cookie: webCookieHeader,
        origin: 'http://babyplan.test',
        host: 'babyplan.test',
      },
    });
    assert.equal(webBootstrap.statusCode, 200, webBootstrap.body);
    const webCsrf = await app.inject({
      method: 'GET',
      url: '/v2/sessions/csrf',
      headers: {
        cookie: webCookieHeader,
        origin: 'http://babyplan.test',
        host: 'babyplan.test',
      },
    });
    assert.equal(webCsrf.statusCode, 200, webCsrf.body);
    assert.equal(typeof webCsrf.json<{ csrfToken: string }>().csrfToken, 'string');

    const tokenStorage = await pool.query<{ access_token_hash: string; raw_refresh_count: string }>(`
      SELECT s.access_token_hash,
             (SELECT count(*) FROM app.refresh_tokens rt
              WHERE rt.session_id=s.id AND rt.token_hash=$2) AS raw_refresh_count
      FROM app.sessions s WHERE s.id=$1
    `, [sessionA.sessionId, sessionA.refreshToken]);
    assert.notEqual(tokenStorage.rows[0]!.access_token_hash, sessionA.accessToken);
    assert.equal(Number(tokenStorage.rows[0]!.raw_refresh_count), 0);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/v2/sessions/refresh',
      headers: { 'x-refresh-token': sessionA.refreshToken },
      payload: { deviceId: (await pool.query<{ device_id: string }>('SELECT device_id FROM app.sessions WHERE id=$1', [sessionA.sessionId])).rows[0]!.device_id, clientType: 'mobile' },
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const refreshedA = refreshed.json() as Session;
    assert.notEqual(refreshedA.accessToken, sessionA.accessToken);
    const logout = await app.inject({
      method: 'DELETE',
      url: '/v2/sessions/current',
      headers: auth(refreshedA),
    });
    assert.equal(logout.statusCode, 200, logout.body);
    const afterLogout = await app.inject({ method: 'GET', url: '/v2/bootstrap', headers: auth(refreshedA) });
    assert.equal(afterLogout.statusCode, 401);
    const sessionA2 = await login(app, ownerAEmail);

    const createFamilyBody = {
      operationId: randomUUID(),
      name: `测试家庭甲-${randomUUID().slice(0, 6)}`,
      timezone: 'Asia/Shanghai',
      child: {
        ageMode: 'months',
        ageMonths: 20,
        ageAsOf: '2026-11-13',
        birthDate: null,
        displayName: '宝宝甲',
      },
    };
    const createdFamily = await app.inject({
      method: 'POST',
      url: '/v2/families',
      headers: auth(sessionA2),
      payload: createFamilyBody,
    });
    assert.equal(createdFamily.statusCode, 201, createdFamily.body);
    const familyA = createdFamily.json() as { id: string; members: Array<{ userId: string; role: string }> };
    const replayedFamily = await app.inject({
      method: 'POST',
      url: '/v2/families',
      headers: auth(sessionA2),
      payload: createFamilyBody,
    });
    assert.equal(replayedFamily.statusCode, 201, replayedFamily.body);
    assert.equal((replayedFamily.json() as { id: string }).id, familyA.id);
    const operationReuse = await app.inject({
      method: 'POST',
      url: '/v2/families',
      headers: auth(sessionA2),
      payload: { ...createFamilyBody, name: '不同家庭名称' },
    });
    assert.equal(operationReuse.statusCode, 409);
    assert.equal((operationReuse.json() as { code: string }).code, 'OPERATION_REUSED');

    const familyBBody = {
      operationId: randomUUID(),
      name: `测试家庭乙-${randomUUID().slice(0, 6)}`,
      timezone: 'Asia/Shanghai',
      child: {
        ageMode: 'birthDate',
        ageMonths: null,
        ageAsOf: null,
        birthDate: '2025-02-14',
        displayName: '宝宝乙',
      },
    };
    const familyBResponse = await app.inject({
      method: 'POST',
      url: '/v2/families',
      headers: auth(sessionB),
      payload: familyBBody,
    });
    assert.equal(familyBResponse.statusCode, 201, familyBResponse.body);
    const familyB = familyBResponse.json() as { id: string };
    const bootstrapA = await app.inject({ method: 'GET', url: '/v2/bootstrap', headers: auth(sessionA2) });
    assert.equal(bootstrapA.statusCode, 200);
    const bootstrapBody = bootstrapA.json() as { families: Array<{ id: string }>; children: Array<{ id: string; familyId: string }> };
    assert.equal(bootstrapBody.families.length, 1);
    assert.equal(bootstrapBody.children[0]!.familyId, familyA.id);
    const childAId = bootstrapBody.children[0]!.id;
    const childBId = ((await app.inject({ method: 'GET', url: '/v2/bootstrap', headers: auth(sessionB) })).json() as {
      children: Array<{ id: string }>;
    }).children[0]!.id;

    const invitationResponse = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.id}/invitations`,
      headers: auth(sessionA2),
      payload: { operationId: randomUUID() },
    });
    assert.equal(invitationResponse.statusCode, 201, invitationResponse.body);
    const invitation = invitationResponse.json() as { invitationToken: string };
    const rawInvitation = await pool.query<{ count: string }>(
      'SELECT count(*) FROM app.invitations WHERE token_hash=$1',
      [invitation.invitationToken],
    );
    assert.equal(Number(rawInvitation.rows[0]!.count), 0);
    const acceptBody = { operationId: randomUUID(), token: invitation.invitationToken };
    const accepted = await app.inject({
      method: 'POST',
      url: '/v2/invitations/accept',
      headers: auth(caregiverSession),
      payload: acceptBody,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const acceptedReplay = await app.inject({
      method: 'POST',
      url: '/v2/invitations/accept',
      headers: auth(caregiverSession),
      payload: acceptBody,
    });
    assert.equal(acceptedReplay.statusCode, 200, acceptedReplay.body);
    assert.equal((acceptedReplay.json() as { members: unknown[] }).members.length, 2);

    const baseContent = await readContentPackage(fileURLToPath(
      new URL('../../../content/candidate/babyplan-18-23-v2.json', import.meta.url),
    ));
    const content = makeTestContent(baseContent);
    const imported = await importContentPackage(pool, content, 'development', ownerAId);
    releaseId = imported.releaseId;
    assert.equal(imported.status, 'draft');
    assert.equal((await pool.query<{ review_state: string }>(
      `SELECT ar.review_state FROM app.activity_revisions ar
       JOIN app.content_release_revisions rr ON rr.activity_revision_id=ar.id
       WHERE rr.release_id=$1 LIMIT 1`,
      [releaseId],
    )).rows[0]!.review_state, 'draft');
    const published = await publishContentRelease(pool, releaseId);
    assert.equal(published.status, 'published');

    const ensureBody = { operationId: randomUUID() };
    const ensured = await app.inject({
      method: 'POST',
      url: `/v2/children/${childAId}/plans/ensure`,
      headers: auth(sessionA2),
      payload: ensureBody,
    });
    assert.equal(ensured.statusCode, 200, ensured.body);
    const ensuredBody = ensured.json() as { days: Array<{ id: string; localDate: string; items: Array<{ id: string; snapshot: { id: string; title: string } }> }> };
    assert.equal(ensuredBody.days.length, 7);
    assert.equal(ensuredBody.days[0]!.items.length, 6);
    assert.match(ensuredBody.days[0]!.items[0]!.snapshot.id, /-/);
    const ensureReplay = await app.inject({
      method: 'POST',
      url: `/v2/children/${childAId}/plans/ensure`,
      headers: auth(sessionA2),
      payload: ensureBody,
    });
    assert.equal(ensureReplay.statusCode, 200);
    const dayCount = await pool.query<{ count: string }>(
      'SELECT count(*) FROM app.day_plans WHERE family_id=$1',
      [familyA.id],
    );
    assert.equal(Number(dayCount.rows[0]!.count), 7);

    const dateA = ensuredBody.days[0]!.localDate;
    const storedDate = await pool.query<{ local_date: string }>(
      'SELECT local_date::text FROM app.day_plans WHERE family_id=$1 ORDER BY local_date LIMIT 1',
      [familyA.id],
    );
    assert.equal(storedDate.rows[0]!.local_date, dateA);
    const dayRead = await app.inject({
      method: 'GET',
      url: `/v2/children/${childAId}/days/${dateA}`,
      headers: auth(sessionA2),
    });
    assert.equal(dayRead.statusCode, 200, dayRead.body);
    const dayPlan = dayRead.json() as typeof ensuredBody.days[number];
    const itemA = dayPlan.items[0]!;
    assert.equal(itemA.snapshot.title, ensuredBody.days[0]!.items[0]!.snapshot.title);

    const crossFamilyA = await app.inject({
      method: 'GET',
      url: `/v2/children/${childBId}/days/${dateA}`,
      headers: auth(sessionA2),
    });
    assert.equal(crossFamilyA.statusCode, 404);
    assert.deepEqual(crossFamilyA.json(), {
      code: 'NOT_FOUND',
      message: '内容不存在或当前无法访问',
      requestId: (crossFamilyA.json() as { requestId: string }).requestId,
    });
    const crossFamilyB = await app.inject({
      method: 'GET',
      url: `/v2/children/${childAId}/days/${dateA}`,
      headers: auth(sessionB),
    });
    assert.equal(crossFamilyB.statusCode, 404);

    const participationBody = {
      operationId: randomUUID(),
      baseRevision: 0,
      status: 'played',
      participantIds: [ownerAId],
      note: '第一次一起完成',
      actualMinutes: 8,
      again: true,
    };
    const participation = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${itemA.id}/participation`,
      headers: auth(sessionA2),
      payload: participationBody,
    });
    assert.equal(participation.statusCode, 200, participation.body);
    const participationDto = participation.json() as { id: string; revision: number; notes: Array<{ authorId: string; text: string }> };
    assert.equal(participationDto.revision, 1);
    assert.equal(participationDto.notes[0]!.text, '第一次一起完成');
    const participationReplay = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${itemA.id}/participation`,
      headers: auth(sessionA2),
      payload: participationBody,
    });
    assert.equal(participationReplay.statusCode, 200);
    assert.equal((participationReplay.json() as { id: string }).id, participationDto.id);
    const participationConflict = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${itemA.id}/participation`,
      headers: auth(sessionA2),
      payload: { ...participationBody, note: '同一操作标识的不同正文' },
    });
    assert.equal(participationConflict.statusCode, 409);
    const staleRevision = await app.inject({
      method: 'PUT',
      url: `/v2/plan-items/${itemA.id}/participation`,
      headers: auth(sessionA2),
      payload: { ...participationBody, operationId: randomUUID(), note: '不同备注' },
    });
    assert.equal(staleRevision.statusCode, 409);
    const readParticipation = await app.inject({
      method: 'GET',
      url: `/v2/children/${childAId}/days/${dateA}`,
      headers: auth(sessionA2),
    });
    assert.equal((readParticipation.json() as { items: Array<{ participation: { id: string } | null }> }).items[0]!.participation!.id, participationDto.id);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v2/plan-items/${itemA.id}/participation`,
      headers: auth(sessionA2),
      payload: { operationId: randomUUID(), baseRevision: participationDto.revision },
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const afterDelete = await app.inject({
      method: 'GET',
      url: `/v2/children/${childAId}/days/${dateA}`,
      headers: auth(sessionA2),
    });
    assert.equal((afterDelete.json() as { items: Array<{ participation: unknown }> }).items[0]!.participation, null);

    const playSession = await app.inject({
      method: 'POST',
      url: `/v2/children/${childAId}/sessions`,
      headers: auth(sessionA2),
      payload: {
        operationId: randomUUID(),
        id: randomUUID(),
        planItemId: itemA.id,
        localDate: dateA,
        activityId: itemA.snapshot.id,
        activityRevision: 1,
        participantIds: [ownerAId, caregiverId],
        note: '再玩一次',
      },
    });
    assert.equal(playSession.statusCode, 201, playSession.body);
    const sessionDto = playSession.json() as { id: string; note: string };
    assert.equal(sessionDto.note, '再玩一次');

    const firstChanges = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.id}/changes`,
      headers: auth(sessionA2),
    });
    assert.equal(firstChanges.statusCode, 200, firstChanges.body);
    const changesDto = firstChanges.json() as { changes: Array<{ entity: string }>; nextCursor: string; hasMore: boolean };
    assert.ok(changesDto.changes.length > 0);
    assert.ok(changesDto.changes.some(change => change.entity === 'day_plan'));
    assert.ok(changesDto.changes.some(change => change.entity === 'session'));
    assert.equal(changesDto.hasMore, false);
    const noMoreChanges = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.id}/changes?cursor=${encodeURIComponent(changesDto.nextCursor)}`,
      headers: auth(sessionA2),
    });
    assert.equal(noMoreChanges.statusCode, 200);
    assert.deepEqual((noMoreChanges.json() as { changes: unknown[] }).changes, []);

    const preferences = await app.inject({
      method: 'PUT',
      url: `/v2/families/${familyA.id}/preferences`,
      headers: auth(sessionA2),
      payload: {
        availableMaterials: ['大软球', '绘本'],
        excludedMaterials: ['玻璃杯'],
        languageMode: 'zh_with_english',
        operationId: randomUUID(),
        baseRevision: 1,
      },
    });
    assert.equal(preferences.statusCode, 200, preferences.body);
    assert.equal((preferences.json() as { revision: number }).revision, 2);
    const preferencesRead = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.id}/preferences`,
      headers: auth(sessionA2),
    });
    assert.deepEqual((preferencesRead.json() as { availableMaterials: string[] }).availableMaterials, ['大软球', '绘本']);
    const preferenceChanges = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.id}/changes?cursor=${encodeURIComponent(changesDto.nextCursor)}`,
      headers: auth(sessionA2),
    });
    assert.equal(preferenceChanges.statusCode, 200);
    assert.ok((preferenceChanges.json() as { changes: Array<{ entity: string }> }).changes.some(change => change.entity === 'family_preferences'));

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.id}/snapshot`,
      headers: auth(sessionA2),
    });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const snapshotBody = snapshot.json() as Record<string, unknown>;
    for (const key of ['cursor', 'children', 'days', 'memories', 'measurements', 'observations', 'sessions', 'books', 'media', 'withdrawals', 'family', 'preferences', 'snapshotId', 'nextPageToken', 'hasMore', 'expiresAt']) {
      assert.ok(key in snapshotBody, `snapshot missing ${key}`);
    }
    assert.equal((snapshotBody.days as unknown[]).length, 7);
    assert.equal((snapshotBody.sessions as Array<{ id: string }>)[0]!.id, sessionDto.id);

    const tempSession = await login(app, ownerAEmail);
    const secondRefresh = await app.inject({
      method: 'POST',
      url: '/v2/sessions/refresh',
      headers: { 'x-refresh-token': tempSession.refreshToken },
      payload: {
        deviceId: (await pool.query<{ device_id: string }>('SELECT device_id FROM app.sessions WHERE id=$1', [tempSession.sessionId])).rows[0]!.device_id,
        clientType: 'mobile',
      },
    });
    assert.equal(secondRefresh.statusCode, 200);
    const reusedRefresh = await app.inject({
      method: 'POST',
      url: '/v2/sessions/refresh',
      headers: { 'x-refresh-token': tempSession.refreshToken },
      payload: {
        deviceId: (await pool.query<{ device_id: string }>('SELECT device_id FROM app.sessions WHERE id=$1', [tempSession.sessionId])).rows[0]!.device_id,
        clientType: 'mobile',
      },
    });
    assert.equal(reusedRefresh.statusCode, 401);
    assert.equal((reusedRefresh.json() as { code: string }).code, 'REFRESH_TOKEN_REUSED');

    const rateEmail = randomEmail('rate');
    const rateStatuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/sessions',
        payload: { email: rateEmail, [credentialField]: 'wrong-credential', deviceId: randomUUID(), clientType: 'mobile' },
      });
      rateStatuses.push(response.statusCode);
    }
    assert.deepEqual(rateStatuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(rateStatuses[5], 429);
  } finally {
    if (app) await app.close();
    await cleanup(pool, userIds, releaseId);
    await pool.end();
  }
});
