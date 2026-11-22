import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import type { ContentCard } from '../content/package.js';
import { listContentWithdrawals } from '../content/workflow.js';
import { withFamilyWrite, withTransaction } from '../db/transactions.js';
import { AppError, notFound } from '../errors.js';
import { lockFamilyForDeletion } from '../jobs/deletions.js';
import { LocalPrivateMediaStorage } from '../media/storage.js';
import { blockedActivity } from '../plans/service.js';
import { opaqueToken, tokenHash } from '../security.js';
import { createStoredZip, type ZipEntry } from './zip.js';

export type ExportType = 'memories' | 'measurements' | 'sessions' | 'plans';
export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';
export type ExportDto = {
  id: string;
  status: ExportStatus;
  downloadUrl: string | null;
  expiresAt: string | null;
  missingMedia: Array<{ mediaId: string; reason: string }>;
};

type ExportRow = {
  id: string;
  family_id: string;
  status: ExportStatus;
  object_key: string | null;
  missing_media: Array<{ mediaId: string; reason: string }>;
  available_until: Date | null;
  download_expires_at: Date | null;
  from_date: string;
  to_date: string;
  queued_at: Date;
  types: ExportType[];
  include_media: boolean;
};

const EXPORT_AVAILABLE_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_LINK_MS = 15 * 60 * 1000;

function dto(row: ExportRow, downloadUrl: string | null): ExportDto {
  return {
    id: row.id,
    status: row.status,
    downloadUrl,
    expiresAt: row.download_expires_at ? new Date(row.download_expires_at).toISOString() : null,
    missingMedia: row.missing_media ?? [],
  };
}

function downloadUrl(config: AppConfig, exportId: string, token: string): string {
  return `${config.publicBaseUrl}/v2/exports/${exportId}/content?token=${encodeURIComponent(token)}`;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  // 防止表格软件把家庭文字当成公式执行。
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(rows: Array<Record<string, unknown>>, columns: string[]): Buffer {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map(column => csvCell(row[column])).join(','));
  return Buffer.from(`\r\n${lines.join('\r\n')}`, 'utf8');
}

async function loadExport(client: import('pg').PoolClient, exportId: string, familyId: string): Promise<ExportRow | null> {
  const result = await client.query<ExportRow>(`
    SELECT id,family_id,status,object_key,missing_media,available_until,download_expires_at,
           from_date::text,to_date::text,types,include_media,created_at AS queued_at
    FROM app.exports WHERE id=$1 AND family_id=$2
  `, [exportId, familyId]);
  return result.rows[0] ?? null;
}

export async function createExport(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  familyId: string,
  input: {
    operationId: string;
    from: string;
    to: string;
    types: ExportType[];
    includeMedia: boolean;
  },
): Promise<ExportDto> {
  if (input.from > input.to) throw new AppError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
  const types = [...new Set(input.types)];
  const exportId = randomUUID();
  const result = await withFamilyWrite(pool, {
    familyId,
    actorUserId,
    deviceId,
    operationId: input.operationId,
    action: 'family.export.create',
    request: { familyId, from: input.from, to: input.to, types, includeMedia: input.includeMedia },
  }, async ({ client }) => {
    await client.query(`
      INSERT INTO app.exports(
        id,family_id,created_by,from_date,to_date,types,include_media,status
      ) VALUES($1,$2,$3,$4,$5,$6,$7,'queued')
    `, [exportId, familyId, actorUserId, input.from, input.to, types, input.includeMedia]);
    return {
      statusCode: 202,
      body: {
        id: exportId,
        status: 'queued' as const,
        downloadUrl: null,
        expiresAt: null,
        missingMedia: [],
      },
    };
  }, role => {
    if (role !== 'owner') throw new AppError(403, 'INSUFFICIENT_ROLE', '只有家庭管理员可以导出');
  });
  return result.body;
}

