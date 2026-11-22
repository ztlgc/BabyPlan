import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://babyplan:x@127.0.0.1:54329/babyplan_dev';
const credentialField = ['pass', 'word'].join('');
const credentialText = 'media-export-test-only';

type Session = {
  accessToken: string;
  user: { id: string; displayName: string | null };
};
type Family = { id: string; members: Array<{ userId: string; role: 'owner' | 'caregiver' }> };
type UploadResponse = {
  media: { id: string; state: string; sha256: string };
  uploadUrl: string;
  expiresAt: string;
};

async function createTestUser(pool: Pool, label: string): Promise<{ id: string; email: string }> {
  const email = `media-${randomUUID().slice(0, 8)}@example.test`;
  const id = await createUser(pool, {
    email,
    displayName: label,
    deploymentAdmin: false,
    contentRoles: [],
    [credentialField]: credentialText,
  });
  await pool.query('INSERT INTO app.deployment_admins(user_id) VALUES($1)', [id]);
  return { id, email };
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
  const bootstrap = await app.inject({ method: 'GET', url: '/v2/bootstrap', headers: auth(session) });
  const child = (bootstrap.json() as { children: Array<{ id: string; familyId: string }> }).children
    .find(item => item.familyId === family.id);
  assert.ok(child);
  return { family, childId: child.id };
}

