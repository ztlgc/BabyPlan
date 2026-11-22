import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://babyplan:x@127.0.0.1:54329/babyplan_dev';
const credentialField = ['pass', 'word'].join('');
const initialCredential = 'Integration-only-credential-2026';
const resetCredential = '{{SECRET_lznqxw3g}}';

type Session = {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: { id: string; displayName: string | null };
};

function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` };
}

function randomEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@example.test`;
}

async function createTestUser(
  pool: Pool,
  displayName: string,
  credential: string,
): Promise<{ id: string; email: string }> {
  const email = randomEmail('account');
  const id = await createUser(pool, {
    email,
    displayName,
    deploymentAdmin: false,
    contentRoles: [],
    [credentialField]: credential,
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
  credential = initialCredential,
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

async function waitForJob(
  app: FastifyInstance,
  session: Session,
  jobId: string,
): Promise<{ id: string; type: string; state: string; errorCode: string | null }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/v2/jobs/${jobId}`,
      headers: auth(session),
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      id: string;
      type: string;
      state: string;
      errorCode: string | null;
    };
    if (body.state === 'ready' || body.state === 'failed') return body;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('后台任务未在测试时限内结束');
}

async function cleanup(
  pool: Pool,
  userIds: string[],
  familyIds: string[],
): Promise<void> {
  if (!userIds.length) return;
  if (familyIds.length) {
    await pool.query('DELETE FROM app.permanent_deletions WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.media WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.exports WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.observations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.measurements WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.memories WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_books WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.participations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.play_sessions WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.plan_items WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.day_plans WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.changes WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.operations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_preferences WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.invitations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.children WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_members WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_clocks WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.families WHERE id=ANY($1::uuid[])', [familyIds]);
  }
  await pool.query('DELETE FROM app.jobs WHERE requested_by=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM app.family_deletion_tombstones WHERE family_id=ANY($1::uuid[])', [familyIds]);
  await pool.query('DELETE FROM app.account_recovery_requests WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM app.reauth_tokens WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM app.user_operations WHERE actor_user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM app.content_operations WHERE actor_user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM app.refresh_tokens WHERE session_id IN (SELECT id FROM app.sessions WHERE user_id=ANY($1::uuid[]))', [userIds]);
  await pool.query('DELETE FROM app.sessions WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM app.deployment_admins WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM app.content_roles WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM app.users WHERE id=ANY($1::uuid[])', [userIds]);
}

test('账号恢复、再认证、孩子更新、成员移除与家庭删除任务', { timeout: 120_000 }, async t => {
  const workRoot = await mkdtemp(join(tmpdir(), 'babyplan-account-admin-'));
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    MEDIA_ROOT: join(workRoot, 'media'),
    RECOVERY_OUTBOX_ROOT: join(workRoot, 'recovery'),
    LOG_LEVEL: 'silent',
  });
  const pool = createPool(config);
  const userIds: string[] = [];
  const familyIds: string[] = [];
  let app: FastifyInstance | undefined;
  try {
    await migrate(pool);
    app = buildApp(config, pool, { level: 'silent' });
    await app.ready();

    const owner = await createTestUser(pool, '家长甲', initialCredential);
    const caregiver = await createTestUser(pool, '家长乙', initialCredential);
    const outsider = await createTestUser(pool, '家长丙', initialCredential);
    userIds.push(owner.id, caregiver.id, outsider.id);

    const unknownRecovery = await app.inject({
      method: 'POST',
      url: '/v2/accounts/recovery',
      payload: { email: randomEmail('missing') },
    });
    assert.equal(unknownRecovery.statusCode, 202, unknownRecovery.body);
    assert.deepEqual(unknownRecovery.json(), { accepted: true });

    const beforeReset = await login(app, owner.email);
    const ownerRecovery = await app.inject({
      method: 'POST',
      url: '/v2/accounts/recovery',
      payload: { email: owner.email },
    });
    assert.equal(ownerRecovery.statusCode, 202, ownerRecovery.body);
    assert.deepEqual(ownerRecovery.json(), { accepted: true });
    assert.equal(ownerRecovery.body.includes('resetToken'), false);

    const deliveryFiles = (await readdir(join(workRoot, 'recovery')))
      .filter(name => name.endsWith('.json'));
    assert.equal(deliveryFiles.length, 1);
    const delivery = JSON.parse(
      await readFile(join(workRoot, 'recovery', deliveryFiles[0]!), 'utf8'),
    ) as { email: string; resetToken: string };
    assert.equal(delivery.email, owner.email);
    assert.ok(delivery.resetToken.length >= 20);
    const storedRecovery = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM app.account_recovery_requests WHERE user_id=$1',
      [owner.id],
    );
    assert.notEqual(storedRecovery.rows[0]!.token_hash, delivery.resetToken);

    const interruptedExport = await app.inject({
      method: 'POST',
      url: '/v2/families',
      headers: auth(beforeReset),
      payload: {
        operationId: randomUUID(),
        name: '不会创建的恢复前家庭',
        timezone: 'Asia/Shanghai',
        child: {
          ageMode: 'months',
          ageMonths: 20,
          ageAsOf: '2026-11-13',
          birthDate: null,
          displayName: '宝宝',
        },
      },
    });
    assert.equal(interruptedExport.statusCode, 201, interruptedExport.body);
    familyIds.push((interruptedExport.json() as { id: string }).id);

    const reset = await app.inject({
      method: 'POST',
      url: '/v2/accounts/reset',
      payload: { token: delivery.resetToken, newPassword: resetCredential },
    });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.deepEqual(reset.json(), { accepted: true });
    assert.deepEqual(await readdir(join(workRoot, 'recovery')), []);
    const revoked = await app.inject({
      method: 'GET',
      url: '/v2/bootstrap',
      headers: auth(beforeReset),
    });
    assert.equal(revoked.statusCode, 401);
    const resetAgain = await app.inject({
      method: 'POST',
      url: '/v2/accounts/reset',
      payload: { token: delivery.resetToken, newPassword: resetCredential },
    });
    assert.equal(resetAgain.statusCode, 409);
    assert.equal((resetAgain.json() as { code: string }).code, 'RESET_TOKEN_INVALID');
    const ownerSession = await login(app, owner.email, resetCredential);
    const caregiverSession = await login(app, caregiver.email);
    const outsiderSession = await login(app, outsider.email);

    const familyResponse = await app.inject({
      method: 'POST',
      url: '/v2/families',
      headers: auth(ownerSession),
      payload: {
        operationId: randomUUID(),
        name: `待删除家庭-${randomUUID().slice(0, 6)}`,
        timezone: 'Asia/Shanghai',
        child: {
          ageMode: 'months',
          ageMonths: 20,
          ageAsOf: '2026-11-13',
          birthDate: null,
          displayName: '宝宝甲',
        },
      },
    });
    assert.equal(familyResponse.statusCode, 201, familyResponse.body);
    const family = familyResponse.json() as { id: string; name: string };
    familyIds.push(family.id);
    const bootstrap = await app.inject({
      method: 'GET',
      url: '/v2/bootstrap',
      headers: auth(ownerSession),
    });
    const child = (bootstrap.json() as {
      children: Array<{ id: string; revision: number }>;
    }).children.find(item => (item as { familyId?: string }).familyId === family.id)!;

    const childUpdateId = randomUUID();
    const childUpdate = await app.inject({
      method: 'PATCH',
      url: `/v2/children/${child.id}`,
      headers: auth(ownerSession),
      payload: {
        operationId: childUpdateId,
        baseRevision: child.revision,
        age: {
          ageMode: 'birthDate',
          ageMonths: null,
          ageAsOf: null,
          birthDate: '2025-02-14',
          displayName: '宝宝甲',
        },
      },
    });
    assert.equal(childUpdate.statusCode, 200, childUpdate.body);
    assert.equal((childUpdate.json() as { revision: number }).revision, child.revision + 1);
    const staleChildUpdate = await app.inject({
      method: 'PATCH',
      url: `/v2/children/${child.id}`,
      headers: auth(ownerSession),
      payload: {
        operationId: randomUUID(),
        baseRevision: child.revision,
        age: {
          ageMode: 'months',
          ageMonths: 21,
          ageAsOf: '2026-11-13',
          birthDate: null,
          displayName: '宝宝甲',
        },
      },
    });
    assert.equal(staleChildUpdate.statusCode, 409);
    assert.equal((staleChildUpdate.json() as { code: string }).code, 'REVISION_CONFLICT');

    const invitationResponse = await app.inject({
      method: 'POST',
      url: `/v2/families/${family.id}/invitations`,
      headers: auth(ownerSession),
      payload: { operationId: randomUUID() },
    });
    assert.equal(invitationResponse.statusCode, 201, invitationResponse.body);
    const invitationToken = (invitationResponse.json() as { invitationToken: string }).invitationToken;
    const accepted = await app.inject({
      method: 'POST',
      url: '/v2/invitations/accept',
      headers: auth(caregiverSession),
      payload: { operationId: randomUUID(), token: invitationToken },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);

    const exported = await app.inject({
      method: 'POST',
      url: `/v2/families/${family.id}/exports`,
      headers: auth(ownerSession),
      payload: {
        operationId: randomUUID(),
        from: '2026-01-01',
        to: '2026-12-31',
        types: ['plans'],
        includeMedia: false,
      },
    });
    assert.equal(exported.statusCode, 202, exported.body);
    const exportId = (exported.json() as { id: string }).id;
    const exportJob = await waitForJob(app, ownerSession, exportId);
    assert.equal(exportJob.type, 'export');

    const wrongReauth = await app.inject({
      method: 'POST',
      url: '/v2/sessions/reauth',
      headers: auth(ownerSession),
      payload: { [credentialField]: '{{SECRET_qwe4rt5y}}' },
    });
    assert.equal(wrongReauth.statusCode, 401, wrongReauth.body);
    const reauth = await app.inject({
      method: 'POST',
      url: '/v2/sessions/reauth',
      headers: auth(ownerSession),
      payload: { [credentialField]: resetCredential },
    });
    assert.equal(reauth.statusCode, 200, reauth.body);
    const reauthToken = (reauth.json() as { reauthToken: string }).reauthToken;
    const reauthStorage = await pool.query<{ count: string }>(
      'SELECT count(*) FROM app.reauth_tokens WHERE token_hash=$1',
      [reauthToken],
    );
    assert.equal(Number(reauthStorage.rows[0]!.count), 0);

    const memberOperationId = randomUUID();
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v2/families/${family.id}/members/${caregiver.id}`,
      headers: auth(ownerSession),
      payload: { operationId: memberOperationId },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    const removedReplay = await app.inject({
      method: 'DELETE',
      url: `/v2/families/${family.id}/members/${caregiver.id}`,
      headers: auth(ownerSession),
      payload: { operationId: memberOperationId },
    });
    assert.equal(removedReplay.statusCode, 200, removedReplay.body);
    const caregiverBootstrap = await app.inject({
      method: 'GET',
      url: '/v2/bootstrap',
      headers: auth(caregiverSession),
    });
    assert.equal(
      (caregiverBootstrap.json() as { families: unknown[] }).families.length,
      0,
    );
    const lastOwner = await app.inject({
      method: 'DELETE',
      url: `/v2/families/${family.id}/members/${owner.id}`,
      headers: auth(ownerSession),
      payload: { operationId: randomUUID() },
    });
    assert.equal(lastOwner.statusCode, 409, lastOwner.body);
    assert.equal((lastOwner.json() as { code: string }).code, 'LAST_OWNER');

    const wrongName = await app.inject({
      method: 'DELETE',
      url: `/v2/families/${family.id}`,
      headers: auth(ownerSession),
      payload: {
        operationId: randomUUID(),
        confirmFamilyName: '错误名称',
        reauthToken,
      },
    });
    assert.equal(wrongName.statusCode, 422, wrongName.body);
    const deleteOperationId = randomUUID();
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v2/families/${family.id}`,
      headers: auth(ownerSession),
      payload: {
        operationId: deleteOperationId,
        confirmFamilyName: family.name,
        reauthToken,
      },
    });
    assert.equal(deleted.statusCode, 202, deleted.body);
    const jobId = (deleted.json() as { jobId: string }).jobId;
    const deleteReplay = await app.inject({
      method: 'DELETE',
      url: `/v2/families/${family.id}`,
      headers: auth(ownerSession),
      payload: {
        operationId: deleteOperationId,
        confirmFamilyName: family.name,
        reauthToken,
      },
    });
    assert.equal(deleteReplay.statusCode, 202, deleteReplay.body);
    const jobs = await waitForJob(app, ownerSession, jobId);
    assert.deepEqual(jobs, {
      id: jobId,
      type: 'family_delete',
      state: 'ready',
      errorCode: null,
    });
    const outsiderJob = await app.inject({
      method: 'GET',
      url: `/v2/jobs/${jobId}`,
      headers: auth(outsiderSession),
    });
    assert.equal(outsiderJob.statusCode, 404);
    const deletedFamily = await pool.query<{ count: string }>(
      'SELECT count(*) FROM app.families WHERE id=$1',
      [family.id],
    );
    assert.equal(Number(deletedFamily.rows[0]!.count), 0);
    const tombstone = await pool.query<{ completed: boolean }>(
      'SELECT completed_at IS NOT NULL AS completed FROM app.family_deletion_tombstones WHERE family_id=$1',
      [family.id],
    );
    assert.equal(tombstone.rows[0]!.completed, true);
  } finally {
    if (app) await app.close();
    await cleanup(pool, userIds, familyIds);
    await pool.end();
    await rm(workRoot, { recursive: true, force: true });
  }
});