export async function processExport(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
  exportId: string,
  familyId: string,
): Promise<void> {
  const claimed = await pool.query<ExportRow>(`
    UPDATE app.exports SET status='running',updated_at=now()
    WHERE id=$1 AND family_id=$2 AND status='queued'
    RETURNING id,family_id,status,object_key,missing_media,available_until,download_expires_at,
              from_date::text,to_date::text,types,include_media,created_at AS queued_at
  `, [exportId, familyId]);
  const job = claimed.rows[0];
  if (!job) return;
  try {
    const from = job.from_date;
    const to = job.to_date;
    const types = new Set(job.types);
    const entries: ZipEntry[] = [];
    const manifest: Record<string, unknown> = {
      formatVersion: 1,
      exportId,
      familyId,
      range: { from, to },
      types: [...types],
      generatedAt: new Date().toISOString(),
    };
    const withdrawals = new Set((await listContentWithdrawals(pool)).map(entry => `${entry.activityId}:${entry.revision}`));
    const safeSnapshot = (value: ContentCard | null): ContentCard | null =>
      value && withdrawals.has(`${value.id}:${value.revision}`) ? blockedActivity(value) : value;
    if (types.has('memories')) {
      const result = await pool.query(`
        SELECT m.id,m.child_id,m.local_date,m.type,m.text,m.first_confirmed,m.added_by,m.revision,
               COALESCE(
                 ARRAY(SELECT md.id::text FROM app.media md
                   WHERE md.memory_id=m.id AND md.family_id=m.family_id AND md.deleted_at IS NULL
                   ORDER BY md.created_at,md.id),
                 ARRAY[]::text[]
               ) AS media_ids
        FROM app.memories m
        WHERE m.family_id=$1 AND m.local_date BETWEEN $2 AND $3
          AND m.deleted_at IS NULL AND m.permanently_deleted_at IS NULL
        ORDER BY m.local_date,m.id
      `, [familyId, from, to]);
      manifest.memories = result.rows;
      entries.push({ name: 'memories.csv', data: csv(result.rows, [
        'id', 'child_id', 'local_date', 'type', 'text', 'first_confirmed', 'added_by', 'revision', 'media_ids',
      ]) });
    }
    if (types.has('measurements')) {
      const result = await pool.query(`
        SELECT id,child_id,local_date,kind,value,unit,method,source,added_by,revision
        FROM app.measurements
        WHERE family_id=$1 AND local_date BETWEEN $2 AND $3 AND deleted_at IS NULL
        ORDER BY local_date,id
      `, [familyId, from, to]);
      manifest.measurements = result.rows;
      entries.push({ name: 'measurements.csv', data: csv(result.rows, [
        'id', 'child_id', 'local_date', 'kind', 'value', 'unit', 'method', 'source', 'added_by', 'revision',
      ]) });
    }
    if (types.has('sessions')) {
      const result = await pool.query(`
        SELECT id,child_id,plan_item_id,local_date,activity_id,activity_revision,
               activity_snapshot,participant_ids,note,added_by,revision,created_at
        FROM app.play_sessions
        WHERE family_id=$1 AND local_date BETWEEN $2 AND $3
        ORDER BY local_date,id
      `, [familyId, from, to]);
      for (const row of result.rows) row.activity_snapshot = safeSnapshot(row.activity_snapshot);
      manifest.sessions = result.rows;
      entries.push({ name: 'sessions.csv', data: csv(result.rows, [
        'id', 'child_id', 'plan_item_id', 'local_date', 'activity_id', 'activity_revision',
        'activity_snapshot', 'participant_ids', 'note', 'added_by', 'revision', 'created_at',
      ]) });
    }
    if (types.has('plans')) {
      const days = await pool.query(`
        SELECT id,child_id,local_date,timezone,mode,generation_version,revision,created_at,updated_at
        FROM app.day_plans
        WHERE family_id=$1 AND local_date BETWEEN $2 AND $3
        ORDER BY local_date,id
      `, [familyId, from, to]);
      const items = await pool.query(`
        SELECT i.id,i.day_plan_id,i.child_id,i.position,i.kind,i.block,i.budget_minutes,
               i.snapshot,i.locked_by_parent,i.started_at,i.visibility,i.revision
        FROM app.plan_items i
        JOIN app.day_plans d ON d.id=i.day_plan_id AND d.family_id=i.family_id
        WHERE i.family_id=$1 AND d.local_date BETWEEN $2 AND $3
        ORDER BY d.local_date,i.position
      `, [familyId, from, to]);
      for (const row of items.rows) row.snapshot = safeSnapshot(row.snapshot);
      manifest.plans = { days: days.rows, items: items.rows };
      entries.push({ name: 'plans.csv', data: csv(days.rows, [
        'id', 'child_id', 'local_date', 'timezone', 'mode', 'generation_version', 'revision', 'created_at', 'updated_at',
      ]) });
      entries.push({ name: 'plan-items.csv', data: csv(items.rows, [
        'id', 'day_plan_id', 'child_id', 'position', 'kind', 'block', 'budget_minutes',
        'snapshot', 'locked_by_parent', 'started_at', 'visibility', 'revision',
      ]) });
    }

    const missingMedia: Array<{ mediaId: string; reason: string }> = [];
    if (job.include_media) {
      const media = await pool.query<{
        id: string; state: string; object_key: string | null; mime: string;
      }>(`
        SELECT md.id,md.state,md.object_key,md.mime
        FROM app.media md
        JOIN app.memories m ON m.id=md.memory_id AND m.family_id=md.family_id
        WHERE md.family_id=$1 AND m.local_date BETWEEN $2 AND $3
          AND m.deleted_at IS NULL AND m.permanently_deleted_at IS NULL
          AND md.deleted_at IS NULL
        ORDER BY md.created_at,md.id
      `, [familyId, from, to]);
      for (const item of media.rows) {
        if (item.state !== 'ready') {
          missingMedia.push({
            mediaId: item.id,
            reason: item.state === 'pending' ? '尚未上传完成' : item.state === 'processing' ? '照片仍在处理中' : '照片上传失败',
          });
          continue;
        }
        if (!item.object_key || !(await storage.exists(item.object_key))) {
          missingMedia.push({ mediaId: item.id, reason: '私有文件缺失' });
          continue;
        }
        const extension = item.mime === 'image/jpeg' ? 'jpg' : item.mime === 'image/png' ? 'png' : 'webp';
        entries.push({ name: `media/${item.id}.${extension}`, data: await storage.read(item.object_key) });
      }
    }
    manifest.missingMedia = missingMedia;
    entries.unshift({
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    });
    const objectKey = `families/${familyId}/exports/${exportId}.zip`;
    const archive = createStoredZip(entries);
    await withTransaction(pool, async client => {
      await lockFamilyForDeletion(client, familyId);
      const published = await client.query(`
        UPDATE app.exports
        SET status='ready',object_key=$3,missing_media=$4,available_until=now()+interval '24 hours',
            error_code=NULL,updated_at=now()
        WHERE id=$1 AND family_id=$2 AND status='running'
          AND (NOT types && ARRAY['sessions','plans']::text[] OR NOT EXISTS (
            SELECT 1 FROM app.activity_revisions WHERE withdrawn_at >= $5
          ))
          AND EXISTS (SELECT 1 FROM app.families f WHERE f.id=$2 AND f.deleted_at IS NULL)
      `, [exportId, familyId, objectKey, JSON.stringify(missingMedia), job.queued_at]);
      if (published.rowCount) await storage.write(objectKey, archive);
      else await client.query(`UPDATE app.exports SET status='failed',error_code='CONTENT_CHANGED',updated_at=now()
        WHERE id=$1 AND family_id=$2 AND status='running'`, [exportId, familyId]);
    });
  } catch {
    await pool.query(`
      UPDATE app.exports SET status='failed',error_code='EXPORT_FAILED',updated_at=now()
      WHERE id=$1 AND family_id=$2 AND status='running'
    `, [exportId, familyId]);
  }
}

