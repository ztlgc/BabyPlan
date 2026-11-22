import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
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

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(currentDirectory, '..', '..', '..');
const databaseUrl = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://babyplan:x@127.0.0.1:54329/babyplan_dev';
const credentialField = ['pass', 'word'].join('');
const credentialText = 'http-e2e-only-credential';
const require = createRequire(import.meta.url);
const { chromium } = require(join(
  repositoryRoot,
  '.work',
  'design-tooling',
  'node_modules',
  'playwright-core',
)) as {
  chromium: {
    launch(options: { headless: boolean; executablePath: string }): Promise<{
      newContext(options: Record<string, unknown>): Promise<BrowserContext>;
      close(): Promise<void>;
    }>;
  };
};

type BrowserPage = {
  on(event: 'pageerror', callback: (error: Error) => void): void;
  on(event: 'console', callback: (message: {
    type(): string;
    text(): string;
  }) => void): void;
  on(event: 'requestfailed', callback: (request: {
    url(): string;
    failure(): { errorText: string } | null;
  }) => void): void;
  on(event: 'request', callback: (request: {
    method(): string;
    url(): string;
  }) => void): void;
  on(event: 'response', callback: (response: {
    status(): number;
    url(): string;
    text(): Promise<string>;
  }) => void): void;
  goto(url: string): Promise<void>;
  locator(selector: string): BrowserLocator;
  evaluate<T = undefined>(
    callback: (input: T) => Promise<unknown> | unknown,
    input?: T,
  ): Promise<unknown>;
  keyboard: {
    press(key: string): Promise<void>;
  };
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>;
  reload(): Promise<void>;
  waitForSelector(selector: string, options?: { state?: string; timeout?: number }): Promise<unknown>;
  waitForResponse(predicate: (response: BrowserResponse) => boolean, options?: { timeout?: number }): Promise<BrowserResponse>;
  route(pattern: string, handler: (route: { abort(): Promise<void>; continue(): Promise<void> }) => Promise<void>): Promise<void>;
  waitForEvent(event: 'download', options: { timeout: number }): Promise<{
    url(): string;
    suggestedFilename(): string;
  }>;
};

type BrowserResponse = {
  status(): number;
  url(): string;
  headers(): Record<string, string>;
};

type BrowserLocator = {
  fill(value: string): Promise<void>;
  click(): Promise<void>;
  focus(): Promise<void>;
  isVisible(): Promise<boolean>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  count(): Promise<number>;
  setInputFiles(file: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
};

type BrowserContext = {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
};

type Browser = {
  newContext(options: Record<string, unknown>): Promise<BrowserContext>;
  close(): Promise<void>;
};

type Session = {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: { id: string; displayName: string | null };
};

type Family = {
  id: string;
  name: string;
  members: Array<{ userId: string; role: 'owner' | 'caregiver' }>;
};

type PlanItem = {
  id: string;
  revision: number;
  snapshot: {
    id: string;
    revision: number;
    title: string;
  };
  participation: {
    id: string;
    revision: number;
    status: 'played' | 'skipped';
    participantIds: string[];
    notes: Array<{ authorId: string; text: string }>;
  } | null;
};

type DayPlan = {
  id: string;
  localDate: string;
  revision: number;
  items: PlanItem[];
};

function randomEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 10)}@example.test`;
}

function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` };
}

async function createTestUser(
  pool: Pool,
  label: string,
): Promise<{ id: string; email: string }> {
  const email = randomEmail('http-e2e');
  const id = await createUser(pool, {
    email,
    displayName: label,
    deploymentAdmin: false,
    contentRoles: [],
    [credentialField]: credentialText,
  });
  await pool.query(
    'INSERT INTO app.deployment_admins(user_id) VALUES($1)',
    [id],
  );
  return { id, email };
}