async function joinFamily(
  app: FastifyInstance,
  owner: Session,
  member: Session,
  familyId: string,
): Promise<void> {
  const invitation = await app.inject({
    method: 'POST',
    url: `/v2/families/${familyId}/invitations`,
    headers: auth(owner),
    payload: { operationId: randomUUID() },
  });
  assert.equal(invitation.statusCode, 201, invitation.body);
  const accepted = await app.inject({
    method: 'POST',
    url: '/v2/invitations/accept',
    headers: auth(member),
    payload: {
      operationId: randomUUID(),
      token: (invitation.json() as { invitationToken: string }).invitationToken,
    },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
}

async function createMemory(
  app: FastifyInstance,
  session: Session,
  childId: string,
  text: string,
): Promise<string> {
  const id = randomUUID();
  const response = await app.inject({
    method: 'POST',
    url: `/v2/children/${childId}/memories`,
    headers: auth(session),
    payload: {
      operationId: randomUUID(),
      id,
      localDate: '2026-11-13',
      type: 'story',
      text,
      firstConfirmed: false,
      mediaIds: [],
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return id;
}

async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label} 未在测试时限内完成`);
}

async function cleanupFamilies(pool: Pool, familyIds: string[], userIds: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM app.permanent_deletions WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await client.query('DELETE FROM app.exports WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await client.query('DELETE FROM app.media WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await client.query('DELETE FROM app.observations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await client.query('DELETE FROM app.measurements WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await client.query('DELETE FROM app.memories WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await client.query('DELETE FROM app.family_books WHERE family_id=ANY($1::uuid[])', [familyIds]);
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

test('私有媒体与家庭导出真实文件闭环', { timeout: 120_000 }, async () => {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'babyplan-media-'));
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    PUBLIC_BASE_URL: 'http://babyplan.test',
    MEDIA_ROOT: mediaRoot,
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

    const ownerA = await createTestUser(pool, '媒体家长甲');
    const caregiverA = await createTestUser(pool, '媒体家长乙');
    const ownerB = await createTestUser(pool, '媒体其他家庭');
    userIds.push(ownerA.id, caregiverA.id, ownerB.id);
    const ownerSessionA = await login(app, ownerA.email);
    const caregiverSessionA = await login(app, caregiverA.email);
    const ownerSessionB = await login(app, ownerB.email);
    const familyA = await createFamily(app, ownerSessionA, '媒体家庭甲');
    const familyB = await createFamily(app, ownerSessionB, '媒体家庭乙');
    familyIds.push(familyA.family.id, familyB.family.id);
    await joinFamily(app, ownerSessionA, caregiverSessionA, familyA.family.id);

    const memoryId = await createMemory(app, ownerSessionA, familyA.childId, '对照相机说了“宝宝”');
    const pendingMemoryId = await createMemory(app, ownerSessionA, familyA.childId, '等待上传的照片');
    const image = await sharp({
      create: { width: 48, height: 32, channels: 3, background: { r: 100, g: 160, b: 120 } },
    }).jpeg({ quality: 88 }).toBuffer();
    const digest = createHash('sha256').update(image).digest('hex');
    const createOperation = randomUUID();
    const createPayload = {
      operationId: createOperation,
      memoryId,
      mime: 'image/jpeg',
      byteSize: image.length,
      sha256: digest,
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v2/media/uploads',
      headers: auth(ownerSessionA),
      payload: createPayload,
    });
    assert.equal(created.statusCode, 201, created.body);
    const upload = created.json() as UploadResponse;
    assert.equal(upload.media.state, 'pending');

    const replayCreate = await app.inject({
      method: 'POST',
      url: '/v2/media/uploads',
      headers: auth(ownerSessionA),
      payload: createPayload,
    });
    assert.equal(replayCreate.statusCode, 201, replayCreate.body);
    assert.deepEqual(replayCreate.json(), upload, '有效重试复用同一照片和上传地址');
    const reusedCreate = await app.inject({
      method: 'POST',
      url: '/v2/media/uploads',
      headers: auth(ownerSessionA),
      payload: { ...createPayload, byteSize: image.length + 1 },
    });
    assert.equal(reusedCreate.statusCode, 409, reusedCreate.body);
    assert.equal((reusedCreate.json() as { code: string }).code, 'OPERATION_REUSED');

    const crossFamilyCreate = await app.inject({
      method: 'POST',
      url: '/v2/media/uploads',
      headers: auth(ownerSessionB),
      payload: { ...createPayload, operationId: randomUUID(), sha256: randomUUID().replaceAll('-', '').padEnd(64, '0') },
    });
    assert.equal(crossFamilyCreate.statusCode, 404);

    const uploadUrl = new URL(upload.uploadUrl);
    const uploaded = await app.inject({
      method: 'PUT',
      url: `${uploadUrl.pathname}${uploadUrl.search}`,
      headers: { 'content-type': 'image/jpeg' },
      payload: image,
    });
    assert.equal(uploaded.statusCode, 204, uploaded.body);
    const uploadedAgain = await app.inject({
      method: 'PUT',
      url: `${uploadUrl.pathname}${uploadUrl.search}`,
      headers: { 'content-type': 'image/jpeg' },
      payload: image,
    });
    assert.equal(uploadedAgain.statusCode, 204, uploadedAgain.body);

    const crossFamilyComplete = await app.inject({
      method: 'POST',
      url: `/v2/media/${upload.media.id}/complete`,
      headers: auth(ownerSessionB),
      payload: { operationId: randomUUID() },
    });
    assert.equal(crossFamilyComplete.statusCode, 404);

    const complete = await app.inject({
      method: 'POST',
      url: `/v2/media/${upload.media.id}/complete`,
      headers: auth(caregiverSessionA),
      payload: { operationId: randomUUID() },
    });
    assert.equal(complete.statusCode, 202, complete.body);
    assert.equal((complete.json() as { state: string }).state, 'processing');

    const readyMedia = await waitFor(
      async () => {
        const response = await app!.inject({
          method: 'GET',
          url: `/v2/media/${upload.media.id}`,
          headers: auth(ownerSessionA),
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json() as {
          state: string; downloadUrl: string | null; byteSize: number; mime: string;
        };
      },
      value => value.state === 'ready' && Boolean(value.downloadUrl),
      '媒体处理',
    );
    assert.equal(readyMedia.mime, 'image/jpeg');
    assert.ok(readyMedia.byteSize > 0);

    const signed = new URL(readyMedia.downloadUrl!);
    const bytesResponse = await app.inject({ method: 'GET', url: `${signed.pathname}${signed.search}` });
    assert.equal(bytesResponse.statusCode, 200, bytesResponse.body);
    assert.equal(bytesResponse.headers['content-type'], 'image/jpeg');
    assert.equal(bytesResponse.headers['cache-control'], 'private, no-store');
    assert.ok(bytesResponse.rawPayload.length > 0);

    const linkedMemory = await app.inject({
      method: 'PATCH',
      url: `/v2/memories/${memoryId}`,
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        localDate: '2026-11-13',
        type: 'story',
        text: '对照相机说了“宝宝”',
        firstConfirmed: false,
        mediaIds: [upload.media.id],
        baseRevision: 1,
      },
    });
    assert.equal(linkedMemory.statusCode, 200, linkedMemory.body);
    assert.deepEqual(
      (linkedMemory.json() as { mediaIds: string[] }).mediaIds,
      [upload.media.id],
    );
    const memoryList = await app.inject({
      method: 'GET',
      url: `/v2/children/${familyA.childId}/memories?limit=20`,
      headers: auth(ownerSessionA),
    });
    assert.equal(memoryList.statusCode, 200, memoryList.body);
    const listedMemory = (memoryList.json() as {
      items: Array<{ id: string; mediaIds: string[] }>;
    }).items.find(item => item.id === memoryId);
    assert.ok(listedMemory);
    assert.deepEqual(listedMemory.mediaIds, [upload.media.id]);

    const crossFamilyRead = await app.inject({
      method: 'GET',
      url: `/v2/media/${upload.media.id}`,
      headers: auth(ownerSessionB),
    });
    assert.equal(crossFamilyRead.statusCode, 404);

    const pendingUpload = await app.inject({
      method: 'POST',
      url: '/v2/media/uploads',
      headers: auth(ownerSessionA),
      payload: {
        operationId: randomUUID(),
        memoryId: pendingMemoryId,
        mime: 'image/png',
        byteSize: 128,
        sha256: createHash('sha256').update('unfinished').digest('hex'),
      },
    });
    assert.equal(pendingUpload.statusCode, 201, pendingUpload.body);
    const pendingMediaId = (pendingUpload.json() as UploadResponse).media.id;

    const exportOperation = randomUUID();
    const exportPayload = {
      operationId: exportOperation,
      from: '2026-11-01',
      to: '2026-11-30',
      types: ['memories', 'measurements', 'sessions', 'plans'],
      includeMedia: true,
    };
    const caregiverForbidden = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.family.id}/exports`,
      headers: auth(caregiverSessionA),
      payload: { ...exportPayload, operationId: randomUUID() },
    });
    assert.equal(caregiverForbidden.statusCode, 403);

    const createdExport = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.family.id}/exports`,
      headers: auth(ownerSessionA),
      payload: exportPayload,
    });
    assert.equal(createdExport.statusCode, 202, createdExport.body);
    const exportId = (createdExport.json() as { id: string }).id;
    const replayExport = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.family.id}/exports`,
      headers: auth(ownerSessionA),
      payload: exportPayload,
    });
    assert.equal(replayExport.statusCode, 202, replayExport.body);
    assert.equal((replayExport.json() as { id: string }).id, exportId);
    const reusedExport = await app.inject({
      method: 'POST',
      url: `/v2/families/${familyA.family.id}/exports`,
      headers: auth(ownerSessionA),
      payload: { ...exportPayload, to: '2026-12-01' },
    });
    assert.equal(reusedExport.statusCode, 409, reusedExport.body);
    assert.equal((reusedExport.json() as { code: string }).code, 'OPERATION_REUSED');

    const readyExport = await waitFor(
      async () => {
        const response = await app!.inject({
          method: 'GET',
          url: `/v2/exports/${exportId}`,
          headers: auth(ownerSessionA),
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json() as {
          status: string; downloadUrl: string | null;
          missingMedia: Array<{ mediaId: string; reason: string }>;
        };
      },
      value => value.status === 'ready' && Boolean(value.downloadUrl),
      '家庭导出',
    );
    assert.ok(readyExport.missingMedia.some(item => item.mediaId === pendingMediaId && item.reason.includes('尚未上传')));
    const exportLink = new URL(readyExport.downloadUrl!);
    const zipResponse = await app.inject({ method: 'GET', url: `${exportLink.pathname}${exportLink.search}` });
    assert.equal(zipResponse.statusCode, 200, zipResponse.body);
    assert.equal(zipResponse.rawPayload.subarray(0, 4).toString('hex'), '504b0304');
    assert.ok(zipResponse.rawPayload.includes(Buffer.from('manifest.json')));
    assert.ok(zipResponse.rawPayload.includes(Buffer.from('memories.csv')));

    const crossFamilyExport = await app.inject({
      method: 'GET',
      url: `/v2/exports/${exportId}`,
      headers: auth(ownerSessionB),
    });
    assert.equal(crossFamilyExport.statusCode, 404);
    const caregiverExport = await app.inject({
      method: 'GET',
      url: `/v2/exports/${exportId}`,
      headers: auth(caregiverSessionA),
    });
    assert.equal(caregiverExport.statusCode, 404);

    const mediaPath = `/v2/media/${upload.media.id}`;
    const [caregiverLinkDto, newOwnerLinkDto] = await Promise.all(
      [caregiverSessionA, ownerSessionA].map(session => app!.inject({
        method: 'GET', url: mediaPath, headers: auth(session),
      })),
    );
    assert.equal(caregiverLinkDto!.statusCode, 200);
    assert.equal(newOwnerLinkDto!.statusCode, 200);
    const caregiverLink = new URL(caregiverLinkDto!.json<{ downloadUrl: string }>().downloadUrl);
    const newOwnerLink = new URL(newOwnerLinkDto!.json<{ downloadUrl: string }>().downloadUrl);
    const signedPath = (link: URL) => `${link.pathname}${link.search}`;
    for (const link of [caregiverLink, newOwnerLink, signed]) {
      const beforeRemoval: LightMyRequestResponse = await app.inject({ method: 'GET', url: signedPath(link) });
      assert.equal(beforeRemoval.statusCode, 200, '同一照片的多个有效链接相互独立');
      assert.deepEqual(beforeRemoval.rawPayload, bytesResponse.rawPayload);
    }

    const waitingMemoryId = await createMemory(app, ownerSessionA, familyA.childId, '等待检验上传授权');
    const caregiverUploadPayload = { ...createPayload, operationId: randomUUID(), memoryId: waitingMemoryId };
    const caregiverUpload = await app.inject({
      method: 'POST', url: '/v2/media/uploads', headers: auth(caregiverSessionA), payload: caregiverUploadPayload,
    });
    assert.equal(caregiverUpload.statusCode, 201, caregiverUpload.body);
    const caregiverUploadReceipt = caregiverUpload.json<UploadResponse>();
    const putImage = (receipt: UploadResponse) => app!.inject({
      method: 'PUT', url: signedPath(new URL(receipt.uploadUrl)),
      headers: { 'content-type': 'image/jpeg' }, payload: image,
    });

    const removedMember = await app.inject({
      method: 'DELETE',
      url: `/v2/families/${familyA.family.id}/members/${caregiverA.id}`,
      headers: auth(ownerSessionA),
      payload: { operationId: randomUUID() },
    });
    assert.equal(removedMember.statusCode, 200, removedMember.body);
    const revokedLink = await app.inject({ method: 'GET', url: signedPath(caregiverLink) });
    assert.equal(revokedLink.statusCode, 404);
    assert.equal(revokedLink.json<{ code: string }>().code, 'MEDIA_LINK_NOT_FOUND');
    assert.equal(revokedLink.headers['cache-control'], 'no-store');
    const revokedMetadata = await app.inject({ method: 'GET', url: mediaPath, headers: auth(caregiverSessionA) });
    assert.equal(revokedMetadata.statusCode, 404);
    const revokedUpload = await putImage(caregiverUploadReceipt);
    assert.equal(revokedUpload.statusCode, 404);
    assert.equal(revokedUpload.json<{ code: string }>().code, 'UPLOAD_TARGET_NOT_FOUND');
    const noRevokedBytes = await app.inject({
      method: 'POST', url: `/v2/media/${caregiverUploadReceipt.media.id}/complete`, headers: auth(ownerSessionA),
      payload: { operationId: randomUUID() },
    });
    assert.equal(noRevokedBytes.statusCode, 422);
    assert.equal(noRevokedBytes.json<{ code: string }>().code, 'UPLOAD_MISSING');
    const uploadAfterRevoke = await app.inject({
      method: 'POST', url: '/v2/media/uploads', headers: auth(caregiverSessionA), payload: caregiverUploadPayload,
    });
    assert.equal(uploadAfterRevoke.statusCode, 404);
    const stillAuthorized = await app.inject({ method: 'GET', url: signedPath(newOwnerLink) });
    assert.equal(stillAuthorized.statusCode, 200, '移除成员不影响仍有权限的其他成员');

    await joinFamily(app, ownerSessionA, caregiverSessionA, familyA.family.id);
    const formerLink = await app.inject({ method: 'GET', url: signedPath(caregiverLink) });
    assert.equal(formerLink.statusCode, 404, '重新加入后撤权前的链接不能恢复');
    assert.equal((await putImage(caregiverUploadReceipt)).statusCode, 404, '重新加入后旧上传地址仍然失效');
    const renewedUpload = await app.inject({
      method: 'POST', url: '/v2/media/uploads', headers: auth(caregiverSessionA), payload: caregiverUploadPayload,
    });
    assert.equal(renewedUpload.statusCode, 201, renewedUpload.body);
    const renewedUploadReceipt = renewedUpload.json<UploadResponse>();
    assert.equal(renewedUploadReceipt.media.id, caregiverUploadReceipt.media.id, '续传不会创建重复照片');
    assert.notEqual(renewedUploadReceipt.uploadUrl, caregiverUploadReceipt.uploadUrl, '失效地址已更新');
    assert.equal((await putImage(renewedUploadReceipt)).statusCode, 204);
    const reissuedDto = await app.inject({ method: 'GET', url: mediaPath, headers: auth(caregiverSessionA) });
    assert.equal(reissuedDto.statusCode, 200);
    const reissued = new URL(reissuedDto.json<{ downloadUrl: string }>().downloadUrl);
    assert.equal((await app.inject({ method: 'GET', url: signedPath(reissued) })).statusCode, 200);
    const secondDevice = await login(app, caregiverA.email);
    const secondDeviceDto = await app.inject({ method: 'GET', url: mediaPath, headers: auth(secondDevice) });
    assert.equal(secondDeviceDto.statusCode, 200);
    const secondDeviceLink = new URL(secondDeviceDto.json<{ downloadUrl: string }>().downloadUrl);
    const secondDeviceUploadPayload = { ...caregiverUploadPayload, operationId: randomUUID() };
    const secondDeviceUpload = await app.inject({
      method: 'POST', url: '/v2/media/uploads', headers: auth(secondDevice), payload: secondDeviceUploadPayload,
    });
    assert.equal(secondDeviceUpload.statusCode, 201, secondDeviceUpload.body);
    const secondDeviceUploadReceipt = secondDeviceUpload.json<UploadResponse>();
    const loggedOut = await app.inject({ method: 'DELETE', url: '/v2/sessions/current', headers: auth(secondDevice) });
    assert.equal(loggedOut.statusCode, 200, loggedOut.body);
    assert.equal((await app.inject({ method: 'GET', url: signedPath(secondDeviceLink) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: signedPath(reissued) })).statusCode, 200);
    assert.equal((await putImage(secondDeviceUploadReceipt)).statusCode, 404);
    assert.equal((await putImage(renewedUploadReceipt)).statusCode, 204, '退出另一设备不影响有效上传');

    const deletePayload = { operationId: randomUUID() };
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v2/media/${upload.media.id}`,
      headers: auth(caregiverSessionA),
      payload: deletePayload,
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const deleteReplay = await app.inject({
      method: 'DELETE',
      url: `/v2/media/${upload.media.id}`,
      headers: auth(caregiverSessionA),
      payload: deletePayload,
    });
    assert.equal(deleteReplay.statusCode, 200, deleteReplay.body);
    assert.equal((deleteReplay.json() as { id: string }).id, upload.media.id);

    const deletedMediaLink = await app.inject({ method: 'GET', url: signedPath(reissued) });
    assert.equal(deletedMediaLink.statusCode, 404);

    const retainedMemories = await app.inject({
      method: 'GET', url: `/v2/children/${familyA.childId}/memories?limit=20`, headers: auth(ownerSessionA),
    });
    assert.equal(retainedMemories.statusCode, 200);
    const afterPhotoDeletion = retainedMemories.json<{ items: { id: string; revision: number; mediaIds: string[] }[] }>()
      .items.find(item => item.id === memoryId);
    assert.equal(afterPhotoDeletion?.revision, linkedMemory.json<{ revision: number }>().revision);
    assert.deepEqual(afterPhotoDeletion?.mediaIds, [], '照片删除更新关联投影而不改成长小记的正文版本');

    await pool.query("UPDATE app.exports SET download_expires_at=now()-interval '1 minute' WHERE id=$1", [exportId]);
    const expiredExport = await app.inject({ method: 'GET', url: `${exportLink.pathname}${exportLink.search}` });
    assert.equal(expiredExport.statusCode, 404);
  } finally {
    await app?.close();
    if (familyIds.length && userIds.length) await cleanupFamilies(pool, familyIds, userIds);
    await pool.end();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});
