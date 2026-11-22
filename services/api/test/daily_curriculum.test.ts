import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readContentPackage } from '../src/content/package.js';
import { ageBandAtDate, curriculumDayAtDate } from '../src/plans/eligibility.js';

const packagePath = new URL('../../../content/candidate/babyplan-daily-12-24-v1.json', import.meta.url);

test('365 天课程完整保留原稿顺序、适龄来源和原有后续活动', async () => {
  const content = await readContentPackage(fileURLToPath(packagePath));
  assert.equal(content.cards.length, 389);
  assert.equal(content.dailyPlans!.days.length, 365);
  assert.deepEqual(content.dailyPlans!.days.map(day => day.day), Array.from({ length: 365 }, (_, index) => index + 1));
  assert.ok(content.cards.find(card => card.id === 'bp-daily-183')!.title.includes('大球轮到你'));
  assert.ok(content.cards.find(card => card.id === 'bp-daily-365'));
  const original = await readContentPackage(fileURLToPath(new URL('../../../content/candidate/babyplan-18-23-v2.json', import.meta.url)));
  assert.deepEqual(content.cards.slice(0, 24).map(card => card.id), original.cards.map(card => card.id));
  assert.deepEqual(content.week, original.week);
  assert.equal(content.review.expert, 'not_reviewed');
  assert.equal(content.review.familyTrial, 'not_started');
  assert.ok(content.cards.filter(card => card.id.startsWith('bp-daily-')).every(card => card.reviewState === 'draft'));
});

test('出生日期按一岁生日连续安排，覆盖月末、闰年和满两岁边界', () => {
  const child = { age_mode: 'birthDate', birth_date: '2024-11-14' };
  assert.equal(curriculumDayAtDate(child, '2025-11-13'), null);
  assert.equal(curriculumDayAtDate(child, '2025-11-14'), 1);
  assert.equal(curriculumDayAtDate(child, '2026-11-13'), 365);
  assert.equal(curriculumDayAtDate(child, '2026-11-14'), null);
  const leap = { age_mode: 'birthDate', birth_date: '2022-02-28' };
  assert.equal(curriculumDayAtDate(leap, '2024-02-27'), 365);
  const leapBirthday = { age_mode: 'birthDate', birth_date: '2024-02-29' };
  assert.equal(curriculumDayAtDate(leapBirthday, '2025-02-28'), 1);
  assert.equal(curriculumDayAtDate(leapBirthday, '2026-02-27'), 365);
  assert.equal(curriculumDayAtDate(leapBirthday, '2026-02-28'), null);
});

test('仅记录月龄时从对应阶段开始，跨天递进，不要求补课', () => {
  for (const [months, day, band] of [[12, 1, 'm12_14'], [15, 92, 'm15_17'], [18, 183, 'm18_23'], [21, 274, 'm18_23']] as const) {
    const child = { age_mode: 'months', age_months: months, age_as_of: '2026-11-14' };
    assert.equal(curriculumDayAtDate(child, '2026-11-14'), day);
    assert.equal(curriculumDayAtDate(child, '2026-11-15'), day + 1);
    assert.equal(ageBandAtDate(child, '2026-11-14'), band);
  }
  assert.equal(ageBandAtDate({ age_mode: 'months', age_months: 24, age_as_of: '2026-11-14' }, '2026-11-14'), 'm24_29');
  assert.equal(curriculumDayAtDate({ age_mode: 'months', age_months: 24, age_as_of: '2026-11-14' }, '2026-11-14'), null);
});

test('每日计划的缺天、重复、错误月龄和引用不能通过导入', async () => {
  const content = await readContentPackage(fileURLToPath(packagePath));
  const directory = await mkdtemp(join(tmpdir(), 'babyplan-curriculum-'));
  const path = join(directory, 'invalid.json');
  try {
    for (const mutate of [
      (value: typeof content) => { value.dailyPlans!.days.pop(); },
      (value: typeof content) => { value.dailyPlans!.days[1]!.day = 1; },
      (value: typeof content) => { value.dailyPlans!.days[0]!.items[0]!.cardId = 'unknown'; },
      (value: typeof content) => { value.cards.find(card => card.id === 'bp-daily-001')!.ageBands = ['m36']; },
      (value: typeof content) => { value.dailyPlans!.days[0]!.items[0]!.minutes = 30; },
    ]) {
      const invalid = structuredClone(content);
      mutate(invalid);
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(readContentPackage(path));
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
