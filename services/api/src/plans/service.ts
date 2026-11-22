import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError, notFound } from '../errors.js';
import type { ContentCard, ContentPackage } from '../content/package.js';
import { listContentWithdrawals } from '../content/workflow.js';
import type { AppConfig } from '../config.js';
import { withFamilySnapshot, withFamilyWrite } from '../db/transactions.js';
import { childFamilyId, getFamily, mapChild, type ChildDto } from '../families/repository.js';
import { ageBandAtDate, curriculumDayAtDate, languageMatches, materialsMatch } from './eligibility.js';
import {
  listFamilyBooks,
  listFamilyMeasurements,
  listFamilyMedia,
  listFamilyMemories,
  listFamilyObservations,
} from '../growth/repository.js';

const kinds: ContentCard['kind'][] = ['movement', 'explore', 'reading', 'english', 'child-led', 'calm'];
const blockByKind = { movement: 'before', explore: 'before', reading: 'after', english: 'after',
  'child-led': 'after', calm: 'bedtime' } as const;
const minutesByKind = { movement: 15, explore: 10, reading: 10, english: 10, 'child-led': 5, calm: 10 };
const liteKinds = new Set<ContentCard['kind']>(['movement', 'explore', 'reading', 'english']);

function databaseDate(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export type ParticipationDto = {
  id: string;
  planItemId: string;
  status: 'played' | 'skipped';
  participantIds: string[];
  notes: Array<{ authorId: string; text: string }>;
  actualMinutes: number | null;
  again: boolean;
  addedBy: string;
  revision: number;
};

export type PlanItemDto = {
  id: string;
  dayPlanId: string;
  kind: ContentCard['kind'];
  block: 'before' | 'after' | 'bedtime';
  position: number;
  budgetMinutes: number;
  snapshot: ContentCard;
  lockedByParent: boolean;
  startedAt: string | null;
  revision: number;
  reasonCodes: string[];
  blockedByWithdrawal: boolean;
  withdrawalReason?: string;
  participation: ParticipationDto | null;
  visibility: 'active' | 'hidden';
};

export type DayPlanDto = {
  id: string;
  familyId: string;
  childId: string;
  localDate: string;
  timezone: string;
  mode: 'standard' | 'lite';
  generationVersion: string;
  revision: number;
  items: PlanItemDto[];
  missingSlots: ContentCard['kind'][];
  effectiveBudgetMinutes: number;
};

type ParticipationRow = {
  id: string;
  plan_item_id: string;
  status: 'played' | 'skipped';
  participant_ids: string[];
  notes: Array<{ authorId: string; text: string }>;
  actual_minutes: number | string | null;
  again: boolean;
  added_by: string;
  revision: number | string;
};

export function mapParticipation(row: ParticipationRow): ParticipationDto {
  return {
    id: row.id,
    planItemId: row.plan_item_id,
    status: row.status,
    participantIds: row.participant_ids,
    notes: row.notes,
    actualMinutes: row.actual_minutes === null ? null : Number(row.actual_minutes),
    again: row.again,
    addedBy: row.added_by,
    revision: Number(row.revision),
  };
}

function localDateParts(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function loadDayPlan(client: PoolClient, childId: string, localDate: string): Promise<DayPlanDto | null> {
  const day = await client.query<DayPlanRow>(`
    SELECT * FROM app.day_plans WHERE child_id=$1 AND local_date=$2
  `, [childId, localDate]);
  return (await loadDayPlans(client, day.rows))[0] ?? null;
}

type DayPlanRow = {
  id: string; family_id: string; child_id: string; local_date: Date | string;
  timezone: string; mode: DayPlanDto['mode']; generation_version: string; revision: string | number;
  planned_kinds: ContentCard['kind'][];
};

async function loadDayPlans(client: PoolClient, plans: DayPlanRow[]): Promise<DayPlanDto[]> {
  if (!plans.length) return [];
  const items = await client.query(`
    SELECT pi.id,pi.day_plan_id,pi.kind,pi.block,pi.position,pi.budget_minutes,
           pi.snapshot,pi.locked_by_parent,pi.started_at,pi.revision,pi.visibility,
           ar.withdrawn_at,w.withdrawal_reason,
           p.id AS p_id,p.plan_item_id AS p_plan_item_id,p.status AS p_status,
           p.participant_ids AS p_participant_ids,p.notes AS p_notes,
           p.actual_minutes AS p_actual_minutes,p.again AS p_again,
           p.added_by AS p_added_by,p.revision AS p_revision
    FROM app.plan_items pi
    LEFT JOIN app.activity_revisions ar ON ar.id=pi.activity_revision_id
    LEFT JOIN LATERAL (
      SELECT cr.withdrawal_reason
      FROM app.content_release_revisions rr JOIN app.content_releases cr ON cr.id=rr.release_id
      WHERE rr.activity_revision_id=ar.id AND cr.status='withdrawn'
      ORDER BY cr.withdrawn_at DESC LIMIT 1
    ) w ON ar.withdrawn_at IS NOT NULL
    LEFT JOIN app.participations p
      ON p.plan_item_id=pi.id AND p.family_id=pi.family_id AND p.deleted_at IS NULL
    WHERE pi.day_plan_id=ANY($1::uuid[])
    ORDER BY pi.day_plan_id,pi.position
  `, [plans.map(plan => plan.id)]);
  const byDay = new Map<string, PlanItemDto[]>();
  for (const row of items.rows) {
    const participation = row.p_id ? mapParticipation({
      id: row.p_id,
      plan_item_id: row.p_plan_item_id,
      status: row.p_status,
      participant_ids: row.p_participant_ids,
      notes: row.p_notes,
      actual_minutes: row.p_actual_minutes,
      again: row.p_again,
      added_by: row.p_added_by,
      revision: row.p_revision,
    }) : null;
    const item: PlanItemDto = {
      id: row.id,
      dayPlanId: row.day_plan_id,
      kind: row.kind,
      block: row.block,
      position: Number(row.position),
      budgetMinutes: Number(row.budget_minutes),
      snapshot: row.withdrawn_at ? blockedActivity(row.snapshot) : row.snapshot,
      lockedByParent: row.locked_by_parent,
      startedAt: row.started_at?.toISOString() ?? null,
      revision: Number(row.revision),
      reasonCodes: ['AGE_MATCH'],
      blockedByWithdrawal: row.withdrawn_at !== null,
      ...(row.withdrawn_at ? { withdrawalReason: row.withdrawal_reason ?? '这项玩法已停止推荐。' } : {}),
      participation,
      visibility: row.visibility,
    };
    const existing = byDay.get(item.dayPlanId);
    if (existing) existing.push(item);
    else byDay.set(item.dayPlanId, [item]);
  }
  return plans.map(plan => {
    const mappedItems = byDay.get(plan.id) ?? [];
    const visibleKinds = new Set(mappedItems.filter(item => item.visibility === 'active').map(item => item.kind));
    return {
      id: plan.id,
      familyId: plan.family_id,
      childId: plan.child_id,
      localDate: databaseDate(plan.local_date),
      timezone: plan.timezone,
      mode: plan.mode,
      generationVersion: plan.generation_version,
      revision: Number(plan.revision),
      items: mappedItems,
      missingSlots: plan.planned_kinds.filter(kind => !visibleKinds.has(kind)),
      effectiveBudgetMinutes: mappedItems
        .filter(item => item.visibility === 'active')
        .reduce((total, item) => total + item.budgetMinutes, 0),
    };
  });
}

export function blockedActivity(activity: ContentCard): ContentCard {
  const notice = '这项玩法已停止推荐，原步骤不再展示。';
  return {
    ...activity, withdrawn: true, support: notice, materials: [], steps: [notice],
    dialogue: { opening: notice, engaged: notice, observing: notice, stopping: notice },
    english: { phrase: notice, meaning: notice, when: notice },
    safety: notice, easier: notice, next: notice,
  };
}

function redactChangedPlan(body: unknown, withdrawals: ReadonlyMap<string, string>): unknown {
  if (!body || typeof body !== 'object') return body;
  const value = body as { snapshot?: ContentCard; items?: unknown[] };
  if (Array.isArray(value.items)) return { ...value, items: value.items.map(item => redactChangedPlan(item, withdrawals)) };
  const activity = value.snapshot;
  if (!activity) return body;
  const reason = withdrawals.get(`${activity.id}:${activity.revision}`);
  return reason ? { ...value, blockedByWithdrawal: true, withdrawalReason: reason, snapshot: blockedActivity(activity) } : body;
}

async function scrubPlanResult<T extends PlanItemDto | DayPlanDto>(pool: Pool, body: T, replayed: boolean): Promise<T> {
  if (!replayed) return body;
  const reasons = new Map((await listContentWithdrawals(pool)).map(entry => [`${entry.activityId}:${entry.revision}`, entry.reason]));
  return redactChangedPlan(body, reasons) as T;
}

export async function ensureSevenDays(
  pool: Pool,
  contentEnvironment: AppConfig['contentEnvironment'],
  identity: { familyId: string; actorUserId: string; operationId: string; deviceId: string },
  childId: string,
): Promise<{ days: DayPlanDto[] }> {
  const result = await withFamilyWrite<{ days: DayPlanDto[] }>(pool, {
    ...identity,
    action: 'plans.ensure',
    request: { childId },
  }, async ({ client, familyId, appendChange }) => {
    const child = await client.query(`
      SELECT c.*,f.timezone AS family_timezone
      FROM app.children c
      JOIN app.families f ON f.id=c.family_id
      WHERE c.id=$1 AND c.family_id=$2 AND c.deleted_at IS NULL
    `, [childId, familyId]);
    if (!child.rows[0]) throw notFound();
    const release = await client.query<{ id: string; package_snapshot: ContentPackage }>(`
      SELECT id,package_snapshot
      FROM app.content_releases
      WHERE environment=$1 AND status='published' AND active AND package_snapshot IS NOT NULL
      ORDER BY version DESC LIMIT 1
    `, [contentEnvironment]);
    const row = release.rows[0];
    if (!row) throw new AppError(422, 'CONTENT_NOT_PUBLISHED', '当前环境尚无可用内容');
    const revisions = await client.query<{ activity_id: string; revision_id: string; content: ContentCard }>(`
      SELECT ar.activity_id,ar.id AS revision_id,
             ar.content || jsonb_build_object('reviewState',ar.review_state) AS content
      FROM app.content_release_revisions rr
      JOIN app.activity_revisions ar ON ar.id=rr.activity_revision_id
      WHERE rr.release_id=$1 AND ar.withdrawn_at IS NULL
        AND ($2='development' OR (ar.review_state='reviewed' AND NOT ar.test_fixture))
      ORDER BY ar.activity_id,ar.revision DESC
    `, [row.id, contentEnvironment]);
    const candidates = revisions.rows.filter((entry, index, entries) =>
      !entry.content.withdrawn && (index === 0 || entries[index - 1]!.activity_id !== entry.activity_id));
    const content = row.package_snapshot;
    const templates = [...content.week.days].sort((left, right) => left.day - right.day);
    if (!templates.length) throw new AppError(422, 'CONTENT_WEEK_MISSING', '内容包没有周计划');
    const today = localDateParts(child.rows[0].family_timezone);
    const preferences = await loadPreferences(client, familyId);
    const available = new Set(preferences.availableMaterials);
    const excluded = new Set(preferences.excludedMaterials);
    const seen = await client.query<{ date: string; activity_id: string; again: boolean }>(`
      SELECT dp.local_date::text AS date,ar.activity_id,COALESCE(p.again AND p.status='played',false) AS again
      FROM app.day_plans dp JOIN app.plan_items pi ON pi.day_plan_id=dp.id AND pi.visibility='active'
      JOIN app.activity_revisions ar ON ar.id=pi.activity_revision_id
      LEFT JOIN app.participations p ON p.plan_item_id=pi.id AND p.deleted_at IS NULL
      WHERE dp.child_id=$1 AND dp.local_date BETWEEN $2 AND $3
    `, [childId, addUtcDays(today, -7), addUtcDays(today, 6)]);
    const favorites = new Set(seen.rows.filter(entry => entry.again).map(entry => entry.activity_id));
    const touchedDays: string[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addUtcDays(today, offset);
      const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
      const template = templates.find(entry => entry.day === dayOfWeek) ?? templates[0]!;
      const ageBand = ageBandAtDate(child.rows[0], date);
      const ordinal = curriculumDayAtDate(child.rows[0], date);
      const dailyPlan = ordinal === null ? undefined : content.dailyPlans?.days[ordinal - 1];
      const plannedKinds = dailyPlan ? dailyPlan.items.map(item => item.kind) : kinds;
      const generationVersion = `${dailyPlan ? 'v2.daily' : 'v2.1'}:${content.contentVersion}:${createHash('sha256').update(JSON.stringify([
        row.id, ageBand, dailyPlan?.day, preferences.languageMode, [...available].sort(), [...excluded].sort(),
      ])).digest('hex').slice(0, 16)}`;
      const prepared = await client.query<{ id: string; mode: 'lite' | 'standard' }>(`
        INSERT INTO app.day_plans(
          id,family_id,child_id,local_date,timezone,mode,generation_version,planned_kinds
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$9)
        ON CONFLICT(child_id,local_date) DO UPDATE
        SET generation_version=EXCLUDED.generation_version,planned_kinds=EXCLUDED.planned_kinds,
            revision=app.day_plans.revision+1,updated_at=now()
        WHERE app.day_plans.generation_version<>EXCLUDED.generation_version
          AND ($8 OR NOT EXISTS (SELECT 1 FROM app.plan_items pi WHERE pi.day_plan_id=app.day_plans.id))
          AND NOT EXISTS (
            SELECT 1 FROM app.plan_items pi WHERE pi.day_plan_id=app.day_plans.id AND (
              pi.locked_by_parent OR pi.started_at IS NOT NULL OR
              EXISTS (SELECT 1 FROM app.participations p WHERE p.plan_item_id=pi.id) OR
              EXISTS (SELECT 1 FROM app.play_sessions ps WHERE ps.plan_item_id=pi.id)
            )
          )
        RETURNING id,mode
      `, [
        randomUUID(),
        familyId,
        childId,
        date,
        child.rows[0].family_timezone,
        content.week.mode,
        generationVersion,
        date > today,
        JSON.stringify(plannedKinds),
      ]);
      const day = prepared.rows[0];
      if (!day) continue;
      // 只重排未受保护的未来日期；已有日期保留标识与家长选过的模式。
      await client.query('DELETE FROM app.plan_items WHERE day_plan_id=$1', [day.id]);
      seen.rows = seen.rows.filter(entry => entry.date !== date);
      const priorWeek = seen.rows.filter(entry => entry.date < date && entry.date >= addUtcDays(date, -7));
      const used = new Set(priorWeek.map(entry => entry.activity_id));
      const yesterday = new Set(priorWeek.filter(entry => entry.date === addUtcDays(date, -1)).map(entry => entry.activity_id));
      for (const [position, kind] of plannedKinds.entries()) {
        if (!ageBand || !languageMatches(kind, preferences.languageMode)) continue;
        const dailyItem = dailyPlan?.items[position];
        const templateId = template.items.find(item => item.kind === kind)?.cardId;
        // 每日课程按顺序选定，不以活动池评分打乱；材料不适合时如实保留缺项。
        const scored = candidates.filter(({ content: card }) => card.kind === kind &&
          (dailyItem ? card.id === dailyItem.cardId : card.ageBands.includes(ageBand)) &&
          materialsMatch(card.materials, available, excluded)).map(revision => ({
          revision,
          score: (revision.content.materials.length && available.size ? 4 : 0) +
            (favorites.has(revision.activity_id) ? 3 : 0) + (used.has(revision.activity_id) ? 0 : 2) +
            (revision.activity_id === templateId ? 1 : 0) - (yesterday.has(revision.activity_id) ? 2 : 0),
          tie: createHash('sha256').update(`${childId}/${date}/${kind}/${generationVersion}/${revision.activity_id}`).digest('hex'),
        })).sort((left, right) => right.score - left.score || left.tie.localeCompare(right.tie));
        const revision = scored[0]?.revision;
        if (!revision) continue;
        const lite = day.mode === 'lite';
        const visible = Boolean(dailyItem) || !lite || liteKinds.has(kind);
        const baseBudget = dailyItem?.minutes ?? minutesByKind[kind];
        const budget = lite && visible ? Math.min(5, baseBudget) : baseBudget;
        await client.query(`
          INSERT INTO app.plan_items(
            id,day_plan_id,family_id,child_id,position,kind,block,budget_minutes,
            base_budget_minutes,
            activity_revision_id,snapshot,visibility
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [
          randomUUID(),
          day.id,
          familyId,
          childId,
          position,
          kind,
          dailyItem?.block ?? blockByKind[kind],
          budget,
          baseBudget,
          revision.revision_id,
          JSON.stringify(revision.content),
          visible ? 'active' : 'hidden',
        ]);
        if (visible) seen.rows.push({ date, activity_id: revision.activity_id, again: false });
      }
      touchedDays.push(date);
    }
    const resultRows = await client.query<DayPlanRow>(`
      SELECT * FROM app.day_plans WHERE child_id=$1 AND local_date BETWEEN $2 AND $3 ORDER BY local_date
    `, [childId, today, addUtcDays(today, 6)]);
    const days = await loadDayPlans(client, resultRows.rows);
    for (const day of days) {
      if (touchedDays.includes(day.localDate)) {
        await appendChange({
          entity: 'day_plan',
          id: day.id,
          revision: day.revision,
          deleted: false,
          payload: day,
        });
      }
    }
    return { statusCode: 200, body: { days } };
  });
  if (!result.replayed) return result.body;
  const withdrawals = await listContentWithdrawals(pool);
  const reasons = new Map(withdrawals.map(entry => [`${entry.activityId}:${entry.revision}`, entry.reason]));
  return { days: result.body.days.map(day => redactChangedPlan(day, reasons) as DayPlanDto) };
}

export async function getDay(
  pool: Pool,
  actorUserId: string,
  childId: string,
  localDate: string,
): Promise<DayPlanDto | null> {
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const result = await withFamilySnapshot(pool, { familyId, actorUserId }, client => loadDayPlan(client, childId, localDate));
  return result.data;
}

async function loadPlanItem(
  client: PoolClient,
  familyId: string,
  childId: string,
  itemId: string,
): Promise<PlanItemDto> {
  const item = await client.query<{ local_date: string | Date }>(
    `SELECT dp.local_date
     FROM app.plan_items pi
     JOIN app.day_plans dp ON dp.id=pi.day_plan_id AND dp.family_id=pi.family_id
     WHERE pi.id=$1 AND pi.family_id=$2 AND pi.child_id=$3`,
    [itemId, familyId, childId],
  );
  if (!item.rows[0]) throw notFound();
  const day = await loadDayPlan(client, childId, databaseDate(item.rows[0].local_date));
  const result = day?.items.find(candidate => candidate.id === itemId);
  if (!result) throw notFound();
  return result;
}

export async function setDayMode(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  dayId: string,
  input: {
    operationId: string;
    baseRevision: number;
    mode: 'standard' | 'lite';
  },
): Promise<DayPlanDto> {
  const dayLookup = await pool.query<{
    family_id: string;
    child_id: string;
    local_date: string | Date;
    generation_version: string;
  }>(`
    SELECT dp.family_id,dp.child_id,dp.local_date,dp.generation_version
    FROM app.day_plans dp
    JOIN app.family_members fm
      ON fm.family_id=dp.family_id AND fm.user_id=$2 AND fm.active
    JOIN app.families f ON f.id=dp.family_id AND f.deleted_at IS NULL
    WHERE dp.id=$1
  `, [dayId, actorUserId]);
  const day = dayLookup.rows[0];
  if (!day) throw notFound();
  const result = await withFamilyWrite<DayPlanDto>(pool, {
    familyId: day.family_id,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'day.mode.set',
    request: { dayId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number }>(`
      SELECT revision FROM app.day_plans
      WHERE id=$1 AND family_id=$2
      FOR UPDATE
    `, [dayId, day.family_id]);
    if (!current.rows[0]) throw notFound();
    if (Number(current.rows[0].revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '当天安排已被其他家长更新', {
        current: await loadDayPlan(client, day.child_id, databaseDate(day.local_date)),
        submitted: input.baseRevision,
      });
    }
    const items = await client.query<{
      id: string;
      kind: ContentCard['kind'];
      budget_minutes: number;
      base_budget_minutes: number;
      started_at: Date | null;
      locked_by_parent: boolean;
      participation_id: string | null;
      has_session: boolean;
    }>(`
      SELECT pi.id,pi.kind,pi.budget_minutes,pi.base_budget_minutes,
             pi.started_at,pi.locked_by_parent,p.id AS participation_id,
             EXISTS (SELECT 1 FROM app.play_sessions ps WHERE ps.plan_item_id=pi.id) AS has_session
      FROM app.plan_items pi
      LEFT JOIN app.participations p
        ON p.plan_item_id=pi.id AND p.deleted_at IS NULL
      WHERE pi.day_plan_id=$1
      FOR UPDATE OF pi
    `, [dayId]);
    for (const item of items.rows) {
      const protectedItem = Boolean(
        item.participation_id || item.started_at || item.locked_by_parent || item.has_session,
      );
      if (protectedItem) continue;
      const daily = day.generation_version.startsWith('v2.daily:');
      const visibility =
        input.mode === 'lite' && !daily && !liteKinds.has(item.kind) ? 'hidden' : 'active';
      const budget =
        input.mode === 'lite' && (daily || liteKinds.has(item.kind))
          ? Math.min(5, Number(item.base_budget_minutes))
          : Number(item.base_budget_minutes);
      await client.query(`
        UPDATE app.plan_items
        SET visibility=$2,budget_minutes=$3,revision=revision+1,updated_at=now()
        WHERE id=$1 AND family_id=$4
      `, [item.id, visibility, budget, day.family_id]);
    }
    await client.query(`
      UPDATE app.day_plans
      SET mode=$2,revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$3
    `, [dayId, input.mode, day.family_id]);
    const plan = await loadDayPlan(
      client,
      day.child_id,
      databaseDate(day.local_date),
    );
    if (!plan) throw notFound();
    await appendChange({
      entity: 'day_plan',
      id: plan.id,
      revision: plan.revision,
      deleted: false,
      payload: plan,
    });
    return { statusCode: 200, body: plan };
  });
  return scrubPlanResult(pool, result.body, result.replayed);
}

export async function replacePlanItem(
  pool: Pool,
  contentEnvironment: AppConfig['contentEnvironment'],
  actorUserId: string,
  deviceId: string,
  itemId: string,
  input: {
    operationId: string;
    baseRevision: number;
    activityId: string;
    activityRevision: number;
  },
): Promise<PlanItemDto> {
  const plan = await planItemFamily(pool, itemId, actorUserId);
  if (plan.localDate > localDateParts(plan.timezone)) {
    throw new AppError(422, 'FUTURE_ITEM_IMMUTABLE', '未来安排只能预览，不能在今天前替换');
  }
  const result = await withFamilyWrite<PlanItemDto>(pool, {
    familyId: plan.familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'plan_item.replace',
    request: { itemId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{
      revision: number;
      activity_revision_id: string;
      kind: ContentCard['kind'];
      locked_by_parent: boolean;
      started_at: Date | null;
      withdrawn_at: Date | null;
      participation_id: string | null;
      has_session: boolean;
    }>(`
      SELECT pi.revision,pi.activity_revision_id,pi.kind,pi.locked_by_parent,pi.started_at,
             ar.withdrawn_at,p.id AS participation_id,
             EXISTS (SELECT 1 FROM app.play_sessions ps WHERE ps.plan_item_id=pi.id) AS has_session
      FROM app.plan_items pi
      JOIN app.activity_revisions ar ON ar.id=pi.activity_revision_id
      LEFT JOIN app.participations p
        ON p.plan_item_id=pi.id AND p.deleted_at IS NULL
      WHERE pi.id=$1 AND pi.family_id=$2
      FOR UPDATE OF pi
    `, [itemId, plan.familyId]);
    const item = current.rows[0];
    if (!item) throw notFound();
    if (Number(item.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '计划项目已被其他家长更新', {
        current: await loadPlanItem(client, plan.familyId, plan.childId, itemId),
        submitted: input.baseRevision,
      });
    }
    if (item.started_at || (item.locked_by_parent && !item.withdrawn_at) || item.participation_id || item.has_session) {
      throw new AppError(422, 'PLAN_ITEM_IMMUTABLE', '已经开始、已记录或已保护的项目不能替换');
    }
    const child = await client.query<Record<string, unknown>>(`
      SELECT * FROM app.children
      WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL
    `, [plan.childId, plan.familyId]);
    if (!child.rows[0]) throw notFound();
    const ageBand = ageBandAtDate(child.rows[0], plan.localDate);
    const candidate = await client.query<{
      id: string;
      kind: ContentCard['kind'];
      age_bands: string[];
      materials: string[];
      content: ContentCard;
    }>(`
      SELECT ar.id,ar.kind,ar.age_bands,ar.materials,
             ar.content || jsonb_build_object('reviewState',ar.review_state) AS content
      FROM app.activity_revisions ar
      JOIN app.content_release_revisions rr ON rr.activity_revision_id=ar.id
      JOIN app.content_releases cr ON cr.id=rr.release_id
      WHERE ar.activity_id=$1 AND ar.revision=$2
        AND ar.withdrawn_at IS NULL AND cr.status='published' AND cr.active
        AND cr.environment=$3 AND (cr.environment='development' OR (ar.review_state='reviewed' AND NOT ar.test_fixture))
      LIMIT 1
    `, [input.activityId, input.activityRevision, contentEnvironment]);
    const revision = candidate.rows[0];
    if (!revision || revision.content.withdrawn) {
      throw new AppError(422, 'CONTENT_NOT_FOUND', '活动内容不可用');
    }
    if (revision.kind !== item.kind) {
      throw new AppError(422, 'ACTIVITY_KIND_MISMATCH', '替换活动必须保持原来的活动类型');
    }
    if (!ageBand || !revision.age_bands.includes(ageBand)) {
      throw new AppError(422, 'ACTIVITY_AGE_MISMATCH', '替换活动不适用于宝宝当前年龄');
    }
    const preferences = await loadPreferences(client, plan.familyId);
    if (!languageMatches(revision.kind, preferences.languageMode)) {
      throw new AppError(422, 'ACTIVITY_LANGUAGE_MISMATCH', '当前家庭选择不安排英语活动');
    }
    if (!materialsMatch(revision.materials, new Set(preferences.availableMaterials), new Set(preferences.excludedMaterials))) {
      throw new AppError(422, 'ACTIVITY_MATERIAL_MISMATCH', '替换活动需要的材料不在家庭可用清单中');
    }
    await client.query(`
      UPDATE app.plan_items
      SET activity_revision_id=$2,snapshot=$3,locked_by_parent=true,
          revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$4
    `, [
      itemId,
      revision.id,
      JSON.stringify(revision.content),
      plan.familyId,
    ]);
    const updated = await loadPlanItem(client, plan.familyId, plan.childId, itemId);
    await appendChange({
      entity: 'plan_item',
      id: updated.id,
      revision: updated.revision,
      deleted: false,
      payload: updated,
    });
    return { statusCode: 200, body: updated };
  });
  return scrubPlanResult(pool, result.body, result.replayed);
}

export async function startPlanItem(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  itemId: string,
  input: { operationId: string; baseRevision: number },
): Promise<PlanItemDto> {
  const plan = await planItemFamily(pool, itemId, actorUserId);
  if (plan.localDate > localDateParts(plan.timezone)) {
    throw new AppError(422, 'INVALID_DATE', '未来安排不能提前开始');
  }
  const result = await withFamilyWrite<PlanItemDto>(pool, {
    familyId: plan.familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'plan_item.start',
    request: { itemId, baseRevision: input.baseRevision },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{
      revision: number;
      withdrawn_at: Date | null;
    }>(`
      SELECT pi.revision,ar.withdrawn_at
      FROM app.plan_items pi
      JOIN app.activity_revisions ar ON ar.id=pi.activity_revision_id
      WHERE pi.id=$1 AND pi.family_id=$2
      FOR UPDATE OF pi
    `, [itemId, plan.familyId]);
    const item = current.rows[0];
    if (!item) throw notFound();
    if (item.withdrawn_at) {
      throw new AppError(409, 'CONTENT_WITHDRAWN', '这个玩法已停止推荐，请换一个');
    }
    if (Number(item.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '计划项目已被其他家长更新', {
        current: Number(item.revision),
        submitted: input.baseRevision,
      });
    }
    await client.query(`
      UPDATE app.plan_items
      SET started_at=COALESCE(started_at,now()),revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$2
    `, [itemId, plan.familyId]);
    const updated = await loadPlanItem(client, plan.familyId, plan.childId, itemId);
    await appendChange({
      entity: 'plan_item',
      id: updated.id,
      revision: updated.revision,
      deleted: false,
      payload: updated,
    });
    return { statusCode: 200, body: updated };
  });
  return scrubPlanResult(pool, result.body, result.replayed);
}

export async function setPlanItemProtection(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  itemId: string,
  input: {
    operationId: string;
    baseRevision: number;
    lockedByParent: boolean;
    clearStarted: boolean;
  },
): Promise<PlanItemDto> {
  const plan = await planItemFamily(pool, itemId, actorUserId);
  if (plan.localDate > localDateParts(plan.timezone)) {
    throw new AppError(422, 'INVALID_DATE', '未来安排只能在当天查看后保护');
  }
  const result = await withFamilyWrite<PlanItemDto>(pool, {
    familyId: plan.familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'plan_item.protection',
    request: { itemId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{
      revision: number;
      withdrawn_at: Date | null;
      participation_id: string | null;
      session_id: string | null;
    }>(`
      SELECT pi.revision,ar.withdrawn_at,p.id AS participation_id,
             ps.id AS session_id
      FROM app.plan_items pi
      JOIN app.activity_revisions ar ON ar.id=pi.activity_revision_id
      LEFT JOIN app.participations p
        ON p.plan_item_id=pi.id AND p.family_id=pi.family_id AND p.deleted_at IS NULL
      LEFT JOIN app.play_sessions ps
        ON ps.plan_item_id=pi.id AND ps.family_id=pi.family_id
      WHERE pi.id=$1 AND pi.family_id=$2
      FOR UPDATE OF pi
    `, [itemId, plan.familyId]);
    const item = current.rows[0];
    if (!item) throw notFound();
    if (item.withdrawn_at) {
      throw new AppError(409, 'CONTENT_WITHDRAWN', '这个玩法已停止推荐，请换一个');
    }
    if (Number(item.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '计划项目已被其他家长更新', {
        current: Number(item.revision),
        submitted: input.baseRevision,
      });
    }
    if (input.clearStarted && (item.participation_id || item.session_id)) {
      throw new AppError(422, 'STARTED_RECORD_EXISTS', '已有参与记录，不能清除开始状态');
    }
    await client.query(`
      UPDATE app.plan_items
      SET locked_by_parent=$2,
          started_at=CASE WHEN $3 THEN NULL ELSE started_at END,
          revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$4
    `, [itemId, input.lockedByParent, input.clearStarted, plan.familyId]);
    const updated = await loadPlanItem(client, plan.familyId, plan.childId, itemId);
    await appendChange({
      entity: 'plan_item',
      id: updated.id,
      revision: updated.revision,
      deleted: false,
      payload: updated,
    });
    return { statusCode: 200, body: updated };
  });
  return scrubPlanResult(pool, result.body, result.replayed);
}

async function planItemFamily(pool: Pool, itemId: string, userId: string): Promise<{
  familyId: string; childId: string; localDate: string; timezone: string;
}> {
  const item = await pool.query(`
    SELECT pi.family_id,pi.child_id,dp.local_date,dp.timezone
    FROM app.plan_items pi
    JOIN app.day_plans dp ON dp.id=pi.day_plan_id
    JOIN app.family_members m ON m.family_id=pi.family_id AND m.user_id=$2 AND m.active
    JOIN app.families f ON f.id=pi.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE pi.id=$1
  `, [itemId, userId]);
  const row = item.rows[0];
  if (!row) throw notFound();
  return {
    familyId: row.family_id,
    childId: row.child_id,
    localDate: databaseDate(row.local_date),
    timezone: row.timezone,
  };
}

async function validateParticipants(client: PoolClient, familyId: string, participantIds: string[]): Promise<void> {
  if (!participantIds.length) return;
  const members = await client.query<{ count: string }>(`
    SELECT count(*) FROM app.family_members
    WHERE family_id=$1 AND user_id=ANY($2::uuid[]) AND active
  `, [familyId, participantIds]);
  if (Number(members.rows[0]?.count) !== new Set(participantIds).size) {
    throw new AppError(422, 'INVALID_PARTICIPANT', '陪伴者必须属于当前家庭');
  }
}

function sameNotes(
  existing: Array<{ authorId: string; text: string }>,
  incoming: Array<{ authorId: string; text: string }>,
): boolean {
  const existingByAuthor = new Map(existing.map(note => [note.authorId, note.text]));
  return incoming.every(note => !existingByAuthor.has(note.authorId) || existingByAuthor.get(note.authorId) === note.text);
}

export async function putParticipation(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  itemId: string,
  input: {
    operationId: string;
    baseRevision: number;
    status: 'played' | 'skipped';
    participantIds: string[];
    note: string;
    actualMinutes: number | null;
    again: boolean;
  },
): Promise<ParticipationDto> {
  const plan = await planItemFamily(pool, itemId, actorUserId);
  if (plan.localDate > localDateParts(plan.timezone)) throw new AppError(422, 'INVALID_DATE', '未来日期不能记录参与');
  const result = await withFamilyWrite<ParticipationDto>(pool, {
    familyId: plan.familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'participation.put',
    request: { itemId, ...input },
  }, async ({ client, familyId, appendChange }) => {
    await validateParticipants(client, familyId, input.participantIds);
    if (input.status === 'played' && input.participantIds.length === 0) {
      throw new AppError(422, 'PARTICIPANT_REQUIRED', '标记玩过时至少需要一名陪伴者');
    }
    const current = await client.query<ParticipationRow>(`
      SELECT id,plan_item_id,status,participant_ids,notes,actual_minutes,again,added_by,revision
      FROM app.participations
      WHERE plan_item_id=$1 AND deleted_at IS NULL
      FOR UPDATE
    `, [itemId]);
    const existing = current.rows[0];
    const incomingNotes = input.note ? [{ authorId: actorUserId, text: input.note }] : [];
    let participation: ParticipationDto;
    if (!existing) {
      if (input.baseRevision !== 0) throw new AppError(409, 'REVISION_CONFLICT', '记录已被其他家长更新', { current: null, submitted: input.baseRevision });
      const id = randomUUID();
      const inserted = await client.query<ParticipationRow>(`
        INSERT INTO app.participations(
          id,family_id,child_id,plan_item_id,status,participant_ids,notes,
          actual_minutes,again,added_by
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id,plan_item_id,status,participant_ids,notes,actual_minutes,again,added_by,revision
      `, [id, familyId, plan.childId, itemId, input.status, JSON.stringify(input.participantIds), JSON.stringify(incomingNotes), input.actualMinutes, input.again, actorUserId]);
      participation = mapParticipation(inserted.rows[0]!);
    } else {
      const currentDto = mapParticipation(existing);
      const mergeFirstPlayed = input.baseRevision === 0 && Number(existing.revision) === 1
        && existing.status === 'played' && input.status === 'played'
        && (existing.actual_minutes === null
          ? input.actualMinutes === null
          : Number(existing.actual_minutes) === input.actualMinutes)
        && existing.again === input.again
        && sameNotes(existing.notes, incomingNotes);
      if (mergeFirstPlayed) {
        const participantIds = [...new Set([...existing.participant_ids, ...input.participantIds])];
        const notes = [...existing.notes, ...incomingNotes.filter(note => !existing.notes.some(old => old.authorId === note.authorId))];
        const updated = await client.query<ParticipationRow>(`
          UPDATE app.participations
          SET participant_ids=$2,notes=$3,revision=revision+1,updated_at=now()
          WHERE id=$1
          RETURNING id,plan_item_id,status,participant_ids,notes,actual_minutes,again,added_by,revision
        `, [existing.id, JSON.stringify(participantIds), JSON.stringify(notes)]);
        participation = mapParticipation(updated.rows[0]!);
      } else {
        if (input.baseRevision !== Number(existing.revision)) {
          throw new AppError(409, 'REVISION_CONFLICT', '记录已被其他家长更新', { current: currentDto, submitted: input.baseRevision });
        }
        const updated = await client.query<ParticipationRow>(`
          UPDATE app.participations
          SET status=$2,participant_ids=$3,notes=$4,actual_minutes=$5,again=$6,
              revision=revision+1,updated_at=now()
          WHERE id=$1
          RETURNING id,plan_item_id,status,participant_ids,notes,actual_minutes,again,added_by,revision
        `, [existing.id, input.status, JSON.stringify(input.participantIds), JSON.stringify(incomingNotes), input.actualMinutes, input.again]);
        participation = mapParticipation(updated.rows[0]!);
      }
    }
    await client.query(`
      UPDATE app.plan_items
      SET started_at=COALESCE(started_at,now()),
          revision=revision+1,updated_at=now()
      WHERE id=$1
    `, [itemId]);
    const planItem = await loadPlanItem(client, familyId, plan.childId, itemId);
    await appendChange({
      entity: 'plan_item',
      id: planItem.id,
      revision: planItem.revision,
      deleted: false,
      payload: planItem,
    });
    await appendChange({
      entity: 'participation',
      id: participation.id,
      revision: participation.revision,
      deleted: false,
      payload: participation,
    });
    return { statusCode: 200, body: participation };
  });
  return result.body;
}

export async function deleteParticipation(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  itemId: string,
  input: { operationId: string; baseRevision: number },
): Promise<{ id: string; revision: number; changeSeq: number }> {
  const plan = await planItemFamily(pool, itemId, actorUserId);
  const result = await withFamilyWrite<{ id: string; revision: number; changeSeq: number }>(pool, {
    familyId: plan.familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'participation.delete',
    request: { itemId, baseRevision: input.baseRevision },
  }, async ({ client, appendChange }) => {
    const current = await client.query<ParticipationRow>(`
      SELECT id,plan_item_id,status,participant_ids,notes,actual_minutes,again,added_by,revision
      FROM app.participations
      WHERE plan_item_id=$1 AND deleted_at IS NULL FOR UPDATE
    `, [itemId]);
    const row = current.rows[0];
    if (!row) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '记录已被其他家长更新', { current: mapParticipation(row), submitted: input.baseRevision });
    }
    const revision = Number(row.revision) + 1;
    await client.query('UPDATE app.participations SET deleted_at=now(),revision=$2,updated_at=now() WHERE id=$1', [row.id, revision]);
    const changeSeq = await appendChange({ entity: 'participation', id: row.id, revision, deleted: true, payload: null });
    return { statusCode: 200, body: { id: row.id, revision, changeSeq } };
  });
  return result.body;
}

export async function createPlaySession(
  pool: Pool,
  contentEnvironment: AppConfig['contentEnvironment'],
  actorUserId: string,
  deviceId: string,
  childId: string,
  input: {
    operationId: string;
    id: string;
    planItemId: string | null;
    localDate: string;
    activityId: string;
    activityRevision: number;
    participantIds: string[];
    note: string;
  },
): Promise<{
  id: string; childId: string; planItemId: string | null; localDate: string; activityId: string;
  activityRevision: number; participantIds: string[]; note: string; addedBy: string; revision: number;
}> {
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const result = await withFamilyWrite<{
    id: string; childId: string; planItemId: string | null; localDate: string; activityId: string;
    activityRevision: number; participantIds: string[]; note: string; addedBy: string; revision: number;
  }>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'session.create',
    request: { childId, ...input },
  }, async ({ client, appendChange }) => {
    const family = await getFamily(client, familyId);
    if (input.localDate > localDateParts(family.timezone)) throw new AppError(422, 'INVALID_DATE', '未来日期不能创建游戏记录');
    await validateParticipants(client, familyId, input.participantIds);
    let snapshot: unknown;
    if (input.planItemId) {
      const item = await client.query(`
        SELECT pi.snapshot,ar.activity_id,ar.revision,ar.withdrawn_at
        FROM app.plan_items pi
        JOIN app.activity_revisions ar ON ar.id=pi.activity_revision_id
        WHERE pi.id=$1 AND pi.family_id=$2 AND pi.child_id=$3
      `, [input.planItemId, familyId, childId]);
      const row = item.rows[0];
      if (!row) throw notFound();
      if (row.withdrawn_at) throw new AppError(409, 'CONTENT_WITHDRAWN', '这个玩法已停止推荐，请换一个');
      if (row.activity_id !== input.activityId || Number(row.revision) !== input.activityRevision) {
        throw new AppError(422, 'ACTIVITY_REVISION_MISMATCH', '活动修订与计划不一致');
      }
      snapshot = row.snapshot;
    } else {
      const revision = await client.query<{ content: ContentCard }>(`
        SELECT ar.content
        FROM app.activity_revisions ar
        JOIN app.content_release_revisions rr ON rr.activity_revision_id=ar.id
        JOIN app.content_releases cr ON cr.id=rr.release_id
        WHERE ar.activity_id=$1 AND ar.revision=$2 AND ar.withdrawn_at IS NULL
          AND cr.status='published' AND cr.active AND cr.environment=$3
          AND ($3='development' OR (ar.review_state='reviewed' AND NOT ar.test_fixture))
        ORDER BY cr.published_at DESC,ar.created_at DESC LIMIT 1
      `, [input.activityId, input.activityRevision, contentEnvironment]);
      if (!revision.rows[0] || revision.rows[0].content.withdrawn) throw new AppError(422, 'CONTENT_NOT_FOUND', '活动内容不可用');
      const child = await client.query('SELECT * FROM app.children WHERE id=$1 AND deleted_at IS NULL', [childId]);
      if (!child.rows[0]) throw notFound();
      const ageBand = ageBandAtDate(child.rows[0], input.localDate);
      if (!ageBand || !revision.rows[0].content.ageBands.includes(ageBand)) {
        throw new AppError(422, 'ACTIVITY_AGE_MISMATCH', '这项活动不适用于该日期的月龄');
      }
      snapshot = revision.rows[0].content;
    }
    const inserted = await client.query(`
      INSERT INTO app.play_sessions(
        id,operation_id,family_id,child_id,plan_item_id,local_date,activity_id,
        activity_revision,activity_snapshot,participant_ids,note,added_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(id) DO NOTHING
      RETURNING id,child_id,plan_item_id,local_date,activity_id,activity_revision,
                participant_ids,note,added_by,revision
    `, [
      input.id,
      input.operationId,
      familyId,
      childId,
      input.planItemId,
      input.localDate,
      input.activityId,
      input.activityRevision,
      JSON.stringify(snapshot),
      JSON.stringify(input.participantIds),
      input.note,
      actorUserId,
    ]);
    const row = inserted.rows[0];
    if (!row) throw new AppError(409, 'SESSION_ID_CONFLICT', '同一记录标识已被使用');
    const session = {
      id: row.id,
      childId: row.child_id,
      planItemId: row.plan_item_id,
      localDate: databaseDate(row.local_date),
      activityId: row.activity_id,
      activityRevision: Number(row.activity_revision),
      participantIds: row.participant_ids,
      note: row.note,
      addedBy: row.added_by,
      revision: Number(row.revision),
    };
    await appendChange({ entity: 'session', id: session.id, revision: session.revision, deleted: false, payload: session });
    return { statusCode: 201, body: session };
  });
  return result.body;
}

type PreferencesDto = {
  familyId: string;
  availableMaterials: string[];
  excludedMaterials: string[];
  languageMode: 'zh' | 'zh_with_english';
  revision: number;
};

async function loadPreferences(client: PoolClient, familyId: string): Promise<PreferencesDto> {
  const result = await client.query(`
    SELECT family_id,available_materials,excluded_materials,language_mode,revision
    FROM app.family_preferences WHERE family_id=$1
  `, [familyId]);
  const row = result.rows[0];
  if (!row) throw notFound();
  return {
    familyId: row.family_id,
    availableMaterials: row.available_materials,
    excludedMaterials: row.excluded_materials,
    languageMode: row.language_mode,
    revision: Number(row.revision),
  };
}

export async function getPreferences(pool: Pool, actorUserId: string, familyId: string): Promise<PreferencesDto> {
  const snapshot = await withFamilySnapshot(pool, { familyId, actorUserId }, client => loadPreferences(client, familyId));
  return snapshot.data;
}

export async function putPreferences(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  familyId: string,
  input: {
    operationId: string;
    baseRevision: number;
    availableMaterials: string[];
    excludedMaterials: string[];
    languageMode: 'zh' | 'zh_with_english';
  },
): Promise<PreferencesDto> {
  if (input.availableMaterials.some(material => input.excludedMaterials.includes(material))) {
    throw new AppError(422, 'CONFLICTING_MATERIALS', '可用材料与排除材料不能重复');
  }
  const result = await withFamilyWrite<PreferencesDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'preferences.put',
    request: input,
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number }>(
      'SELECT revision FROM app.family_preferences WHERE family_id=$1 FOR UPDATE',
      [familyId],
    );
    const row = current.rows[0];
    if (!row) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '偏好已被其他家长更新', {
        current: await loadPreferences(client, familyId), submitted: input.baseRevision,
      });
    }
    await client.query(`
      UPDATE app.family_preferences
      SET available_materials=$2,excluded_materials=$3,language_mode=$4,
          revision=revision+1,updated_at=now()
      WHERE family_id=$1
    `, [familyId, JSON.stringify(input.availableMaterials), JSON.stringify(input.excludedMaterials), input.languageMode]);
    const preferences = await loadPreferences(client, familyId);
    await appendChange({
      entity: 'family_preferences',
      id: familyId,
      revision: preferences.revision,
      deleted: false,
      payload: preferences,
    });
    return { statusCode: 200, body: preferences };
  });
  return result.body;
}

export async function readFamilySnapshotData(
  pool: Pool,
  actorUserId: string,
  familyId: string,
) {
  return withFamilySnapshot(pool, { familyId, actorUserId }, async client => {
    const family = await getFamily(client, familyId);
    const childrenResult = await client.query(`
      SELECT * FROM app.children WHERE family_id=$1 AND deleted_at IS NULL ORDER BY created_at,id
    `, [familyId]);
    const children: ChildDto[] = childrenResult.rows.map(mapChild);
    const dayRows = await client.query<DayPlanRow>(`
      SELECT * FROM app.day_plans WHERE family_id=$1 ORDER BY local_date,child_id
    `, [familyId]);
    const days = await loadDayPlans(client, dayRows.rows);
    const sessionRows = await client.query(`
      SELECT id,child_id,plan_item_id,local_date,activity_id,activity_revision,
             participant_ids,note,added_by,revision
      FROM app.play_sessions WHERE family_id=$1 ORDER BY created_at,id
    `, [familyId]);
    const sessions = sessionRows.rows.map(row => ({
      id: row.id,
      childId: row.child_id,
      planItemId: row.plan_item_id,
      localDate: databaseDate(row.local_date),
      activityId: row.activity_id,
      activityRevision: Number(row.activity_revision),
      participantIds: row.participant_ids,
      note: row.note,
      addedBy: row.added_by,
      revision: Number(row.revision),
    }));
    const memories = await listFamilyMemories(client, familyId);
    const measurements = await listFamilyMeasurements(client, familyId);
    const observations = await listFamilyObservations(client, familyId);
    const books = await listFamilyBooks(client, familyId, null);
    const media = await listFamilyMedia(client, familyId);
    return {
      children,
      days,
      memories,
      measurements,
      observations,
      sessions,
      books,
      media,
      withdrawals: await listContentWithdrawals(client),
      family,
      preferences: await loadPreferences(client, familyId),
    };
  });
}

export function encodeCursor(familyId: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ familyId, sequence }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, familyId: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { familyId?: unknown; sequence?: unknown };
    if (parsed.familyId !== familyId || !Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence) < 0) throw new Error();
    return Number(parsed.sequence);
  } catch {
    throw new AppError(400, 'INVALID_REQUEST', '同步游标无效');
  }
}

export async function listChanges(
  pool: Pool,
  actorUserId: string,
  familyId: string,
  cursor: string | undefined,
  requestedLimit: number | undefined,
): Promise<{ changes: Array<Record<string, unknown>>; nextCursor: string; hasMore: boolean }> {
  const sequence = cursor ? decodeCursor(cursor, familyId) : 0;
  const limit = requestedLimit ?? 100;
  const result = await withFamilySnapshot(pool, { familyId, actorUserId }, async client => {
    const clock = await client.query<{ last_sequence: string; minimum_cursor: string }>(
      'SELECT last_sequence,minimum_cursor FROM app.family_clocks WHERE family_id=$1',
      [familyId],
    );
    const clockRow = clock.rows[0]!;
    if (cursor && (sequence < Number(clockRow.minimum_cursor) || sequence > Number(clockRow.last_sequence))) {
      throw new AppError(410, 'CURSOR_EXPIRED', '同步游标已过期，请重新读取快照');
    }
    const rows = await client.query(`
      SELECT sequence,entity,entity_id,revision,deleted,payload
      FROM app.changes
      WHERE family_id=$1 AND sequence>$2
      ORDER BY sequence
      LIMIT $3
    `, [familyId, Math.max(sequence, Number(clockRow.minimum_cursor)), limit + 1]);
    const page = rows.rows.slice(0, limit);
    const withdrawals = page.some(row => ['day_plan', 'plan_item'].includes(row.entity))
      ? await listContentWithdrawals(client) : [];
    const reasons = new Map(withdrawals.map(entry => [`${entry.activityId}:${entry.revision}`, entry.reason]));
    return {
      changes: page.map(row => ({
        sequence: Number(row.sequence),
        entity: row.entity,
        id: row.entity_id,
        revision: Number(row.revision),
        deleted: row.deleted,
        payload: ['day_plan','plan_item'].includes(row.entity) ? redactChangedPlan(row.payload, reasons) : row.payload,
      })),
      lastSequence: page.length ? Number(page[page.length - 1]!.sequence) : Math.max(sequence, Number(clockRow.minimum_cursor)),
      hasMore: rows.rows.length > limit,
    };
  });
  return {
    changes: result.data.changes,
    nextCursor: encodeCursor(familyId, result.data.lastSequence),
    hasMore: result.data.hasMore,
  };
}