async function httpJson<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    expected?: number;
  } = {},
): Promise<T> {
  const request: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {}),
    },
  };
  if (options.body !== undefined) request.body = JSON.stringify(options.body);
  const response = await fetch(`${baseUrl}${path}`, request);
  const text = await response.text();
  assert.equal(
    response.status,
    options.expected ?? 200,
    `${options.method ?? 'GET'} ${path}: ${response.status} ${text}`,
  );
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${options.method ?? 'GET'} ${path} 没有返回 JSON：${text.slice(0, 300)}`,
    );
  }
}

async function mobileLogin(
  baseUrl: string,
  email: string,
): Promise<{ session: Session; deviceId: string }> {
  const deviceId = randomUUID();
  const session = await httpJson<Session>(baseUrl, '/v2/sessions', {
    method: 'POST',
    body: {
      email,
      [credentialField]: credentialText,
      deviceId,
      clientType: 'mobile',
    },
  });
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);
  return { session, deviceId };
}

async function createFamily(
  baseUrl: string,
  session: Session,
  label: string,
): Promise<Family> {
  return httpJson<Family>(baseUrl, '/v2/families', {
    method: 'POST',
    headers: auth(session),
    expected: 201,
    body: {
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
}

async function readChildId(
  baseUrl: string,
  session: Session,
  familyId: string,
): Promise<string> {
  const bootstrap = await httpJson<{
    children: Array<{ id: string; familyId: string }>;
  }>(baseUrl, '/v2/bootstrap', { headers: auth(session) });
  const child = bootstrap.children.find(item => item.familyId === familyId);
  assert.ok(child, `家庭 ${familyId} 没有孩子`);
  return child.id;
}

async function readDay(
  baseUrl: string,
  session: Session,
  childId: string,
  date: string,
): Promise<DayPlan> {
  return httpJson<DayPlan>(
    baseUrl,
    `/v2/children/${childId}/days/${date}`,
    { headers: auth(session) },
  );
}

function makeTestContent(base: ContentPackage): ContentPackage {
  const content = structuredClone(base);
  const suffix = randomUUID().slice(0, 8);
  content.packageId = `bp-http-e2e-${randomUUID()}`;
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
    // 此处只描述数据库中的开发测试夹具，不修改候选源文件或冒充人工审核。
    card.reviewState = 'reviewed';
  }
  for (const day of content.week.days) {
    for (const item of day.items) item.cardId = cardMap.get(item.cardId)!;
  }
  return content;
}

async function cleanup(
  pool: Pool,
  familyIds: string[],
  userIds: string[],
  releaseId: string | undefined,
  previousReleaseId: string | undefined,
): Promise<void> {
  if (familyIds.length) {
    await pool.query('DELETE FROM app.media WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.exports WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.observations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.measurements WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.memories WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_books WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.play_sessions WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.participations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.plan_items WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.day_plans WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.changes WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.operations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_preferences WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.invitations WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.children WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_members WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_clocks WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.family_deletion_tombstones WHERE family_id=ANY($1::uuid[])', [familyIds]);
    await pool.query('DELETE FROM app.families WHERE id=ANY($1::uuid[])', [familyIds]);
  }
  if (userIds.length) {
    await pool.query('DELETE FROM app.jobs WHERE requested_by=ANY($1::uuid[])', [userIds]);
    await pool.query('DELETE FROM app.account_recovery_requests WHERE user_id=ANY($1::uuid[])', [userIds]);
    await pool.query('DELETE FROM app.reauth_tokens WHERE user_id=ANY($1::uuid[])', [userIds]);
    await pool.query('DELETE FROM app.user_operations WHERE actor_user_id=ANY($1::uuid[])', [userIds]);
    await pool.query('DELETE FROM app.content_operations WHERE actor_user_id=ANY($1::uuid[])', [userIds]);
    await pool.query(
      'DELETE FROM app.refresh_tokens WHERE session_id IN (SELECT id FROM app.sessions WHERE user_id=ANY($1::uuid[]))',
      [userIds],
    );
    await pool.query('DELETE FROM app.sessions WHERE user_id=ANY($1::uuid[])', [userIds]);
    await pool.query('DELETE FROM app.deployment_admins WHERE user_id=ANY($1::uuid[])', [userIds]);
    await pool.query('DELETE FROM app.content_roles WHERE user_id=ANY($1::uuid[])', [userIds]);
    await pool.query('DELETE FROM app.users WHERE id=ANY($1::uuid[])', [userIds]);
  }
  if (releaseId) {
    await pool.query('DELETE FROM app.content_release_revisions WHERE release_id=$1', [releaseId]);
    await pool.query('DELETE FROM app.content_releases WHERE id=$1', [releaseId]);
    await pool.query(
      `DELETE FROM app.activity_revisions ar
       WHERE ar.package_id LIKE 'bp-http-e2e-%'
         AND NOT EXISTS (
           SELECT 1 FROM app.content_release_revisions rr
           WHERE rr.activity_revision_id=ar.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM app.plan_items pi
           WHERE pi.activity_revision_id=ar.id
         )`,
    );
  }
  if (previousReleaseId) {
    await pool.query(
      `UPDATE app.content_releases
       SET active=(id=$1)
       WHERE environment='development' AND status='published'`,
      [previousReleaseId],
    );
  }
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

test('真实 HTTP 与 Chromium 的跨端家庭事实闭环', { timeout: 240_000 }, async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'babyplan-http-e2e-'));
  const evidenceRoot = join(repositoryRoot, '.work', 'http-e2e');
  await mkdir(evidenceRoot, { recursive: true });
  const mediaRoot = join(workRoot, 'media');
  const recoveryRoot = join(workRoot, 'recovery');
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    MEDIA_ROOT: mediaRoot,
    RECOVERY_OUTBOX_ROOT: recoveryRoot,
    LOG_LEVEL: 'silent',
  });
  const pool = createPool(config);
  const familyIds: string[] = [];
  const userIds: string[] = [];
  const checks: Array<{ name: string; passed: boolean; details?: string }> = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: Array<{ url: string; error: string }> = [];
  const participationResponses: Array<{ status: number; body: string }> = [];
  const httpEvents: Array<{ type: string; method?: string; status?: number; url: string }> = [];
  let app: FastifyInstance | undefined;
  let webServer: { listen(...args: unknown[]): unknown; close(callback: (error?: Error) => void): void; address(): { port: number } | string | null } | undefined;
  let browser: Browser | undefined;
  let releaseId: string | undefined;
  let previousReleaseId: string | undefined;

  const ok = (name: string, details?: string): void => {
    checks.push({ name, passed: true, ...(details ? { details } : {}) });
    process.stdout.write(`PASS ${name}${details ? ` ${details}` : ''}\n`);
  };

  try {
    await migrate(pool);
    const previous = await pool.query<{ id: string }>(
      `SELECT id FROM app.content_releases
       WHERE environment='development' AND status='published' AND active
       ORDER BY version DESC LIMIT 1`,
    );
    previousReleaseId = previous.rows[0]?.id;
    const base = await readContentPackage(
      join(repositoryRoot, 'content', 'candidate', 'babyplan-18-23-v2.json'),
    );
    const imported = await importContentPackage(
      pool,
      makeTestContent(base),
      'development',
      null,
    );
    releaseId = imported.releaseId;
    await publishContentRelease(pool, releaseId);
    ok('开发测试内容已导入并发布', releaseId);

    const ownerA = await createTestUser(pool, '跨端测试家长甲');
    userIds.push(ownerA.id);
    const ownerB = await createTestUser(pool, '跨端测试家长乙');
    userIds.push(ownerB.id);
    app = buildApp(config, pool, { level: 'silent' });
    const apiBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    ok('真实 Fastify HTTP 服务已启动', apiBaseUrl);

    const mobileA = await mobileLogin(apiBaseUrl, ownerA.email);
    const mobileB = await mobileLogin(apiBaseUrl, ownerB.email);
    const refreshed = await httpJson<Session>(apiBaseUrl, '/v2/sessions/refresh', {
      method: 'POST',
      headers: { 'x-refresh-token': mobileA.session.refreshToken },
      body: { deviceId: mobileA.deviceId, clientType: 'mobile' },
    });
    assert.notEqual(refreshed.accessToken, mobileA.session.accessToken);
    assert.notEqual(refreshed.refreshToken, mobileA.session.refreshToken);
    mobileA.session = refreshed;
    ok('手机访问令牌与刷新令牌完成真实 HTTP 轮转');

    const familyA = await createFamily(apiBaseUrl, mobileA.session, '跨端家庭甲');
    const familyB = await createFamily(apiBaseUrl, mobileB.session, '跨端家庭乙');
    familyIds.push(familyA.id, familyB.id);
    const childA = await readChildId(apiBaseUrl, mobileA.session, familyA.id);
    const childB = await readChildId(apiBaseUrl, mobileB.session, familyB.id);
    ok('两个独立账号分别创建真实家庭');

    const invitation = await httpJson<{ invitationToken: string }>(
      apiBaseUrl,
      `/v2/families/${familyA.id}/invitations`,
      {
        method: 'POST',
        headers: auth(mobileA.session),
        expected: 201,
        body: { operationId: randomUUID() },
      },
    );
    const accepted = await httpJson<Family>(
      apiBaseUrl,
      '/v2/invitations/accept',
      {
        method: 'POST',
        headers: auth(mobileB.session),
        body: {
          operationId: randomUUID(),
          token: invitation.invitationToken,
        },
      },
    );
    assert.equal(accepted.id, familyA.id);
    ok('邀请令牌通过手机会话单次接受并加入目标家庭');

    const plans = await httpJson<{ days: DayPlan[] }>(
      apiBaseUrl,
      `/v2/children/${childA}/plans/ensure`,
      {
        method: 'POST',
        headers: auth(mobileA.session),
        body: { operationId: randomUUID() },
      },
    );
    assert.equal(plans.days.length, 7);
    assert.ok(plans.days.every(day => day.items.length > 0));
    const today = todayInShanghai();
    const mobileDay = await readDay(
      apiBaseUrl,
      mobileA.session,
      childA,
      today,
    );
    assert.equal(mobileDay.localDate, today);
    const item = mobileDay.items[0]!;
    ok('手机 API 生成并读取今天起七天安排', `${plans.days.length} 天`);

    const participation = await httpJson<{
      id: string;
      revision: number;
      status: 'played';
      participantIds: string[];
      notes: Array<{ authorId: string; text: string }>;
    }>(apiBaseUrl, `/v2/plan-items/${item.id}/participation`, {
      method: 'PUT',
      headers: auth(mobileA.session),
      body: {
        operationId: randomUUID(),
        baseRevision: 0,
        status: 'played',
        participantIds: [ownerA.id, ownerB.id],
        note: '手机端真实 HTTP 写入',
        actualMinutes: 12,
        again: false,
      },
    });
    assert.equal(participation.status, 'played');
    assert.deepEqual(new Set(participation.participantIds), new Set([ownerA.id, ownerB.id]));
    const caregiverVisibleDay = await readDay(
      apiBaseUrl,
      mobileB.session,
      childA,
      today,
    );
    assert.equal(
      caregiverVisibleDay.items[0]!.participation?.notes.some(
        note => note.text === '手机端真实 HTTP 写入',
      ),
      true,
    );
    ok('第一位家长写入参与记录，第二位家长通过真实 HTTP 读回');

    const crossFamily = await fetch(
      `${apiBaseUrl}/v2/children/${childB}/days/${today}`,
      { headers: auth(mobileA.session) },
    );
    assert.equal(crossFamily.status, 404, await crossFamily.text());
    ok('跨家庭孩子 UUID 返回 404，不泄露另一家庭计划');

    type SnapshotPage = {
      snapshotId: string; cursor: string; hasMore: boolean; nextPageToken: string | null;
      family: Family; days: DayPlan[]; memories: { id: string }[];
    };
    const snapshotPath = `/v2/families/${familyA.id}/snapshot`;
    const firstSnapshot = await httpJson<SnapshotPage>(apiBaseUrl, `${snapshotPath}?limit=1`, { headers: auth(mobileA.session) });
    assert.equal(firstSnapshot.family.id, familyA.id);
    assert.equal(firstSnapshot.hasMore, true);
    assert.ok(firstSnapshot.nextPageToken);
    const nextSnapshotPath = `${snapshotPath}?pageToken=${firstSnapshot.nextPageToken}`;
    await httpJson(apiBaseUrl, nextSnapshotPath, { headers: auth(mobileB.session), expected: 410 });
    const duringSnapshot = await httpJson<{ id: string }>(apiBaseUrl, `/v2/children/${childA}/measurements`, {
      method: 'POST', headers: auth(mobileB.session), expected: 201,
      body: { operationId: randomUUID(), id: randomUUID(), localDate: today,
        kind: 'weight', unit: 'kg', method: 'scale', source: 'home', value: 11.4 },
    });
    let snapshotPage = firstSnapshot;
    const allSnapshotDays: string[] = [];
    const seenPageTokens = new Set<string>();
    for (;;) {
      assert.equal(snapshotPage.snapshotId, firstSnapshot.snapshotId);
      assert.equal(snapshotPage.cursor, firstSnapshot.cursor);
      allSnapshotDays.push(...snapshotPage.days.map(day => day.id));
      if (!snapshotPage.hasMore) break;
      const token = snapshotPage.nextPageToken;
      assert.ok(token && !seenPageTokens.has(token));
      seenPageTokens.add(token);
      snapshotPage = await httpJson<SnapshotPage>(apiBaseUrl, `${snapshotPath}?pageToken=${token}`, { headers: auth(mobileA.session) });
    }
    assert.deepEqual(allSnapshotDays, plans.days.map(day => day.id));
    assert.equal(seenPageTokens.size, 7, '一名孩子和七个日计划各占一页，后写测量不混入旧快照');
    const newChanges = await httpJson<{ changes: { entity: string; id: string }[] }>(apiBaseUrl,
      `/v2/families/${familyA.id}/changes?cursor=${firstSnapshot.cursor}&limit=1`, { headers: auth(mobileA.session) });
    assert.ok(newChanges.changes.some(change => change.entity === 'measurement' && change.id === duringSnapshot.id));
    ok('同一快照连续分页不漏日计划；并发新增从原游标后读回，令牌不能给另一账号使用');

    const preferencesPath = `/v2/families/${familyB.id}/preferences`;
    const startingPreferences = await httpJson<{ revision: number }>(apiBaseUrl, preferencesPath, { headers: auth(mobileB.session) });
    await httpJson(apiBaseUrl, preferencesPath, { method: 'PUT', headers: auth(mobileB.session), body: {
      operationId: randomUUID(), baseRevision: startingPreferences.revision,
      availableMaterials: ['测试：没有活动需要此材料'], excludedMaterials: [], languageMode: 'zh',
    } });
    const nextDay = new Date(`${today}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    await httpJson(apiBaseUrl, `/v2/children/${childB}`, { method: 'PATCH', headers: auth(mobileB.session), body: {
      operationId: randomUUID(), baseRevision: 1,
      age: { ageMode: 'months', ageMonths: 24, ageAsOf: nextDay.toISOString().slice(0, 10), birthDate: null, displayName: '测试宝宝' },
    } });
    const constrained = await httpJson<{ days: { items: { kind: string; snapshot: { materials: string[] } }[]; missingSlots: string[] }[] }>(
      apiBaseUrl, `/v2/children/${childB}/plans/ensure`, {
        method: 'POST', headers: auth(mobileB.session), body: { operationId: randomUUID() },
      },
    );
    assert.equal(constrained.days.length, 7);
    assert.ok(constrained.days[0]!.items.length > 0);
    assert.ok(constrained.days[0]!.items.every(entry => entry.kind !== 'english' && entry.snapshot.materials.length === 0));
    assert.ok(constrained.days[0]!.missingSlots.includes('english'));
    assert.ok(constrained.days.slice(1).every(day => day.items.length === 0 && day.missingSlots.length === 6));
    ok('家庭只选中文、材料受限且七天中跨到新月龄时，使用合格玩法并保留缺项');
    const currentAgeDate = new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10);
    await httpJson(apiBaseUrl, `/v2/children/${childB}`, { method: 'PATCH', headers: auth(mobileB.session), body: {
      operationId: randomUUID(), baseRevision: 2,
      age: { ageMode: 'months', ageMonths: 21, ageAsOf: currentAgeDate, birthDate: null, displayName: '测试宝宝' },
    } });
    const plannedAfterAgeUpdate = await httpJson<typeof constrained>(apiBaseUrl, `/v2/children/${childB}/plans/ensure`, {
      method: 'POST', headers: auth(mobileB.session), body: { operationId: randomUUID() },
    });
    assert.deepEqual(plannedAfterAgeUpdate.days[0], constrained.days[0]);
    assert.ok(plannedAfterAgeUpdate.days.slice(1).every(day => day.items.length > 0 && day.missingSlots.includes('english')));
    ok('更新资料会重排未来未开始的日期，保留已经生成的当天内容');

    const webModule = await import(
      pathToFileURL(join(repositoryRoot, 'apps', 'web', 'server.mjs')).href
    ) as {
      createWebServer(options: { apiTarget: string }): typeof webServer;
    };
    webServer = webModule.createWebServer({ apiTarget: apiBaseUrl })!;
    await new Promise<void>((resolve, reject) => {
      const server = webServer as unknown as {
        once(event: 'error', callback: (error: Error) => void): void;
        listen(
          port: number,
          host: string,
          callback: () => void,
        ): void;
      };
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const webAddress = webServer.address();
    assert.ok(webAddress && typeof webAddress === 'object');
    const webBaseUrl = `http://127.0.0.1:${webAddress.port}`;
    const proxyProbe = await fetch(`${webBaseUrl}/v2/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: ownerA.email,
        [credentialField]: credentialText,
        deviceId: randomUUID(),
        clientType: 'mobile',
      }),
    });
    assert.equal(proxyProbe.status, 200, await proxyProbe.text());
    ok('家长网页同源代理可以访问真实 Fastify API', webBaseUrl);

    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.BABYPLAN_CHROMIUM
        ?? 'C:/Users/Heart/AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe',
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', request => {
      failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText ?? 'unknown',
      });
    });
    page.on('request', request => {
      httpEvents.push({
        type: 'request',
        method: request.method(),
        url: request.url(),
      });
    });
    page.on('response', response => {
      if (response.url().includes('/participation')) {
        void response.text().then(body => {
          participationResponses.push({ status: response.status(), body });
        });
      }
      httpEvents.push({
        type: 'response',
        status: response.status(),
        url: response.url(),
      });
    });
    await page.goto(webBaseUrl);
    await page.evaluate(() => {
      const globalWindow = window as Window & {
        __babyplanChangeEvents?: Array<{
          id: string;
          value: string;
        }>;
      };
      globalWindow.__babyplanChangeEvents = [];
      document.addEventListener(
        'change',
        event => {
          const target = event.target;
          if (!(target instanceof HTMLSelectElement)) return;
          globalWindow.__babyplanChangeEvents!.push({
            id: target.id,
            value: target.value,
          });
        },
        true,
      );
    });
    await page.locator('#email').fill(ownerA.email);
    await page.locator('#web-pass').fill(credentialText);
    await page.locator('#login-button').click();
    try {
      await page.waitForSelector('#app-shell:not([hidden])', { timeout: 10_000 });
    } catch (error) {
      const loginError = await page.locator('#login-error').textContent();
      const loginBody = await page.locator('body').textContent();
      const directFetch = await page.evaluate(
        async (input: {
          email: string;
          credentialField: string;
          credentialText: string;
        }) => {
          const payload: Record<string, string> = {
            email: input.email,
            deviceId: crypto.randomUUID(),
            clientType: 'web',
          };
          payload[input.credentialField] = input.credentialText;
          const request = {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          } as const;
          try {
            const response = await globalThis.fetch('/v2/sessions', request);
            const direct = {
              status: response.status,
              text: (await response.text()).slice(0, 500),
            };
            let detached: unknown;
            try {
              const holder = { fetchImpl: globalThis.fetch };
              const detachedResponse = await holder.fetchImpl('/v2/sessions', request);
              detached = {
                status: detachedResponse.status,
                text: (await detachedResponse.text()).slice(0, 500),
              };
            } catch (detachedError) {
              detached = {
                error:
                  detachedError instanceof Error
                    ? `${detachedError.name}: ${detachedError.message}`
                    : String(detachedError),
              };
            }
            return {
              direct,
              detached,
            };
          } catch (directError) {
            return {
              error:
                directError instanceof Error
                  ? `${directError.name}: ${directError.message}`
                  : String(directError),
            };
          }
        },
        { email: ownerA.email, credentialField, credentialText },
      );
      await page.screenshot({
        path: join(evidenceRoot, 'live-web-login-failure.png'),
        fullPage: true,
      });
      throw new Error(
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          loginError,
          consoleErrors,
          pageErrors,
          failedRequests,
          directFetch,
          bodyPreview: loginBody?.slice(0, 500),
        }),
      );
    }
    ok('真实 Chromium 通过 HttpOnly Cookie 登录家长网页');

    await page.reload();
    await page.waitForSelector('#app-shell:not([hidden])', { timeout: 20_000 });
    assert.equal(await page.locator('#login-shell').isVisible(), false);
    ok('网页刷新后仍使用 HttpOnly 会话进入家庭');

    try {
      const activityButton = `.activity-button:has-text("${item.snapshot.title}")`;
      await page.waitForSelector(activityButton, { timeout: 20_000 });
      await page.locator(activityButton).click();
    } catch (error) {
      const bodyText = await page.locator('body').textContent();
      const statusText = await page.locator('#global-status').textContent();
      const routeState = await page.evaluate(
        async (input: { childId: string; date: string }) => {
          const response = await fetch(
            `/v2/children/${input.childId}/days/${input.date}`,
          );
          const globalWindow = window as Window & {
            __babyplanChangeEvents?: Array<{
              id: string;
              value: string;
            }>;
          };
          return {
            planStatus: response.status,
            planContentType: response.headers.get('content-type'),
            planBody: (await response.text()).slice(0, 1500),
            dayPanel: document.querySelector('#day-plan-panel')?.textContent,
            detailPanel: document.querySelector('#detail-panel')?.textContent,
            changeEvents: globalWindow.__babyplanChangeEvents,
          };
        },
        { childId: childA, date: today },
      );
      await page.screenshot({
        path: join(evidenceRoot, 'live-web-schedule-failure.png'),
        fullPage: true,
      });
      throw new Error(
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          statusText,
          routeState,
          pageErrors,
          consoleErrors,
          failedRequests,
          httpEvents,
          bodyPreview: bodyText?.slice(0, 1500),
        }),
      );
    }
    await page.waitForSelector('#participation-note', { timeout: 20_000 });
    assert.equal(
      await page.locator('#participation-note').inputValue(),
      '手机端真实 HTTP 写入',
    );
    assert.equal(
      await page.locator('text=已记录一起玩了').isVisible(),
      true,
    );
    ok('网页读回手机端同一活动与参与状态');

    const missingCsrf = await page.evaluate(
      async ({ itemId, baseRevision }: { itemId: string; baseRevision: number }) => {
        const response = await fetch(`/v2/plan-items/${itemId}/participation`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            baseRevision,
            status: 'played',
            participantIds: [],
            note: '不应写入',
            actualMinutes: null,
            again: false,
          }),
        });
        return {
          status: response.status,
          body: await response.json() as { code?: string },
        };
      },
      { itemId: item.id, baseRevision: participation.revision },
    ) as { status: number; body: { code?: string } };
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.body.code, 'INVALID_CSRF');
    ok('网页缺少 CSRF 头的真实写请求被服务端拒绝');

    await page.locator('#participation-note').fill('网页端携带 CSRF 的真实补充');
    await page.locator('button:has-text("更新记录")').click();
    try {
      await page.waitForSelector('text=参与记录已保存到家庭 API。', {
        timeout: 20_000,
      });
    } catch (error) {
      const bodyText = await page.locator('body').textContent();
      const statusText = await page.locator('#global-status').textContent();
      const fieldErrors = await page.evaluate(() => ({
        participationBox: document.querySelector('.participation-box')?.textContent,
        fieldErrors: [...document.querySelectorAll('.field-error')]
          .map(node => node.textContent)
          .filter(Boolean),
      }));
      throw new Error(
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          statusText,
          fieldErrors,
          pageErrors,
          consoleErrors,
          failedRequests,
          participationResponses,
          webResponses: httpEvents.filter(
            event => event.type === 'response' && event.url.includes('/participation'),
          ),
          bodyPreview: bodyText?.slice(-2000),
        }),
      );
    }
    const afterWebDay = await readDay(
      apiBaseUrl,
      mobileA.session,
      childA,
      today,
    );
    assert.equal(
      afterWebDay.items[0]!.participation?.notes.some(
        note => note.text === '网页端携带 CSRF 的真实补充',
      ),
      true,
    );
    ok('网页携带 CSRF 写入后，手机 API 读回同一事实');

    const mobileMemoryId = randomUUID();
    const memoryText = '另一位家长从手机接口留下的成长小记';
    const memoryOptions = { method: 'POST', headers: auth(mobileB.session), expected: 201 };
    await httpJson(apiBaseUrl, `/v2/children/${childA}/memories`, {
      ...memoryOptions,
      body: { operationId: randomUUID(), id: mobileMemoryId, localDate: today,
        type: 'story', text: memoryText, firstConfirmed: false, mediaIds: [] },
    });
    await httpJson(apiBaseUrl, `/v2/children/${childA}/measurements`, {
      ...memoryOptions,
      body: { operationId: randomUUID(), id: randomUUID(), localDate: today,
        kind: 'height', unit: 'cm', method: 'recumbent', source: 'home', value: 81.5 },
    });
    const image = await sharp({ create: { width: 7, height: 6, channels: 3, background: '#6D8565' } }).png().toBuffer();
    const ticket = await httpJson<{ media: { id: string }; uploadUrl: string }>(apiBaseUrl, '/v2/media/uploads', {
      ...memoryOptions,
      body: { operationId: randomUUID(), memoryId: mobileMemoryId, mime: 'image/png',
        byteSize: image.length, sha256: createHash('sha256').update(image).digest('hex') },
    });
    const uploadUrl = new URL(ticket.uploadUrl);
    const uploaded = await fetch(apiBaseUrl + uploadUrl.pathname, {
      method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array(image),
    });
    assert.equal(uploaded.status, 204);
    await httpJson(apiBaseUrl, `/v2/media/${ticket.media.id}/complete`, {
      ...memoryOptions, expected: 202, body: { operationId: randomUUID() },
    });
    let photoReady = false;
    for (let attempt = 0; attempt < 40 && !photoReady; attempt++) {
      const media = await httpJson<{ state: string }>(apiBaseUrl, `/v2/media/${ticket.media.id}`, {
        headers: auth(mobileB.session),
      });
      photoReady = media.state === 'ready';
      if (!photoReady) await new Promise(resolve => setTimeout(resolve, 75));
    }
    assert.ok(photoReady);
    await page.locator('[data-view="growth"]').click();
    await page.waitForSelector(`#growth-history article:has-text("${memoryText}")`, { timeout: 20_000 });
    await page.waitForSelector('#growth-history article:has-text("81.5 cm · 卧位身长")', { timeout: 20_000 });
    const memoryCard = `#growth-history article:has-text("${memoryText}")`;
    const [imageResponse] = await Promise.all([
      page.waitForResponse(response => response.status() === 200 &&
        new URL(response.url()).pathname === `/v2/media/${ticket.media.id}/content`, { timeout: 20_000 }),
      page.locator(`${memoryCard} button:has-text("查看照片")`).click(),
    ]);
    assert.equal(imageResponse.headers()['cache-control'], 'private, no-store');
    await page.waitForSelector(`${memoryCard} img`, { timeout: 20_000 });
    const loadedImage = await page.evaluate(async (text: string) => {
      const card = [...document.querySelectorAll('#growth-history article')]
        .find(entry => entry.textContent?.includes(text));
      const image = card?.querySelector('img');
      if (!image) return null;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight, new URL(image.src).origin === location.origin];
    }, memoryText);
    assert.deepEqual(loadedImage, [7, 6, true]);
    ok('手机接口写入小记、测量与照片后，另一账号网页读取同一资料，图片响应禁止缓存');

    await page.evaluate(() => { window.confirm = () => true; });
    await page.locator(`${memoryCard} button:has-text("删除这条误记")`).click();
    await page.waitForSelector(memoryCard, { state: 'hidden', timeout: 20_000 });
    const invalidated = await httpJson<{ code: string }>(apiBaseUrl, nextSnapshotPath, { headers: auth(mobileA.session), expected: 410 });
    assert.equal(invalidated.code, 'SNAPSHOT_EXPIRED');
    await page.locator('#growth-trash summary').click();
    const trashEntry = `#growth-trash-list article:has-text("${memoryText}")`;
    await page.waitForSelector(trashEntry, { timeout: 20_000 });
    await page.locator(`${trashEntry} button:has-text("恢复这条小记")`).click();
    await page.waitForSelector(memoryCard, { timeout: 20_000 });
    const growthAfterRestore = await httpJson<{ items: { id: string; text: string }[] }>(
      apiBaseUrl, `/v2/children/${childA}/memories`, { headers: auth(mobileB.session) },
    );
    assert.ok(growthAfterRestore.items.some(entry => entry.id === mobileMemoryId && entry.text === memoryText));
    ok('网页将小记移入最近删除并恢复，另一位家长经手机接口读回同一记录');

    const webMemory = '网页先保存的文字，照片可以单独重试';
    let blockUpload = true;
    await page.route('**/v2/media/upload-targets/*', async route => {
      if (!blockUpload) return route.continue();
      blockUpload = false;
      await route.abort();
    });
    await page.locator('#memory-text').fill(webMemory);
    await page.locator('#memory-photo').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
    await page.locator('#growth-form button:has-text("保存成长小记")').click();
    await page.waitForSelector('#growth-form .form-alert:has-text("正文已经保存")', { timeout: 20_000 });
    await page.locator('#growth-form button:has-text("重试上传这张照片")').click();
    await page.waitForSelector(`#growth-history article:has-text("${webMemory}") button:has-text("查看照片")`, { timeout: 20_000 });
    const webSaved = await httpJson<{ items: { id: string; text: string; mediaIds: string[] }[] }>(
      apiBaseUrl, `/v2/children/${childA}/memories`, { headers: auth(mobileB.session) },
    );
    const matches = webSaved.items.filter(entry => entry.text === webMemory);
    assert.equal(matches.length, 1);
    assert.ok(matches[0]!.mediaIds.length > 0);
    ok('网页照片首次传输失败后能重试，同一正文只保存一次且另一位家长可见');

    await page.locator('#export-from').fill(today);
    await page.locator('#export-to').fill(today);
    await page.locator('#export-media').click();
    await page.locator('#export-submit').click();
    const downloadLink = '#export-result a:has-text("下载家庭数据")';
    await page.waitForSelector(downloadLink, { timeout: 30_000 });
    const downloadLinkDetails = await page.evaluate(() => {
      const node = document.querySelector('#export-result a');
      if (!(node instanceof HTMLAnchorElement)) return null;
      return {
        pathname: new URL(node.href).pathname,
        download: node.getAttribute('download'),
        target: node.getAttribute('target'),
      };
    }) as { pathname: string; download: string | null; target: string | null } | null;
    assert.ok(downloadLinkDetails);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.locator(downloadLink).click(),
    ]);
    const downloadUrl = new URL(download.url());
    assert.equal(downloadUrl.origin, webBaseUrl);
    assert.equal(downloadLinkDetails.pathname, downloadUrl.pathname);
    assert.equal(downloadLinkDetails.target, null);
    assert.match(download.suggestedFilename(), /^babyplan-[a-f\d-]+\.zip$/);
    assert.equal(downloadLinkDetails.download, download.suggestedFilename());
    // 当前 Windows 自动化环境会让 Playwright 下载事件立即进入 canceled；
    // 单独用同源请求核对签名链接确实返回 ZIP，避免把浏览器磁盘下载故障误判为接口失败。
    const archiveResponse = await fetch(webBaseUrl + downloadUrl.pathname + downloadUrl.search);
    assert.equal(archiveResponse.status, 200);
    assert.match(archiveResponse.headers.get('content-type') ?? '', /^application\/zip\b/);
    assert.match(
      archiveResponse.headers.get('content-disposition') ?? '',
      /^attachment;\s*filename="babyplan-/,
    );
    const downloadedBytes = Buffer.from(await archiveResponse.arrayBuffer());
    assert.equal(downloadedBytes.subarray(0, 4).toString('hex'), '504b0304');
    assert.ok(downloadedBytes.includes(Buffer.from('manifest.json')) && downloadedBytes.includes(Buffer.from(webMemory)));
    assert.ok(downloadedBytes.includes(Buffer.from(`media/${ticket.media.id}.png`)));
    ok('网页能从同源入口下载包含成长记录的真实 ZIP 导出');
    await page.locator('[data-view="schedule"]').click();
    await page.waitForSelector(`.activity-button:has-text("${item.snapshot.title}")`, { timeout: 20_000 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: join(evidenceRoot, 'live-web-390.png'),
      fullPage: true,
    });
    await page.locator('[data-view="schedule"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.dataset.view,
      ),
      'settings',
    );
    await page.keyboard.press('Enter');
    assert.equal(
      await page.locator('#view-settings').isVisible(),
      true,
    );
    ok('网页主导航可用键盘聚焦并切换页面');

    await page.setViewportSize({ width: 360, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowElements: [...document.querySelectorAll('body *')]
        .map(node => {
          const rect = node.getBoundingClientRect();
          return {
            tag: node.tagName.toLowerCase(),
            id: node.id,
            className: typeof node.className === 'string' ? node.className : '',
            text: node.textContent?.trim().slice(0, 80) ?? '',
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          };
        })
        .filter(item =>
          item.right > window.innerWidth + 2 ||
          item.left < -2 ||
          item.scrollWidth > item.clientWidth + 2
        )
        .slice(0, 30),
    })) as {
      viewport: number;
      scrollWidth: number;
      bodyScrollWidth: number;
      overflowElements: unknown[];
    };
    if (
      layout.scrollWidth > layout.viewport + 2 ||
      layout.bodyScrollWidth > layout.viewport + 2
    ) {
      await page.screenshot({
        path: join(evidenceRoot, 'live-web-360-200percent-failure.png'),
        fullPage: true,
      });
    }
    assert.ok(
      layout.scrollWidth <= layout.viewport + 2
      && layout.bodyScrollWidth <= layout.viewport + 2,
      JSON.stringify(layout),
    );
    await page.screenshot({
      path: join(evidenceRoot, 'live-web-360-200percent.png'),
      fullPage: true,
    });
    ok('360px 宽与 200% 根字号没有页面横向溢出');
    await page.locator('[data-view="schedule"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#view-schedule').isVisible(), true);
    const scheduleLayout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    })) as { viewport: number; scrollWidth: number; bodyScrollWidth: number };
    assert.ok(
      scheduleLayout.scrollWidth <= scheduleLayout.viewport + 2
      && scheduleLayout.bodyScrollWidth <= scheduleLayout.viewport + 2,
      JSON.stringify(scheduleLayout),
    );
    await page.screenshot({
      path: join(evidenceRoot, 'live-web-360-200percent-schedule.png'),
      fullPage: true,
    });
    ok('360px 宽与 200% 根字号下陪伴安排页也无页面横向溢出');
    const skipLinkState = await page.evaluate(() => {
      const node = document.querySelector('.skip-link');
      const rect = node?.getBoundingClientRect();
      return {
        active: document.activeElement === node,
        top: rect?.top ?? null,
        bottom: rect?.bottom ?? null,
      };
    }) as { active: boolean; top: number | null; bottom: number | null };
    assert.ok(
      skipLinkState.active ||
      (skipLinkState.bottom !== null && skipLinkState.bottom <= 0),
      JSON.stringify(skipLinkState),
    );
    await pool.query(`
      UPDATE app.activity_revisions SET withdrawn_at=now()
      WHERE id=(SELECT activity_revision_id FROM app.plan_items WHERE id=$1)
    `, [item.id]);
    await page.locator(`.activity-button:has-text("${item.snapshot.title}")`).click();
    await page.waitForSelector('#detail-panel .status-badge.blocked', { timeout: 20_000 });
    assert.equal(await page.locator('#detail-panel .numbered-list').count(), 0);
    assert.equal(await page.locator('#participation-note').count(), 0);
    assert.match(await page.locator('#detail-panel').textContent() || '', /网页端携带 CSRF 的真实补充/);
    await page.evaluate(() => { window.print = () => {}; });
    await page.locator('#week-mode-button').click();
    await page.locator('#print-button').click();
    const printed = `#print-root .print-activity:has-text("${item.snapshot.title}") >> nth=0`;
    await page.waitForSelector(printed, { state: 'attached', timeout: 20_000 });
    assert.equal(await page.locator(`${printed} .numbered-list`).count(), 0);
    assert.match((await page.locator(printed).textContent()) ?? '', /停止推荐/);
    await httpJson(apiBaseUrl, downloadUrl.pathname + downloadUrl.search, { expected: 404 });
    const renewedExport = await httpJson<{ id: string }>(apiBaseUrl, `/v2/families/${familyA.id}/exports`, {
      method: 'POST', headers: auth(mobileA.session), expected: 202,
      body: { operationId: randomUUID(), from: today, to: today, types: ['plans'], includeMedia: false },
    });
    let newDownload: string | null = null;
    for (let attempt = 0; attempt < 30 && !newDownload; attempt++) {
      const current = await httpJson<{ downloadUrl: string | null }>(apiBaseUrl, `/v2/exports/${renewedExport.id}`, {
        headers: auth(mobileA.session),
      });
      newDownload = current.downloadUrl;
      if (!newDownload) await new Promise(resolve => setTimeout(resolve, 75));
    }
    assert.ok(newDownload);
    const safeUrl = new URL(newDownload);
    const safeArchive = await fetch(apiBaseUrl + safeUrl.pathname + safeUrl.search);
    assert.equal(safeArchive.status, 200);
    const safeBytes = Buffer.from(await safeArchive.arrayBuffer());
    const firstNameSize = safeBytes.readUInt16LE(26);
    assert.equal(safeBytes.toString('utf8', 30, 30 + firstNameSize), 'manifest.json');
    const firstEntry = 30 + firstNameSize + safeBytes.readUInt16LE(28);
    const newManifest = JSON.parse(safeBytes.toString('utf8', firstEntry, firstEntry + safeBytes.readUInt32LE(18))) as {
      plans: { items: { id: string; snapshot: { withdrawn?: boolean; steps: string[] } }[] };
    };
    const safeItem = newManifest.plans.items.find(candidate => candidate.id === item.id);
    assert.ok(safeItem?.snapshot.withdrawn);
    assert.match(safeItem.snapshot.steps.join(''), /停止推荐/);
    ok('网页重新打开及打印已撤回活动时不展示原步骤，原参与备注仍保留');
    ok('内容撤回使旧计划导出失效，重新导出的记录保留撤回提示而不显示原步骤');
    const caregiverSnapshot = await httpJson<SnapshotPage>(apiBaseUrl, `${snapshotPath}?limit=1`, { headers: auth(mobileB.session) });
    assert.ok(caregiverSnapshot.nextPageToken);
    await httpJson(apiBaseUrl, `/v2/families/${familyA.id}/members/${ownerB.id}`, {
      method: 'DELETE', headers: auth(mobileA.session), body: { operationId: randomUUID() },
    });
    await httpJson(apiBaseUrl, `${snapshotPath}?pageToken=${caregiverSnapshot.nextPageToken}`, {
      headers: auth(mobileB.session), expected: 404,
    });
    ok('撤权后，即使持有本人尚未过期的下一页令牌，也无法读取家庭快照');
    assert.deepEqual(pageErrors, []);
    ok('真实网页运行期间无 JavaScript 页面异常');

    const screenshotHashes: Record<string, string> = {};
    for (const name of [
      'live-web-390.png',
      'live-web-360-200percent.png',
      'live-web-360-200percent-schedule.png',
    ]) {
      screenshotHashes[name] = createHash('sha256')
        .update(await readFile(join(evidenceRoot, name)))
        .digest('hex');
    }
    await writeFile(
      join(evidenceRoot, 'report.json'),
      JSON.stringify(
        {
          checkedOn: new Date().toISOString(),
          checks,
          pageErrors,
          consoleErrors,
          screenshots: screenshotHashes,
          boundaries: [
            '开发测试内容通过数据库夹具标为 reviewed，不修改候选文件，也不代表人工审读。',
            '真实 Android 设备安装、通知、系统选图、省电和重启尚未验证。',
            '两台真实手机及公网 TLS 部署尚未验证。',
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    await context.close();
  } finally {
    await browser?.close();
    if (webServer) {
      await new Promise<void>(resolve => {
        webServer!.close(() => resolve());
      });
    }
    await app?.close();
    await cleanup(pool, familyIds, userIds, releaseId, previousReleaseId);
    await pool.end();
    await rm(workRoot, { recursive: true, force: true });
  }
});
