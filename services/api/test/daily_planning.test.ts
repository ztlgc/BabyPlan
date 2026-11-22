import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { importContentPackage, publishContentRelease, readContentPackage } from '../src/content/package.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { createFamily } from '../src/families/service.js';
import { ensureSevenDays, setDayMode } from '../src/plans/service.js';

test('真实数据库每日排课：月龄起点、七天顺序、轻松模式、保护、材料和两岁边界', async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://babyplan:x@127.0.0.1:54329/babyplan_dev';
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent', CONTENT_ENVIRONMENT: 'development' });
  const pool = createPool(config);
  const app = buildApp(config, pool);
  const families: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  let userId: string | undefined;
  let releaseId: string | undefined;
  const deviceId = randomUUID();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const identity = (familyId: string) => ({ familyId, actorUserId: userId!, operationId: randomUUID(), deviceId });
  try {
    await migrate(pool);
    const content = await readContentPackage(fileURLToPath(new URL('../../../content/candidate/babyplan-daily-12-24-v1.json', import.meta.url)));
    content.packageId = `bp-test-daily-${suffix}`;
    const rename = (id: string) => `${id}-${suffix}`;
    for (const card of content.cards) card.id = rename(card.id);
    for (const day of [...content.week.days, ...content.dailyPlans!.days]) {
      for (const item of day.items) item.cardId = rename(item.cardId);
    }
    for (const guide of content.stageGuides as Array<{ focuses: Array<{ cardIds: string[] }> }>) {
      for (const focus of guide.focuses) focus.cardIds = focus.cardIds.map(rename);
    }
    const imported = await importContentPackage(pool, content, 'development', null);
    releaseId = imported.releaseId;
    await publishContentRelease(pool, releaseId);
    userId = await createUser(pool, {
      email: `daily-${suffix}@example.test`, displayName: '课程隔离验证', password: 'daily-plan-test-only', deploymentAdmin: true, contentRoles: [],
    });
    for (const [months, first] of [[12, 1], [15, 92], [18, 183], [21, 274]] as const) {
      const family = await createFamily(pool, userId, {
        operationId: randomUUID(), deviceId, name: '课程隔离验证', timezone: 'Asia/Shanghai',
        child: { displayName: '课程隔离验证', ageMode: 'months', ageMonths: months, ageAsOf: today, birthDate: null },
      });
      families.push(family.id);
      const childId = (await pool.query<{ id: string }>('SELECT id FROM app.children WHERE family_id=$1', [family.id])).rows[0]!.id;
      const plans = await ensureSevenDays(pool, 'development', identity(family.id), childId);
      assert.equal(plans.days.length, 7);
      for (const [index, day] of plans.days.entries()) {
        assert.equal(day.items.length, 1);
        assert.equal(day.items[0]!.snapshot.id, rename(['bp', 'daily', String(first + index).padStart(3, '0')].join('-')));
        assert.equal(day.effectiveBudgetMinutes, 5);
        assert.deepEqual(day.missingSlots, []);
      }
      // 第 7 天复玩属于 child-led，轻松模式仍须显示这唯一的一项。
      const replayDay = plans.days.find(day => day.items[0]!.kind === 'child-led')!;
      assert.ok(replayDay);
      const lite = await setDayMode(pool, userId, deviceId, replayDay.id, {
        operationId: randomUUID(), baseRevision: replayDay.revision, mode: 'lite',
      });
      assert.equal(lite.items[0]!.visibility, 'active');
      assert.equal(lite.effectiveBudgetMinutes, 5);
      if (months === 18) {
        const protectedDay = plans.days[1]!;
        await pool.query('UPDATE app.plan_items SET locked_by_parent=true WHERE id=$1', [protectedDay.items[0]!.id]);
        await pool.query('UPDATE app.family_preferences SET excluded_materials=$2 WHERE family_id=$1', [
          family.id, JSON.stringify(content.cards.find(card => card.id === plans.days[2]!.items[0]!.snapshot.id)!.materials),
        ]);
        const changed = await ensureSevenDays(pool, 'development', identity(family.id), childId);
        assert.equal(changed.days[0]!.items[0]!.id, plans.days[0]!.items[0]!.id);
        assert.equal(changed.days[1]!.items[0]!.id, protectedDay.items[0]!.id);
        assert.deepEqual(changed.days[1]!.items[0]!.snapshot, protectedDay.items[0]!.snapshot);
        assert.equal(changed.days[2]!.items.length, 0);
        assert.equal(changed.days[2]!.missingSlots.length, 1);
      }
    }
    const birth = new Date(`${today}T00:00:00Z`);
    birth.setUTCFullYear(birth.getUTCFullYear() - 2);
    birth.setUTCDate(birth.getUTCDate() + 1);
    const family = await createFamily(pool, userId, {
      operationId: randomUUID(), deviceId, name: '两岁边界隔离验证', timezone: 'Asia/Shanghai',
      child: { displayName: null, ageMode: 'birthDate', ageMonths: null, ageAsOf: null, birthDate: birth.toISOString().slice(0, 10) },
    });
    families.push(family.id);
    const childId = (await pool.query<{ id: string }>('SELECT id FROM app.children WHERE family_id=$1', [family.id])).rows[0]!.id;
    const boundary = await ensureSevenDays(pool, 'development', identity(family.id), childId);
    assert.equal(boundary.days[0]!.items[0]!.snapshot.id, rename(['bp', 'daily', '365'].join('-')));
    assert.ok(!boundary.days[1]!.generationVersion.startsWith('v2.daily:'));
    const email = `daily-${suffix}@example.test`;
    const login = await app.inject({ method: 'POST', url: '/v2/sessions', payload: { email, password: 'daily-plan-test-only', clientType: 'mobile', deviceId } });
    assert.equal(login.statusCode, 200);
    const response = await app.inject({
      method: 'POST', url: `/v2/children/${childId}/plans/ensure`,
      headers: { authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}` },
      payload: { operationId: randomUUID() },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json<{ days: Array<{ items: Array<{ snapshot: { steps: string[] } }> }> }>().days[0]!.items[0]!.snapshot.steps[0]);
  } finally {
    await app.close();
    if (families.length) {
      for (const table of ['play_sessions', 'participations', 'plan_items', 'day_plans', 'operations', 'changes', 'family_preferences', 'family_members', 'children', 'family_clocks']) {
        await pool.query(`DELETE FROM app.${table} WHERE family_id=ANY($1::uuid[])`, [families]);
      }
      await pool.query('DELETE FROM app.families WHERE id=ANY($1::uuid[])', [families]);
    }
    if (userId) {
      for (const table of ['sessions', 'deployment_admins']) await pool.query(`DELETE FROM app.${table} WHERE user_id=$1`, [userId]);
      await pool.query('DELETE FROM app.users WHERE id=$1', [userId]);
    }
    if (releaseId) {
      await pool.query('DELETE FROM app.content_release_revisions WHERE release_id=$1', [releaseId]);
      await pool.query('DELETE FROM app.content_releases WHERE id=$1', [releaseId]);
      await pool.query('DELETE FROM app.activity_revisions WHERE package_id=$1', [`bp-test-daily-${suffix}`]);
    }
    await pool.end();
  }
});