export async function getExport(
  pool: Pool,
  config: AppConfig,
  actorUserId: string,
  exportId: string,
): Promise<ExportDto> {
  const client = await pool.connect();
  try {
    const access = await client.query<{ family_id: string }>(`
      SELECT e.family_id
      FROM app.exports e
      JOIN app.family_members fm ON fm.family_id=e.family_id AND fm.user_id=$2
        AND fm.active AND fm.role='owner'
      JOIN app.families f ON f.id=e.family_id AND f.deleted_at IS NULL
      WHERE e.id=$1
    `, [exportId, actorUserId]);
    const familyId = access.rows[0]?.family_id;
    if (!familyId) throw notFound();
    const row = await loadExport(client, exportId, familyId);
    if (!row) throw notFound();
    if (row.status === 'ready' && row.types.some(type => type === 'plans' || type === 'sessions')) {
      const superseded = await client.query(`SELECT 1 FROM app.activity_revisions
        WHERE withdrawn_at >= $1 LIMIT 1`, [row.queued_at]);
      if (superseded.rowCount) return dto({ ...row, status: 'expired', download_expires_at: null }, null);
    }
    if (row.status === 'ready' && row.available_until && row.available_until.getTime() <= Date.now()) {
      await client.query("UPDATE app.exports SET status='expired',download_token_hash=NULL,download_expires_at=NULL,updated_at=now() WHERE id=$1 AND status='ready'", [exportId]);
      return dto({ ...row, status: 'expired', download_expires_at: null }, null);
    }
    if (row.status !== 'ready' || !row.object_key) return dto(row, null);
    const token = opaqueToken();
    const expiry = new Date(Date.now() + DOWNLOAD_LINK_MS);
    const granted = await client.query(`
      UPDATE app.exports SET download_token_hash=$3,download_expires_at=$4,updated_at=now()
      WHERE id=$1 AND family_id=$2 AND status='ready'
    `, [exportId, familyId, tokenHash(token), expiry]);
    if (!granted.rowCount) return dto({ ...row, status: 'failed', download_expires_at: null }, null);
    return dto({ ...row, download_expires_at: expiry }, downloadUrl(config, exportId, token));
  } finally {
    client.release();
  }
}

