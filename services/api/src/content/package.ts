import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Pool } from 'pg';
import { AppError } from '../errors.js';

export type ContentCard = {
  id: string;
  revision: number;
  title: string;
  kind: 'movement' | 'explore' | 'reading' | 'english' | 'child-led' | 'calm';
  ageBands: string[];
  support: string;
  materials: string[];
  steps: string[];
  dialogue: { opening: string; engaged: string; observing: string; stopping: string };
  english: { phrase: string; meaning: string; when: string };
  easier: string;
  next: string;
  safety: string;
  sourceIds: string[];
  reviewState: 'draft' | 'reviewed';
  rights: 'original' | 'licensed';
  withdrawn: boolean;
};

export type ContentPackage = {
  schemaVersion: 2;
  packageId: string;
  contentVersion: number;
  channel: 'candidate' | 'release';
  createdOn: string;
  review: { editorial: 'draft' | 'approved'; expert: 'not_reviewed' | 'reviewed'; familyTrial: 'not_started' | 'completed' };
  ageBands: Array<{ id: string; label: string; minMonths: number; maxMonths: number }>;
  sources: Array<{ id: string; title: string; url: string; verifiedOn: string; scope: string }>;
  cards: ContentCard[];
  week: {
    ageBand: string;
    mode: 'standard' | 'lite';
    budgetMinutes: number;
    days: Array<{
      day: number;
      theme: string;
      items: Array<{ id: string; cardId: string; block: 'before' | 'after' | 'bedtime'; kind: ContentCard['kind']; minutes: number }>;
    }>;
  };
  dailyPlans?: {
    startMonths: 12;
    endMonths: 24;
    days: Array<{
      day: number;
      theme: string;
      items: Array<{ id: string; cardId: string; block: 'before' | 'after' | 'bedtime'; kind: ContentCard['kind']; minutes: number }>;
    }>;
  };
  stageGuides: unknown[];
  books: unknown[];
  publicationEnvironment?: 'private_trial' | 'public';
  evidenceRefs?: string[];
};

export type ImportResult = {
  releaseId: string;
  version: number;
  status: 'draft' | 'published' | 'withdrawn';
  environment: 'development' | 'private_trial' | 'public';
  packageId: string;
  contentVersion: number;
  cardCount: number;
};

const schemaPath = new URL('../../../../contracts/v2/content-package.schema.json', import.meta.url);
let validatorPromise: Promise<ValidateFunction> | undefined;

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function contentValidator(): Promise<ValidateFunction> {
  validatorPromise ??= (async () => {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as Record<string, unknown>;
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
    ajv.addFormat('date', { type: 'string', validate: calendarDate });
    ajv.addFormat('uri', {
      type: 'string',
      validate: (value: string) => {
        try {
          const parsed = new URL(value);
          return ['http:', 'https:'].includes(parsed.protocol);
        } catch {
          return false;
        }
      },
    });
    ajv.addFormat('date-time', {
      type: 'string',
      validate: (value: string) => Number.isFinite(Date.parse(value)),
    });
    return ajv.compile(schema);
  })();
  return validatorPromise;
}

function validateReferences(content: ContentPackage): void {
  for (const entries of [content.cards, content.sources, content.ageBands]) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
      throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '内容标识不能重复');
    }
  }
  const sourceIds = new Set(content.sources.map(source => source.id));
  const ageBandIds = new Set(content.ageBands.map(ageBand => ageBand.id));
  const cards = new Map(content.cards.map(card => [card.id, card]));
  for (const card of content.cards) {
    if (!card.ageBands.every(id => ageBandIds.has(id))) throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '活动引用了不存在的年龄档');
    if (!card.sourceIds.every(id => sourceIds.has(id))) throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '活动引用了不存在的来源');
  }
  if (!ageBandIds.has(content.week.ageBand)) throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '周计划引用了不存在的年龄档');
  for (const day of content.week.days) {
    for (const item of day.items) {
      const card = cards.get(item.cardId);
      if (!card) throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '周计划引用了不存在的活动');
      if (card.kind !== item.kind) throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '周计划活动类型与正文不一致');
    }
  }
  if (content.dailyPlans) {
    const ids = new Set<string>();
    const dailyCards = new Set<string>();
    for (const [index, day] of content.dailyPlans.days.entries()) {
      if (day.day !== index + 1) throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '每日计划须按第 1～365 天连续排列');
      for (const item of day.items) {
        const card = cards.get(item.cardId);
        const band = day.day <= 91 ? 'm12_14' : day.day <= 182 ? 'm15_17' : 'm18_23';
        if (!card || card.kind !== item.kind || !card.ageBands.includes(band) || card.withdrawn) {
          throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '每日计划的活动、类型或月龄不匹配');
        }
        if (ids.has(item.id) || dailyCards.has(item.cardId)) throw new AppError(422, 'INVALID_CONTENT_REFERENCE', '每日计划须使用独立的计划项和活动标识');
        ids.add(item.id);
        dailyCards.add(item.cardId);
      }
    }
  }
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export async function readContentPackage(path: string): Promise<ContentPackage> {
  const content = JSON.parse(await readFile(path, 'utf8')) as ContentPackage;
  const validate = await contentValidator();
  if (!validate(content)) {
    throw new AppError(422, 'INVALID_CONTENT_PACKAGE', '内容包不符合合同结构', {
      errors: (validate.errors ?? []).slice(0, 20).map(error => ({
        path: error.instancePath,
        keyword: error.keyword,
        message: error.message,
      })),
    });
  }
  validateReferences(content);
  return content;
}

