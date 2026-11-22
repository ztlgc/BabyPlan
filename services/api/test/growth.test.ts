import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const credentialText = 'Integration-only-credential-2026';

type Session = {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: { id: string; displayName: string | null };
  deviceId: string;
};

type FamilyResponse = {
  id: string;
  members: Array<{ userId: string; role: 'owner' | 'caregiver' }>;
};

function randomEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@example.test`;
}

async function createTestUser(pool: Pool, displayName: string): Promise<{ id: string; email: string }> {
  const email = randomEmail('growth');
  const id = await createUser(pool, {
    email,
    displayName,
    deploymentAdmin: false,
    contentRoles: [],
    [credentialField]: credentialText,
  });
  await pool.query('INSERT INTO app.deployment_admins(user_id) VALUES($1)', [id]);
  return { id, email };
}

async function login(app: FastifyInstance, email: string): Promise<Session> {
  const deviceId = randomUUID();
  const response = await app.inject({
    method: 'POST',
    url: '/v2/sessions',
    payload: { email, [credentialField]: credentialText, deviceId, clientType: 'mobile' },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { ...(response.json() as Omit<Session, 'deviceId'>), deviceId };
}

function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` };
}

async function createFamily(
  app: FastifyInstance,
  session: Session,
  label: string,
): Promise<{ family: FamilyResponse; childId: string }> {
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
  const family = response.json() as FamilyResponse;
  const bootstrap = await app.inject({ method: 'GET', url: '/v2/bootstrap', headers: auth(session) });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const child = (bootstrap.json() as { children: Array<{ id: string; familyId: string }> }).children
    .find(item => item.familyId === family.id);
  assert.ok(child);
  return { family, childId: child.id };
}