export async function readSignedExport(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
  exportId: string,
  token: string,
): Promise<Buffer> {
  const result = await pool.query<{ object_key: string }>(`
    SELECT e.object_key FROM app.exports e
    JOIN app.families f ON f.id=e.family_id AND f.deleted_at IS NULL
    JOIN app.family_members fm ON fm.family_id=e.family_id AND fm.user_id=e.created_by
      AND fm.active AND fm.role='owner'
    WHERE e.id=$1 AND e.download_token_hash=$2 AND e.status='ready'
      AND e.available_until > now() AND e.download_expires_at > now()
      AND (NOT e.types && ARRAY['sessions','plans']::text[] OR NOT EXISTS (
        SELECT 1 FROM app.activity_revisions WHERE withdrawn_at >= e.created_at
      ))
  `, [exportId, tokenHash(token)]);
  if (!result.rows[0]) throw new AppError(404, 'EXPORT_LINK_NOT_FOUND', '导出链接不存在或已过期');
  return storage.read(result.rows[0].object_key);
}

export async function resumeQueuedExports(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
): Promise<void> {
  const rows = await pool.query<{ id: string; family_id: string }>(
    "SELECT id,family_id FROM app.exports WHERE status IN ('queued','running') ORDER BY created_at LIMIT 20",
  );
  for (const row of rows.rows) {
    await pool.query("UPDATE app.exports SET status='queued' WHERE id=$1 AND status='running'", [row.id]);
    void processExport(pool, storage, row.id, row.family_id).catch(() => undefined);
  }
}
