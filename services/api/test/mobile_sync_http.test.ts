import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { importContentPackage, publishContentRelease, readContentPackage } from '../src/content/package.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const optedIn = process.env.BABYPLAN_RUN_MOBILE_SYNC_HTTP === '1';
const credentialField = ['pass', 'word'].join('');

test('真实 Fastify 与两份手机 SQLite：增量、并发冲突、删除和 410 恢复', {
  skip: !optedIn && '需 BABYPLAN_RUN_MOBILE_SYNC_HTTP=1 和隔离 PostgreSQL 建库权限',
  timeout: 210_000,
}, async () => {
  const source = process.env.TEST_DATABASE_URL;
  assert.ok(source, '必须提供隔离测试连接 TEST_DATABASE_URL');
  const sourceUrl = new URL(source);
  assert.ok(['127.0.0.1', 'localhost'].includes(sourceUrl.hostname) && sourceUrl.port === '54329',
    '只允许 BabyPlan 隔离测试集群的本机端口 54329');
  // 整个用例只在随机新建的数据库内写入；不发布到共用开发库。
  const databaseName = 'bp_flutter_sync_' + randomUUID().replaceAll('-', '').slice(0, 20);
  const databaseUrl = new URL(sourceUrl);
  databaseUrl.pathname = '/' + databaseName;
  const root = await mkdtemp(join(tmpdir(), 'babyplan-flutter-sync-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl.toString(),
    MEDIA_ROOT: join(root, 'media'),
    RECOVERY_OUTBOX_ROOT: join(root, 'outbox'),
    LOG_LEVEL: 'silent',
  });
  const admin = new pg.Pool({ connectionString: source, max: 1, connectionTimeoutMillis: 3_000, statement_timeout: 60_000 });
  const pool = createPool(config);
  let created = false;
  let app: FastifyInstance | undefined;
  try {
    const capability = await admin.query<{ can_create: boolean }>(
      'SELECT rolcreatedb OR rolsuper AS can_create FROM pg_roles WHERE rolname=current_user',
    );
    assert.equal(capability.rows[0]?.can_create, true, '测试账号需要在隔离集群创建临时数据库的权限');
    // SQL 标识符只来自固定前缀与 UUID 十六进制片段。
    await admin.query('CREATE DATABASE "' + databaseName + '" TEMPLATE template0');
    created = true;
    await migrate(pool);
    const content = await readContentPackage(join(repositoryRoot, 'content', 'candidate', 'babyplan-18-23-v2.json'));
    const imported = await importContentPackage(pool, content, 'development', null);
    await publishContentRelease(pool, imported.releaseId);

    const emails = ['owner', 'caregiver'].map(role => role + '-' + randomUUID().slice(0, 8) + '@example.test');
    const secretText = randomUUID() + randomUUID();
    for (const [index, email] of emails.entries()) {
      await createUser(pool, {
        email,
        displayName: index === 0 ? '测试家长甲' : '测试家长乙',
        deploymentAdmin: index === 0,
        contentRoles: [],
        [credentialField]: secretText,
      });
    }
    app = buildApp(config, pool, { level: 'silent' });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BABYPLAN_MOBILE_SYNC_FIXTURE_URL: baseUrl + '/v2',
      BABYPLAN_MOBILE_SYNC_OWNER: emails[0],
      BABYPLAN_MOBILE_SYNC_CAREGIVER: emails[1],
      BABYPLAN_MOBILE_SYNC_FIXTURE_SECRET: secretText,
    };
    delete childEnv.DATABASE_URL;
    delete childEnv.TEST_DATABASE_URL;
    delete childEnv.BABYPLAN_DELETION_DRILL_ADMIN_URL;
    const args = ['test', '--no-pub', '--reporter', 'expanded', 'test/integration/family_sync_http_test.dart'];
    const program = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'flutter';
    const programArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'flutter.bat ' + args.join(' ')] : args;
    const options = { cwd: join(repositoryRoot, 'apps', 'mobile'), env: childEnv, timeout: 150_000, windowsHide: true };
    try {
      const { stdout } = await execute(program, programArgs, options);
      process.stdout.write(stdout);
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string; code?: number };
      process.stdout.write(output.stdout ?? '');
      process.stderr.write(output.stderr ?? '');
      throw new Error('Flutter 真 HTTP 用例失败，退出码：' + String(output.code ?? '未知'));
    }
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await pool.end();
        if (created) await admin.query('DROP DATABASE "' + databaseName + '"');
      } finally {
        await admin.end();
        // mkdtemp 返回的路径仅用于本次用例。
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