export async function importContentPackage(
  pool: Pool,
  content: ContentPackage,
  environment: 'development' | 'private_trial' | 'public',
  createdBy: string | null,
): Promise<ImportResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('babyplan-content-import'))");
    const existing = await client.query<{
      id: string; version: number; package_id: string; content_version: number;
      status: 'draft' | 'published' | 'withdrawn'; package_snapshot: ContentPackage;
    }>(`
      SELECT id,version,package_id,content_version,status,package_snapshot
      FROM app.content_releases
      WHERE environment=$1 AND package_id=$2 AND content_version=$3
      ORDER BY version DESC LIMIT 1
    `, [environment, content.packageId, content.contentVersion]);
    if (existing.rows[0]) {
      if (stableJson(existing.rows[0].package_snapshot) !== stableJson(content)) {
        throw new AppError(409, 'CONTENT_VERSION_IMMUTABLE', '同一内容版本不能导入不同正文');
      }
      const linked = await client.query<{ count: string }>(
        'SELECT count(*) FROM app.content_release_revisions WHERE release_id=$1',
        [existing.rows[0].id],
      );
      await client.query('COMMIT');
      return {
        releaseId: existing.rows[0].id,
        version: Number(existing.rows[0].version),
        status: existing.rows[0].status,
        environment,
        packageId: existing.rows[0].package_id,
        contentVersion: Number(existing.rows[0].content_version),
        cardCount: Number(linked.rows[0]?.count ?? 0),
      };
    }
    const versionResult = await client.query<{ next_version: number }>(
      'SELECT COALESCE(MAX(version),0)+1 AS next_version FROM app.content_releases WHERE environment=$1',
      [environment],
    );
    const version = Number(versionResult.rows[0]!.next_version);
    const releaseId = randomUUID();
    await client.query(`
      INSERT INTO app.content_releases(
        id,version,environment,status,package_id,content_version,self_reviewed,
        evidence_refs,created_by,package_snapshot
      ) VALUES($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9)
    `, [
      releaseId,
      version,
      environment,
      content.packageId,
      content.contentVersion,
      content.review.editorial === 'approved' && content.review.expert === 'reviewed',
      JSON.stringify(content.evidenceRefs ?? []),
      createdBy,
      JSON.stringify(content),
    ]);
    for (const source of content.sources) {
      await client.query(`
        INSERT INTO app.content_sources(id,title,url,verified_on,scope,updated_at)
        VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT(id) DO UPDATE
        SET title=excluded.title,url=excluded.url,verified_on=excluded.verified_on,
            scope=excluded.scope,updated_at=now()
      `, [source.id, source.title, source.url, source.verifiedOn, source.scope]);
    }
    let cardCount = 0;
    for (const card of content.cards) {
      const revisionId = randomUUID();
      const body = JSON.stringify(card);
      await client.query(`
        INSERT INTO app.activity_revisions(
          id,activity_id,revision,package_id,content_version,kind,age_bands,title,
          support,materials,content,content_hash,review_state,test_fixture
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [
        revisionId,
        card.id,
        card.revision,
        content.packageId,
        content.contentVersion,
        card.kind,
        JSON.stringify(card.ageBands),
        card.title,
        card.support,
        JSON.stringify(card.materials),
        body,
        createHash('sha256').update(body).digest('hex'),
        card.reviewState,
        environment === 'development',
      ]);
      await client.query(
        'INSERT INTO app.content_release_revisions(release_id,activity_revision_id) VALUES($1,$2)',
        [releaseId, revisionId],
      );
      cardCount += 1;
    }
    await client.query('COMMIT');
    return {
      releaseId,
      version,
      status: 'draft',
      environment,
      packageId: content.packageId,
      contentVersion: content.contentVersion,
      cardCount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function publishContentRelease(pool: Pool, releaseId: string): Promise<{ id: string; status: 'published'; publishedAt: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const release = await client.query<{
      id: string; environment: 'development' | 'private_trial' | 'public'; status: string;
      package_snapshot: ContentPackage; published_at: Date | null;
    }>('SELECT id,environment,status,package_snapshot,published_at FROM app.content_releases WHERE id=$1 FOR UPDATE', [releaseId]);
    const row = release.rows[0];
    if (!row) throw new AppError(404, 'RELEASE_NOT_FOUND', '内容版本不存在');
    if (row.status === 'published') {
      await client.query('COMMIT');
      return { id: row.id, status: 'published', publishedAt: row.published_at!.toISOString() };
    }
    if (row.status !== 'draft') throw new AppError(409, 'RELEASE_NOT_PUBLISHABLE', '当前内容版本不能发布');
    if (!row.package_snapshot) throw new AppError(422, 'CONTENT_PACKAGE_MISSING', '内容包快照缺失');
    if (row.environment !== 'development') {
      throw new AppError(422, 'REVIEW_WORKFLOW_REQUIRED', '私人试用或公开发布请使用内容工作台核对审核证据');
    }
    await client.query(
      'UPDATE app.content_releases SET active=false WHERE environment=$1 AND active',
      [row.environment],
    );
    const published = await client.query<{ published_at: Date }>(
      "UPDATE app.content_releases SET status='published',active=true,published_at=now() WHERE id=$1 RETURNING published_at",
      [releaseId],
    );
    await client.query('COMMIT');
    return { id: releaseId, status: 'published', publishedAt: published.rows[0]!.published_at.toISOString() };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
