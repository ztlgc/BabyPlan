import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

const execute = promisify(execFile);
const adminUrl = process.env.BABYPLAN_DELETION_DRILL_ADMIN_URL;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const credential = ['pass', 'word'].join('');
const phrase = 'test-deletion-only-' + randomUUID();
const appDatabaseName = 'bp_deletion_drill_' + randomUUID().replaceAll('-', '').slice(0, 12);
const targetDatabaseName = appDatabaseName + '_restored';
const sqlRole = appDatabaseName + '_role';

async function waitFor<T>(poll: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 80; index++) {
    const value = await poll();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('未在时限内取得清理或处理结果');
}

function urlFor(base: string, database: string, role?: string): URL {
  const url = new URL(base);
  url.pathname = '/' + database;
  if (role) {
    url.username = role;
    url.password = randomUUID() + randomUUID();
  }
  return url;
}

function relativeUrl(value: string): string {
  const url = new URL(value);
  return url.pathname + url.search;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  payload?: object | Buffer;
  token?: string;
  mime?: string;
};

async function request(app: FastifyInstance, status: number, url: string, opts: RequestOptions = {}) {
  const response = await app.inject({
    method: opts.method ?? 'GET',
    url,
    headers: {
      ...(opts.token ? { authorization: 'Bearer ' + opts.token } : {}),
      ...(opts.mime ? { 'content-type': opts.mime } : {}),
    },
    ...(opts.payload ? { payload: opts.payload } : {}),
  });
  assert.equal(response.statusCode, status, `${opts.method ?? 'GET'} ${url.split('?')[0]}: ${response.statusCode}`);
  return response;
}

async function login(app: FastifyInstance, email: string): Promise<string> {
  return (await request(app, 200, '/v2/sessions', {
    method: 'POST',
    payload: { email, [credential]: phrase, clientType: 'mobile', deviceId: randomUUID() },
  })).json<{ accessToken: string }>().accessToken;
}