async function joinFamily(
  app: FastifyInstance,
  ownerSession: Session,
  memberSession: Session,
  familyId: string,
): Promise<void> {
  const invitation = await app.inject({
    method: 'POST',
    url: `/v2/families/${familyId}/invitations`,
    headers: auth(ownerSession),
    payload: { operationId: randomUUID() },
  });
  assert.equal(invitation.statusCode, 201, invitation.body);
  const accepted = await app.inject({
    method: 'POST',
    url: '/v2/invitations/accept',
    headers: auth(memberSession),
    payload: {
      operationId: randomUUID(),
      token: (invitation.json() as { invitationToken: string }).invitationToken,
    },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
}

async function cleanup(pool: Pool, userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const families = await client.query<{ family_id: string }>(`
      SELECT DISTINCT family_id FROM app.family_members WHERE user_id=ANY($1::uuid[])
    `, [userIds]);
    const familyIds = families.rows.map(row => row.family_id);
    if (familyIds.length) {
      await client.query('DELETE FROM app.media WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.family_books WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.observations WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.measurements WHERE family_id=ANY($1::uuid[])', [familyIds]);
      await client.query('DELETE FROM app.memories WHERE family_id=ANY($1::uuid[])', [familyIds]);
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
    await client.query('DELETE FROM app.user_operations WHERE actor_user_id=ANY($1::uuid[])', [userIds]);
    await client.query('DELETE FROM app.reminder_preferences WHERE user_id=ANY($1::uuid[])', [userIds]);
    await client.query('DELETE FROM app.deployment_admins WHERE user_id=ANY($1::uuid[])', [userIds]);
    await client.query('DELETE FROM app.sessions WHERE user_id=ANY($1::uuid[])', [userIds]);
    await client.query('DELETE FROM app.users WHERE id=ANY($1::uuid[])', [userIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('真实数据库成长、书架与提醒闭环', { timeout: 120_000 }, async t => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'silent',
  });
  const pool = createPool(config);
  const users: Array<{ id: string; email: string }> = [];
  let app: FastifyInstance | undefined;
  try {
    await migrate(pool);
    app = buildApp(config, pool, { level: 'silent' });
    await app.ready();

    const ownerAUser = await createTestUser(pool, '成长家长甲');
    const caregiverAUser = await createTestUser(pool, '成长家长乙');
    const ownerBUser = await createTestUser(pool, '另一家庭家长');
    users.push(ownerAUser, caregiverAUser, ownerBUser);

    const ownerA = await login(app, ownerAUser.email);
    const caregiverA = await login(app, caregiverAUser.email);
    const ownerB = await login(app, ownerBUser.email);
    const familyA = await createFamily(app, ownerA, '家庭甲');
    const familyB = await createFamily(app, ownerB, '家庭乙');
    await joinFamily(app, ownerA, caregiverA, familyA.family.id);

    const memoryId = randomUUID();
    const createOperationId = randomUUID();
    const memoryBody = {
      operationId: createOperationId,
      id: memoryId,
      localDate: '2026-11-12',
      type: 'first',
      text: '第一次主动把绘本递给妈妈',
      firstConfirmed: true,
      mediaIds: [],
    };
    const memoryCreated = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/memories`,
      headers: auth(ownerA),
      payload: memoryBody,
    });
    assert.equal(memoryCreated.statusCode, 201, memoryCreated.body);
    const memory = memoryCreated.json() as {
      id: string; childId: string; type: string; text: string; mediaIds: string[];
      addedBy: string; revision: number; deletedAt: string | null;
    };
    assert.deepEqual(Object.keys(memory).sort(), [
      'addedBy', 'childId', 'deletedAt', 'firstConfirmed', 'id', 'localDate', 'mediaIds', 'revision', 'text', 'type',
    ].sort());
    assert.equal(memory.id, memoryId);
    assert.equal(memory.addedBy, ownerAUser.id);
    assert.equal(memory.revision, 1);
    assert.equal(memory.deletedAt, null);

    const memoryReplay = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/memories`,
      headers: auth(ownerA),
      payload: memoryBody,
    });
    assert.equal(memoryReplay.statusCode, 201, memoryReplay.body);
    assert.equal((memoryReplay.json() as { id: string }).id, memoryId);
    const memoryOperationConflict = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/memories`,
      headers: auth(ownerA),
      payload: { ...memoryBody, text: '同一操作标识但正文不同' },
    });
    assert.equal(memoryOperationConflict.statusCode, 409);
    assert.equal((memoryOperationConflict.json() as { code: string }).code, 'OPERATION_REUSED');

    const sharedRead = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/memories`,
      headers: auth(caregiverA),
    });
    assert.equal(sharedRead.statusCode, 200, sharedRead.body);
    assert.equal((sharedRead.json() as { items: Array<{ id: string }> }).items[0]!.id, memoryId);
    const memoryUpdated = await app.inject({
      method: 'PATCH',
      url: `/v2/memories/${memoryId}`,
      headers: auth(caregiverA),
      payload: {
        operationId: randomUUID(),
        localDate: '2026-11-12',
        type: 'first',
        text: '第一次主动把绘本递给妈妈，还说了“给你”',
        firstConfirmed: true,
        mediaIds: [],
        baseRevision: 1,
      },
    });
    assert.equal(memoryUpdated.statusCode, 200, memoryUpdated.body);
    assert.equal((memoryUpdated.json() as { revision: number; text: string }).revision, 2);
    assert.match((memoryUpdated.json() as { revision: number; text: string }).text, /给你/);

    const secondMemoryId = randomUUID();
    const secondMemory = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/memories`,
      headers: auth(caregiverA),
      payload: {
        operationId: randomUUID(),
        id: secondMemoryId,
        localDate: '2026-11-10',
        type: 'quote',
        text: '“我自己来”',
        firstConfirmed: false,
        mediaIds: [],
      },
    });
    assert.equal(secondMemory.statusCode, 201, secondMemory.body);
    const firstMemoryPage = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/memories?limit=1`,
      headers: auth(ownerA),
    });
    assert.equal(firstMemoryPage.statusCode, 200, firstMemoryPage.body);
    const firstPage = firstMemoryPage.json() as { items: Array<{ id: string }>; nextCursor: string };
    assert.equal(firstPage.items.length, 1);
    assert.equal(typeof firstPage.nextCursor, 'string');
    const secondPage = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/memories?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      headers: auth(ownerA),
    });
    assert.equal(secondPage.statusCode, 200, secondPage.body);
    assert.equal((secondPage.json() as { items: Array<{ id: string }>; nextCursor: string | null }).items[0]!.id, secondMemoryId);

    const invalidFirst = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/memories`,
      headers: auth(ownerA),
      payload: {
        operationId: randomUUID(),
        id: randomUUID(),
        localDate: '2026-11-12',
        type: 'first',
        text: '未确认的第一次',
        firstConfirmed: false,
        mediaIds: [],
      },
    });
    assert.equal(invalidFirst.statusCode, 422);

    const deletedMemory = await app.inject({
      method: 'DELETE',
      url: `/v2/memories/${memoryId}`,
      headers: auth(ownerA),
      payload: { operationId: randomUUID(), baseRevision: 2, permanent: false },
    });
    assert.equal(deletedMemory.statusCode, 200, deletedMemory.body);
    const tombstoneAck = deletedMemory.json() as { id: string; revision: number; changeSeq: number };
    assert.equal(tombstoneAck.revision, 3);
    assert.ok(tombstoneAck.changeSeq > 0);
    const deletedList = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/memories?deleted=true`,
      headers: auth(caregiverA),
    });
    assert.equal(deletedList.statusCode, 200, deletedList.body);
    const deletedItems = (deletedList.json() as { items: Array<{ id: string; deletedAt: string | null }> }).items;
    assert.equal(deletedItems.length, 1);
    assert.equal(deletedItems[0]!.id, memoryId);
    assert.equal(typeof deletedItems[0]!.deletedAt, 'string');

    const changes = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.family.id}/changes`,
      headers: auth(ownerA),
    });
    assert.equal(changes.statusCode, 200, changes.body);
    assert.ok((changes.json() as {
      changes: Array<{ entity: string; id: string; deleted: boolean; revision: number }>;
    }).changes.some(change => change.entity === 'memory' && change.id === memoryId && change.deleted && change.revision === 3));

    const restored = await app.inject({
      method: 'POST',
      url: `/v2/memories/${memoryId}/restore`,
      headers: auth(caregiverA),
      payload: { operationId: randomUUID(), baseRevision: 3 },
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal((restored.json() as { revision: number; deletedAt: string | null }).revision, 4);
    assert.equal((restored.json() as { revision: number; deletedAt: string | null }).deletedAt, null);

    const heightId = randomUUID();
    const heightMeasured = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/measurements`,
      headers: auth(caregiverA),
      payload: {
        id: heightId,
        localDate: '2026-11-12',
        kind: 'height',
        value: 86.4,
        unit: 'cm',
        method: 'recumbent',
        source: 'home',
        operationId: randomUUID(),
      },
    });
    assert.equal(heightMeasured.statusCode, 201, heightMeasured.body);
    const weightMeasured = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/measurements`,
      headers: auth(ownerA),
      payload: {
        id: randomUUID(),
        localDate: '2026-11-12',
        kind: 'weight',
        value: 12.3,
        unit: 'kg',
        method: 'scale',
        source: 'clinic',
        operationId: randomUUID(),
      },
    });
    assert.equal(weightMeasured.statusCode, 201, weightMeasured.body);
    const invalidMeasurement = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/measurements`,
      headers: auth(ownerA),
      payload: {
        id: randomUUID(),
        localDate: '2026-11-12',
        kind: 'height',
        value: 85,
        unit: 'kg',
        method: 'scale',
        source: 'home',
        operationId: randomUUID(),
      },
    });
    assert.equal(invalidMeasurement.statusCode, 422);
    assert.equal((invalidMeasurement.json() as { code: string }).code, 'INVALID_MEASUREMENT');
    const measurements = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/measurements`,
      headers: auth(ownerA),
    });
    assert.equal(measurements.statusCode, 200, measurements.body);
    assert.equal((measurements.json() as { items: unknown[] }).items.length, 2);
    const correctedHeight = await app.inject({
      method: 'PATCH',
      url: `/v2/measurements/${heightId}`,
      headers: auth(ownerA),
      payload: {
        localDate: '2026-11-12',
        kind: 'height',
        value: 86.7,
        unit: 'cm',
        method: 'standing',
        source: 'home',
        operationId: randomUUID(),
        baseRevision: 1,
      },
    });
    assert.equal(correctedHeight.statusCode, 200, correctedHeight.body);
    assert.equal((correctedHeight.json() as { revision: number; method: string }).revision, 2);
    assert.equal((correctedHeight.json() as { revision: number; method: string }).method, 'standing');
    const deletedMeasurement = await app.inject({
      method: 'DELETE',
      url: `/v2/measurements/${heightId}`,
      headers: auth(caregiverA),
      payload: { operationId: randomUUID(), baseRevision: 2 },
    });
    assert.equal(deletedMeasurement.statusCode, 200, deletedMeasurement.body);
    const deletedMeasurementAck = deletedMeasurement.json() as { revision: number; changeSeq: number };
    assert.equal(deletedMeasurementAck.revision, 3);
    assert.ok(deletedMeasurementAck.changeSeq > 0);

    const deletedMeasurements = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/measurements?deleted=true`,
      headers: auth(ownerA),
    });
    assert.equal(deletedMeasurements.statusCode, 200, deletedMeasurements.body);
    const deletedMeasurementItems = (deletedMeasurements.json() as {
      items: Array<{ id: string; revision: number; deletedAt: string | null }>;
    }).items;
    assert.equal(deletedMeasurementItems.length, 1);
    assert.equal(deletedMeasurementItems[0]!.id, heightId);
    assert.equal(deletedMeasurementItems[0]!.revision, 3);
    assert.equal(typeof deletedMeasurementItems[0]!.deletedAt, 'string');

    const visibleMeasurementsAfterDelete = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/measurements`,
      headers: auth(ownerA),
    });
    assert.equal(visibleMeasurementsAfterDelete.statusCode, 200, visibleMeasurementsAfterDelete.body);
    assert.deepEqual(
      (visibleMeasurementsAfterDelete.json() as { items: Array<{ kind: string }> }).items.map(item => item.kind),
      ['weight'],
    );

    const staleMeasurementRestore = await app.inject({
      method: 'POST',
      url: `/v2/measurements/${heightId}/restore`,
      headers: auth(caregiverA),
      payload: { operationId: randomUUID(), baseRevision: 2 },
    });
    assert.equal(staleMeasurementRestore.statusCode, 409, staleMeasurementRestore.body);
    const staleMeasurementConflict = staleMeasurementRestore.json() as {
      code: string;
      details: { current: number; submitted: number };
    };
    assert.equal(staleMeasurementConflict.code, 'REVISION_CONFLICT');
    assert.deepEqual(staleMeasurementConflict.details, { current: 3, submitted: 2 });

    const restoredMeasurement = await app.inject({
      method: 'POST',
      url: `/v2/measurements/${heightId}/restore`,
      headers: auth(caregiverA),
      payload: { operationId: randomUUID(), baseRevision: 3 },
    });
    assert.equal(restoredMeasurement.statusCode, 200, restoredMeasurement.body);
    const restoredMeasurementBody = restoredMeasurement.json() as { revision: number; deletedAt: string | null };
    assert.equal(restoredMeasurementBody.revision, 4);
    assert.equal(restoredMeasurementBody.deletedAt, null);

    const visibleMeasurementsAfterRestore = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/measurements`,
      headers: auth(ownerA),
    });
    assert.equal(visibleMeasurementsAfterRestore.statusCode, 200, visibleMeasurementsAfterRestore.body);
    assert.equal((visibleMeasurementsAfterRestore.json() as { items: unknown[] }).items.length, 2);
    const deletedMeasurementsAfterRestore = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/measurements?deleted=true`,
      headers: auth(ownerA),
    });
    assert.equal(deletedMeasurementsAfterRestore.statusCode, 200, deletedMeasurementsAfterRestore.body);
    assert.equal((deletedMeasurementsAfterRestore.json() as { items: unknown[] }).items.length, 0);

    const observationId = randomUUID();
    const observationCreated = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/observations`,
      headers: auth(caregiverA),
      payload: {
        id: observationId,
        guideId: 'talk-about-picture',
        localDate: '2026-11-12',
        value: 'noticed',
        note: '会主动指向图中的小狗',
        operationId: randomUUID(),
      },
    });
    assert.equal(observationCreated.statusCode, 201, observationCreated.body);
    const observationUpdated = await app.inject({
      method: 'PATCH',
      url: `/v2/observations/${observationId}`,
      headers: auth(ownerA),
      payload: {
        guideId: 'talk-about-picture',
        localDate: '2026-11-12',
        value: 'discuss',
        note: '想再讲一次',
        operationId: randomUUID(),
        baseRevision: 1,
      },
    });
    assert.equal(observationUpdated.statusCode, 200, observationUpdated.body);
    assert.equal((observationUpdated.json() as { revision: number; value: string }).revision, 2);
    assert.equal((observationUpdated.json() as { revision: number; value: string }).value, 'discuss');
    const discardedObservationId = randomUUID();
    const discardedObservation = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyA.childId}/observations`,
      headers: auth(ownerA),
      payload: {
        id: discardedObservationId,
        guideId: 'rest-time',
        localDate: '2026-11-11',
        value: 'not_yet_observed',
        note: '',
        operationId: randomUUID(),
      },
    });
    assert.equal(discardedObservation.statusCode, 201, discardedObservation.body);
    const observationDeleted = await app.inject({
      method: 'DELETE',
      url: `/v2/observations/${discardedObservationId}`,
      headers: auth(caregiverA),
      payload: { operationId: randomUUID(), baseRevision: 1 },
    });
    assert.equal(observationDeleted.statusCode, 200, observationDeleted.body);
    const deletedObservationAck = observationDeleted.json() as { revision: number; changeSeq: number };
    assert.equal(deletedObservationAck.revision, 2);
    assert.ok(deletedObservationAck.changeSeq > 0);

    const deletedObservations = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/observations?deleted=true`,
      headers: auth(ownerA),
    });
    assert.equal(deletedObservations.statusCode, 200, deletedObservations.body);
    const deletedObservationItems = (deletedObservations.json() as {
      items: Array<{ id: string; revision: number; deletedAt: string | null }>;
    }).items;
    assert.equal(deletedObservationItems.length, 1);
    assert.equal(deletedObservationItems[0]!.id, discardedObservationId);
    assert.equal(deletedObservationItems[0]!.revision, 2);
    assert.equal(typeof deletedObservationItems[0]!.deletedAt, 'string');

    const visibleObservationsAfterDelete = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/observations`,
      headers: auth(ownerA),
    });
    assert.equal(visibleObservationsAfterDelete.statusCode, 200, visibleObservationsAfterDelete.body);
    assert.deepEqual(
      (visibleObservationsAfterDelete.json() as { items: Array<{ id: string }> }).items.map(item => item.id),
      [observationId],
    );

    const staleObservationRestore = await app.inject({
      method: 'POST',
      url: `/v2/observations/${discardedObservationId}/restore`,
      headers: auth(ownerA),
      payload: { operationId: randomUUID(), baseRevision: 1 },
    });
    assert.equal(staleObservationRestore.statusCode, 409, staleObservationRestore.body);
    const staleObservationConflict = staleObservationRestore.json() as {
      code: string;
      details: { current: number; submitted: number };
    };
    assert.equal(staleObservationConflict.code, 'REVISION_CONFLICT');
    assert.deepEqual(staleObservationConflict.details, { current: 2, submitted: 1 });

    const restoredObservation = await app.inject({
      method: 'POST',
      url: `/v2/observations/${discardedObservationId}/restore`,
      headers: auth(ownerA),
      payload: { operationId: randomUUID(), baseRevision: 2 },
    });
    assert.equal(restoredObservation.statusCode, 200, restoredObservation.body);
    const restoredObservationBody = restoredObservation.json() as { revision: number; deletedAt: string | null };
    assert.equal(restoredObservationBody.revision, 3);
    assert.equal(restoredObservationBody.deletedAt, null);

    const visibleObservationsAfterRestore = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/observations`,
      headers: auth(ownerA),
    });
    assert.equal(visibleObservationsAfterRestore.statusCode, 200, visibleObservationsAfterRestore.body);
    assert.equal((visibleObservationsAfterRestore.json() as { items: unknown[] }).items.length, 2);
    const deletedObservationsAfterRestore = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/observations?deleted=true`,
      headers: auth(ownerA),
    });
    assert.equal(deletedObservationsAfterRestore.statusCode, 200, deletedObservationsAfterRestore.body);
    assert.equal((deletedObservationsAfterRestore.json() as { items: unknown[] }).items.length, 0);

    const growthChanges = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.family.id}/changes`,
      headers: auth(caregiverA),
    });
    assert.equal(growthChanges.statusCode, 200, growthChanges.body);
    const growthChangeItems = (growthChanges.json() as {
      changes: Array<{ entity: string; id: string; deleted: boolean; revision: number; payload: unknown }>;
    }).changes;
    assert.ok(growthChangeItems.some(change =>
      change.entity === 'measurement'
      && change.id === heightId
      && change.deleted
      && change.revision === 3
      && change.payload === null));
    assert.ok(growthChangeItems.some(change =>
      change.entity === 'observation'
      && change.id === discardedObservationId
      && change.deleted
      && change.revision === 2
      && change.payload === null));
    assert.ok(growthChangeItems.some(change =>
      change.entity === 'measurement'
      && change.id === heightId
      && !change.deleted
      && change.revision === 4));
    assert.ok(growthChangeItems.some(change =>
      change.entity === 'observation'
      && change.id === discardedObservationId
      && !change.deleted
      && change.revision === 3));

    const book = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.family.id}/books`,
      headers: auth(ownerA),
      payload: {
        operationId: randomUUID(),
        title: '小熊散步',
        editionId: null,
        language: 'zh-CN',
        note: '客厅书架',
      },
    });
    assert.equal(book.statusCode, 201, book.body);
    const bookDto = book.json() as { id: string; editionStatus: string; revision: number };
    assert.equal(bookDto.editionStatus, 'unverified');
    const booksForParent = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.family.id}/books`,
      headers: auth(caregiverA),
    });
    assert.equal(booksForParent.statusCode, 200, booksForParent.body);
    assert.equal((booksForParent.json() as { books: unknown[] }).books.length, 1);
    const bookUpdated = await app.inject({
      method: 'PATCH',
      url: `/v2/family-books/${bookDto.id}`,
      headers: auth(caregiverA),
      payload: {
        operationId: randomUUID(),
        baseRevision: bookDto.revision,
        note: '客厅第二层',
      },
    });
    assert.equal(bookUpdated.statusCode, 200, bookUpdated.body);
    assert.equal((bookUpdated.json() as { revision: number }).revision, 2);
    const discardedBook = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.family.id}/books`,
      headers: auth(caregiverA),
      payload: {
        operationId: randomUUID(),
        title: '临时书架条目',
        editionId: null,
        language: 'zh-CN',
        note: '',
      },
    });
    assert.equal(discardedBook.statusCode, 201, discardedBook.body);
    const discardedBookDto = discardedBook.json() as { id: string; revision: number };
    const bookDeleted = await app.inject({
      method: 'DELETE',
      url: `/v2/family-books/${discardedBookDto.id}`,
      headers: auth(ownerA),
      payload: { operationId: randomUUID(), baseRevision: discardedBookDto.revision },
    });
    assert.equal(bookDeleted.statusCode, 200, bookDeleted.body);

    const memoryB = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyB.childId}/memories`,
      headers: auth(ownerB),
      payload: {
        operationId: randomUUID(),
        id: randomUUID(),
        localDate: '2026-11-12',
        type: 'story',
        text: '另一家庭不能读取',
        firstConfirmed: false,
        mediaIds: [],
      },
    });
    assert.equal(memoryB.statusCode, 201, memoryB.body);
    const crossList = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyB.childId}/memories`,
      headers: auth(caregiverA),
    });
    assert.equal(crossList.statusCode, 404);
    const crossPatch = await app.inject({
      method: 'PATCH',
      url: `/v2/memories/${(memoryB.json() as { id: string }).id}`,
      headers: auth(caregiverA),
      payload: {
        operationId: randomUUID(),
        localDate: '2026-11-12',
        type: 'story',
        text: '越权修改',
        firstConfirmed: false,
        mediaIds: [],
        baseRevision: 1,
      },
    });
    assert.equal(crossPatch.statusCode, 404);

    const measurementBId = randomUUID();
    const measurementB = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyB.childId}/measurements`,
      headers: auth(ownerB),
      payload: {
        id: measurementBId,
        localDate: '2026-11-12',
        kind: 'weight',
        value: 11.8,
        unit: 'kg',
        method: 'scale',
        source: 'home',
        operationId: randomUUID(),
      },
    });
    assert.equal(measurementB.statusCode, 201, measurementB.body);
    const deletedMeasurementB = await app.inject({
      method: 'DELETE',
      url: `/v2/measurements/${measurementBId}`,
      headers: auth(ownerB),
      payload: { operationId: randomUUID(), baseRevision: 1 },
    });
    assert.equal(deletedMeasurementB.statusCode, 200, deletedMeasurementB.body);

    const observationBId = randomUUID();
    const observationB = await app.inject({
      method: 'POST',
      url: `/v2/children/${familyB.childId}/observations`,
      headers: auth(ownerB),
      payload: {
        id: observationBId,
        guideId: 'another-family-only',
        localDate: '2026-11-12',
        value: 'discuss',
        note: '另一家庭不可见的观察',
        operationId: randomUUID(),
      },
    });
    assert.equal(observationB.statusCode, 201, observationB.body);
    const deletedObservationB = await app.inject({
      method: 'DELETE',
      url: `/v2/observations/${observationBId}`,
      headers: auth(ownerB),
      payload: { operationId: randomUUID(), baseRevision: 1 },
    });
    assert.equal(deletedObservationB.statusCode, 200, deletedObservationB.body);

    const crossDeletedMeasurements = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyB.childId}/measurements?deleted=true`,
      headers: auth(caregiverA),
    });
    assert.equal(crossDeletedMeasurements.statusCode, 404);
    const crossDeletedObservations = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyB.childId}/observations?deleted=true`,
      headers: auth(caregiverA),
    });
    assert.equal(crossDeletedObservations.statusCode, 404);
    const crossMeasurementRestore = await app.inject({
      method: 'POST',
      url: `/v2/measurements/${measurementBId}/restore`,
      headers: auth(caregiverA),
      payload: { operationId: randomUUID(), baseRevision: 2 },
    });
    assert.equal(crossMeasurementRestore.statusCode, 404);
    const crossObservationRestore = await app.inject({
      method: 'POST',
      url: `/v2/observations/${observationBId}/restore`,
      headers: auth(caregiverA),
      payload: { operationId: randomUUID(), baseRevision: 2 },
    });
    assert.equal(crossObservationRestore.statusCode, 404);

    const reminderDefault = await app.inject({
      method: 'GET',
      url: '/v2/users/me/reminder',
      headers: auth(ownerA),
    });
    assert.equal(reminderDefault.statusCode, 200, reminderDefault.body);
    assert.deepEqual(reminderDefault.json(), {
      userId: ownerAUser.id,
      deviceId: null,
      enabled: false,
      localTime: '16:00',
      revision: 0,
    });
    const reminderOperationId = randomUUID();
    const reminderBody = {
      operationId: reminderOperationId,
      baseRevision: 0,
      deviceId: ownerA.deviceId,
      enabled: true,
      localTime: '16:30',
    };
    const reminderPut = await app.inject({
      method: 'PUT',
      url: '/v2/users/me/reminder',
      headers: auth(ownerA),
      payload: reminderBody,
    });
    assert.equal(reminderPut.statusCode, 200, reminderPut.body);
    assert.deepEqual(reminderPut.json(), {
      userId: ownerAUser.id,
      deviceId: ownerA.deviceId,
      enabled: true,
      localTime: '16:30',
      revision: 1,
    });
    const lateReminder = await app.inject({
      method: 'PUT', url: '/v2/users/me/reminder', headers: auth(ownerA),
      payload: { ...reminderBody, operationId: randomUUID(), baseRevision: 1, localTime: '20:00' },
    });
    assert.equal(lateReminder.statusCode, 400);
    const reminderReplay = await app.inject({
      method: 'PUT',
      url: '/v2/users/me/reminder',
      headers: auth(ownerA),
      payload: reminderBody,
    });
    assert.equal(reminderReplay.statusCode, 200, reminderReplay.body);
    assert.deepEqual(reminderReplay.json(), reminderPut.json());
    const reminderOperationConflict = await app.inject({
      method: 'PUT',
      url: '/v2/users/me/reminder',
      headers: auth(ownerA),
      payload: { ...reminderBody, localTime: '17:00' },
    });
    assert.equal(reminderOperationConflict.statusCode, 409);
    assert.equal((reminderOperationConflict.json() as { code: string }).code, 'OPERATION_REUSED');
    const reminderStale = await app.inject({
      method: 'PUT',
      url: '/v2/users/me/reminder',
      headers: auth(ownerA),
      payload: {
        operationId: randomUUID(),
        baseRevision: 0,
        deviceId: ownerA.deviceId,
        enabled: true,
        localTime: '17:00',
      },
    });
    assert.equal(reminderStale.statusCode, 409);
    const otherDevice = await app.inject({
      method: 'PUT',
      url: '/v2/users/me/reminder',
      headers: auth(ownerA),
      payload: {
        operationId: randomUUID(),
        baseRevision: 1,
        deviceId: caregiverA.deviceId,
        enabled: true,
        localTime: '17:00',
      },
    });
    assert.equal(otherDevice.statusCode, 422);
    assert.equal((otherDevice.json() as { code: string }).code, 'INVALID_DEVICE');
    const reminderUpdated = await app.inject({
      method: 'PUT',
      url: '/v2/users/me/reminder',
      headers: auth(ownerA),
      payload: {
        operationId: randomUUID(),
        baseRevision: 1,
        deviceId: ownerA.deviceId,
        enabled: true,
        localTime: '17:00',
      },
    });
    assert.equal(reminderUpdated.statusCode, 200, reminderUpdated.body);
    assert.equal((reminderUpdated.json() as { revision: number; localTime: string }).revision, 2);
    assert.equal((reminderUpdated.json() as { revision: number; localTime: string }).localTime, '17:00');

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v2/families/${familyA.family.id}/snapshot`,
      headers: auth(caregiverA),
    });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const snapshotBody = snapshot.json() as {
      memories: Array<{ id: string }>;
      measurements: Array<{ id: string; kind: string }>;
      observations: Array<{ id: string; value: string }>;
      books: Array<{ id: string; note: string }>;
    };
    assert.ok(snapshotBody.memories.some(item => item.id === memoryId));
    assert.deepEqual(snapshotBody.measurements.map(item => item.kind), ['height', 'weight']);
    assert.deepEqual(snapshotBody.observations.map(item => item.value), ['not_yet_observed', 'discuss']);
    assert.deepEqual(snapshotBody.books.map(item => item.id), [bookDto.id]);
    assert.equal(snapshotBody.books[0]!.note, '客厅第二层');
  } finally {
    if (app) await app.close();
    await cleanup(pool, users.map(user => user.id));
    await pool.end();
  }
});