test('旧备份重放家庭、小记和照片删除，保留资料可用并撤销旧授权', {
  skip: !adminUrl && '需要专用的本机隔离 PostgreSQL 管理员连接及已构建的服务端',
  timeout: 150_000,
}, async () => {
  const admin = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost'].includes(admin.hostname) && admin.port === '54329',
    '只允许 BabyPlan 的隔离 PostgreSQL 端口');
  const sourceUrl = urlFor(adminUrl!, appDatabaseName, sqlRole);
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = '/' + targetDatabaseName;
  const artifactRoot = join(root, '.work', appDatabaseName);
  const slash = (path: string) => path.replaceAll('\\', '/');
  const sourceEnv = join(artifactRoot, 'drill.env');
  const settings = {
    NODE_ENV: 'test',
    DATABASE_URL: sourceUrl.toString(),
    API_HOST: '127.0.0.1',
    API_PORT: '43984',
    PUBLIC_BASE_URL: 'http://babyplan.test',
    MEDIA_ROOT: slash(join(artifactRoot, 'media')),
    BACKUP_ROOT: slash(join(artifactRoot, 'backups')),
    RESTORE_ROOT: slash(join(artifactRoot, 'restores')),
    RECOVERY_OUTBOX_ROOT: slash(join(artifactRoot, 'outbox')),
    DELETION_JOURNAL_ROOT: slash(join(artifactRoot, 'deletion-journal')),
    LOG_LEVEL: 'silent',
  };
  // 建库与删库要复制/清理 PostgreSQL 模板文件，不使用业务查询的 10 秒上限。
  const adminPool = new pg.Pool({ connectionString: adminUrl!, max: 1, statement_timeout: 60_000, connectionTimeoutMillis: 3_000 });
  const config = loadConfig(settings);
  const sourcePool = createPool(config);
  const targetPool = createPool(loadConfig({ ...settings, DATABASE_URL: targetUrl.toString() }));
  let source: FastifyInstance | undefined;
  let target: FastifyInstance | undefined;
  let roleCreated = false;
  let sourceCreated = false;
  let restored = false;
  try {
    const connection = await adminPool.query<{ capable: boolean }>(
      'SELECT rolsuper AND rolcreatedb AS capable FROM pg_roles WHERE rolname=current_user',
    );
    assert.equal(connection.rows[0]?.capable, true);
    // 角色、数据库和临时口令都由本用例随机生成，SQL 标识符不是外部输入。
    await adminPool.query(`CREATE ROLE "${sqlRole}" LOGIN NOSUPERUSER NOCREATEDB PASSWORD '${sourceUrl.password}'`);
    roleCreated = true;
    await adminPool.query(`CREATE DATABASE "${appDatabaseName}" OWNER "${sqlRole}" TEMPLATE template0`);
    sourceCreated = true;
    await mkdir(artifactRoot);
    for (const path of [settings.MEDIA_ROOT, settings.RECOVERY_OUTBOX_ROOT]) await mkdir(path);
    await writeFile(sourceEnv, Object.entries(settings).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    const migrationNames = await migrate(sourcePool);
    assert.ok(migrationNames.includes('0008_deletion_replay.sql'));
    source = buildApp(config, sourcePool);
    await source.ready();
    const email = 'deletion-owner@example.test';
    const helperEmail = 'deletion-helper@example.test';
    for (const userEmail of [email, helperEmail]) {
      await createUser(sourcePool, { email: userEmail, [credential]: phrase, displayName: null, deploymentAdmin: userEmail === email, contentRoles: [] });
    }
    const token = await login(source, email);
    const helperToken = await login(source, helperEmail);
    const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    async function addFamily(name: string) {
      const family = (await request(source!, 201, '/v2/families', {
        method: 'POST', token,
        payload: { operationId: randomUUID(), name, timezone: 'Asia/Shanghai', child: {
          displayName: '虚构宝宝', ageMode: 'months', ageMonths: 18, ageAsOf: localDate, birthDate: null,
        } },
      })).json<{ id: string }>();
      const bootstrap = (await request(source!, 200, '/v2/bootstrap', { token }))
        .json<{ children: { id: string; familyId: string }[] }>();
      return { id: family.id, childId: bootstrap.children.find(child => child.familyId === family.id)!.id, name };
    }
    const removed = await addFamily('待删除的虚构家庭');
    const kept = await addFamily('保留的虚构家庭');
    const invite = (await request(source, 201, `/v2/families/${kept.id}/invitations`, {
      method: 'POST', token, payload: { operationId: randomUUID() },
    })).json<{ invitationToken: string }>().invitationToken;
    await request(source, 200, '/v2/invitations/accept', {
      method: 'POST', token: helperToken, payload: { operationId: randomUUID(), token: invite },
    });
    const unusedInvite = (await request(source, 201, `/v2/families/${kept.id}/invitations`, {
      method: 'POST', token, payload: { operationId: randomUUID() },
    })).json<{ invitationToken: string }>().invitationToken;
    const png = await sharp({ create: { width: 6, height: 5, channels: 3, background: '#A3C188' } }).png().toBuffer();
    async function addMemory(family: typeof kept, text: string) {
      const id = randomUUID();
      const payload = { operationId: randomUUID(), id, localDate, type: 'story', text, firstConfirmed: false, mediaIds: [] };
      const path = `/v2/children/${family.childId}/memories`;
      await request(source!, 201, path, { method: 'POST', token, payload });
      const sha256 = createHash('sha256').update(png).digest('hex');
      const upload = (await request(source!, 201, '/v2/media/uploads', {
        method: 'POST', token,
        payload: { operationId: randomUUID(), memoryId: id, mime: 'image/png', byteSize: png.length, sha256 },
      })).json<{ media: { id: string }; uploadUrl: string }>();
      await request(source!, 204, relativeUrl(upload.uploadUrl), { method: 'PUT', mime: 'image/png', payload: png });
      await request(source!, 202, `/v2/media/${upload.media.id}/complete`, { method: 'POST', token, payload: { operationId: randomUUID() } });
      const mediaPath = `/v2/media/${upload.media.id}`;
      const media = await waitFor(async () => (await request(source!, 200, mediaPath, { token }))
        .json<{ downloadUrl: string | null }>(), data => data.downloadUrl !== null);
      const objectKey = `families/${family.id}/memories/${id}/${upload.media.id}.png`;
      return { id, payload, path, text, mediaId: upload.media.id, mediaPath, signed: relativeUrl(media.downloadUrl!), objectKey };
    }
    const inRemovedFamily = await addMemory(removed, '家庭删除后必须消失');
    const removedMemory = await addMemory(kept, '小记删除后必须消失');
    const removedPhoto = await addMemory(kept, '照片删除后正文保留');
    const retained = await addMemory(kept, '不受删除影响的小记');
    const retainedBytes = (await request(source, 200, retained.signed)).rawPayload;
    const exportJob = (await request(source, 202, `/v2/families/${kept.id}/exports`, {
      method: 'POST', token,
      payload: { operationId: randomUUID(), from: localDate, to: localDate, types: ['memories'], includeMedia: true },
    })).json<{ id: string }>();
    const exportPath = `/v2/exports/${exportJob.id}`;
    const exported = await waitFor(async () => (await request(source!, 200, exportPath, { token }))
      .json<{ downloadUrl: string | null }>(), data => data.downloadUrl !== null);
    const oldExport = relativeUrl(exported.downloadUrl!);
    await request(source, 200, oldExport);
    const snapshotPath = `/v2/families/${kept.id}/snapshot`;
    const cursor = (await request(source, 200, snapshotPath, { token })).json<{ cursor: string }>().cursor;
    await source.close();
    source = undefined;

    const ps = (script: string, ...args: string[]) => execute('pwsh.exe', [
      '-NoProfile', '-File', join(root, 'scripts', 'ops', script), ...args,
    ], {
      cwd: root,
      env: { ...process.env, BABYPLAN_RESTORE_ADMIN_DATABASE_URL: adminUrl! },
      windowsHide: true,
    });
    await ps('Backup-BabyPlan.ps1', '-EnvironmentFile', sourceEnv);
    const snapshots = await readdir(settings.BACKUP_ROOT);
    assert.equal(snapshots.length, 1);
    const backupPath = join(settings.BACKUP_ROOT, snapshots[0]!);
    for (const photo of [inRemovedFamily, removedMemory, removedPhoto, retained]) {
      await access(join(backupPath, 'media', photo.objectKey));
    }
    source = buildApp(config, sourcePool);
    await source.ready();
    const reauth = (await request(source, 200, '/v2/sessions/reauth', {
      method: 'POST', token, payload: { [credential]: phrase },
    })).json<{ reauthToken: string }>().reauthToken;
    const familyJob = (await request(source, 202, `/v2/families/${removed.id}`, {
      method: 'DELETE', token, payload: { operationId: randomUUID(), confirmFamilyName: removed.name, reauthToken: reauth },
    })).json<{ jobId: string }>().jobId;
    const memoryDelete = { operationId: randomUUID(), baseRevision: 1, permanent: true };
    const memoryRoute = `/v2/memories/${removedMemory.id}`;
    const memoryAck = (await request(source, 200, memoryRoute, { method: 'DELETE', token, payload: memoryDelete })).json();
    assert.deepEqual((await request(source, 200, memoryRoute, { method: 'DELETE', token, payload: memoryDelete })).json(), memoryAck);
    await request(source, 200, removedPhoto.mediaPath, { method: 'DELETE', token, payload: { operationId: randomUUID() } });
    for (const path of [inRemovedFamily.signed, removedMemory.signed, removedPhoto.signed, oldExport]) await request(source, 404, path);
    await request(source, 410, `/v2/families/${kept.id}/changes?cursor=${cursor}`, { token });
    await request(source, 409, removedMemory.path, { method: 'POST', token, payload: removedMemory.payload });
    await waitFor(async () => (await request(source!, 200, `/v2/jobs/${familyJob}`, { token }))
      .json<{ state: string }>(), job => job.state === 'ready');
    const memberId = (await request(source, 200, '/v2/bootstrap', { token: helperToken })).json<{ user: { id: string } }>().user.id;
    await request(source, 200, `/v2/families/${kept.id}/members/${memberId}`, {
      method: 'DELETE', token, payload: { operationId: randomUUID() },
    });
    await source.close();
    source = undefined;
    const existingEntries = (await readdir(settings.DELETION_JOURNAL_ROOT)).sort();
    assert.equal(existingEntries.length, 4);
    const restoreArgs = ['-EnvironmentFile', sourceEnv, '-BackupPath', backupPath, '-TargetDatabase', targetDatabaseName, '-ConfirmRestore'];
    const marker = join(settings.DELETION_JOURNAL_ROOT, 'journal.json');
    await rename(marker, marker + '.temporarily-missing');
    try {
      await assert.rejects(ps('Restore-BabyPlan.ps1', ...restoreArgs));
      const db = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [targetDatabaseName]);
      assert.equal(db.rowCount, 0);
    } finally {
      await rename(marker + '.temporarily-missing', marker);
    }
    await ps('Restore-BabyPlan.ps1', ...restoreArgs);
    restored = true;
    const restoredRoot = join(settings.RESTORE_ROOT, `media-${targetDatabaseName}`);
    const report = JSON.parse(await readFile(join(settings.RESTORE_ROOT, `restore-${targetDatabaseName}.json`), 'utf8'));
    assert.equal(report.deletionEventsReapplied, 3);
    assert.equal(report.mediaFileCount, 2, '只剩保留的原图和缩略图');
    assert.ok(report.elapsedSeconds < 4 * 60 * 60);
    assert.ok(report.backupAgeSeconds < 24 * 60 * 60);
    const cleaned = await targetPool.query("SELECT kind FROM app.permanent_deletions WHERE cleaned_at IS NOT NULL ORDER BY kind");
    assert.deepEqual(cleaned.rows.map(row => row.kind), ['family', 'media', 'memory']);
    const purged = await targetPool.query('SELECT text FROM app.memories WHERE id=$1', [removedMemory.id]);
    assert.equal(purged.rows[0]?.text, '（已删除）');
    const changeHistory = await targetPool.query('SELECT count(*)::int AS count FROM app.changes WHERE entity_id=$1 AND payload IS NOT NULL', [removedMemory.id]);
    assert.equal(changeHistory.rows[0]?.count, 0);
    for (const photo of [inRemovedFamily, removedMemory, removedPhoto]) {
      await assert.rejects(access(join(restoredRoot, photo.objectKey)), { code: 'ENOENT' });
    }
    target = buildApp(loadConfig({ ...settings, DATABASE_URL: targetUrl.toString(), MEDIA_ROOT: restoredRoot }), targetPool);
    await target.ready();
    await request(target, 401, '/v2/bootstrap', { token });
    const newToken = await login(target, email);
    const newHelperToken = await login(target, helperEmail);
    await request(target, 404, `/v2/families/${removed.id}/snapshot`, { token: newToken });
    await request(target, 404, snapshotPath, { token: newHelperToken });
    await request(target, 409, '/v2/invitations/accept', {
      method: 'POST', token: newHelperToken, payload: { operationId: randomUUID(), token: unusedInvite },
    });
    await request(target, 410, `/v2/families/${kept.id}/changes?cursor=${cursor}`, { token: newToken });
    const snapshot = (await request(target, 200, snapshotPath, { token: newToken })).json<{
      memories: { id: string; text: string; mediaIds: string[] }[];
      media: { id: string }[];
    }>();
    assert.deepEqual(new Set(snapshot.memories.map(memory => memory.text)), new Set([removedPhoto.text, retained.text]));
    assert.deepEqual(snapshot.memories.find(memory => memory.id === removedPhoto.id)?.mediaIds, []);
    assert.deepEqual(snapshot.media.map(media => media.id), [retained.mediaId]);
    await request(target, 404, removedPhoto.mediaPath, { token: newToken });
    await request(target, 404, oldExport);
    await request(target, 404, retained.signed);
    const retainedAfter = (await request(target, 200, retained.mediaPath, { token: newToken })).json<{ downloadUrl: string }>();
    assert.deepEqual((await request(target, 200, relativeUrl(retainedAfter.downloadUrl))).rawPayload, retainedBytes);

    const evidence = {
      format: 'babyplan-deletion-replay-drill-v1',
      checkedOn: new Date().toISOString(),
      postgres: report.restoreServerVersion,
      migrations: migrationNames,
      restoreSeconds: report.elapsedSeconds,
      backupAgeSeconds: report.backupAgeSeconds,
      archivedMediaFiles: 9,
      restoredMediaFiles: report.mediaFileCount,
      deletionEventsReapplied: report.deletionEventsReapplied,
      verified: [
        'missing-journal-refuses-restore', 'family-is-gone', 'memory-text-and-history-are-gone',
        'one-photo-is-gone-and-its-memory-stays', 'old-export-and-signed-urls-do-not-work',
        'restored-owner-can-read-byte-identical-photo', 'old-session-invite-cursor-rejected',
        'removed-member-cannot-return-after-restore',
      ],
      scope: '本机隔离集群，虚构账号与图片，非生产恢复时间',
    };
    await writeFile(join(artifactRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`删除恢复证据：${join(artifactRoot, 'evidence.json')}`);
  } finally {
    await target?.close();
    await source?.close();
    await targetPool.end();
    await sourcePool.end();
    if (restored) await adminPool.query(`DROP DATABASE "${targetDatabaseName}"`);
    if (sourceCreated) await adminPool.query(`DROP DATABASE "${appDatabaseName}"`);
    if (roleCreated) await adminPool.query(`DROP ROLE "${sqlRole}"`);
    await adminPool.end();
  }
});
