import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import type { AppConfig } from '../config.js';
import { operationLock, withFamilyWrite, withTransaction } from '../db/transactions.js';
import { AppError, notFound } from '../errors.js';
import { type DeletionEvent, type DeletionJournal, registerDeletion } from '../jobs/deletion-journal.js';
import { hideDeletedGrowth, lockFamilyForDeletion } from '../jobs/deletions.js';
import { opaqueToken, tokenHash } from '../security.js';
import { LocalPrivateMediaStorage } from './storage.js';

export type MediaState = 'pending' | 'processing' | 'ready' | 'failed' | 'deleted';
export type MediaDto = {
  id: string;
  memoryId: string;
  state: MediaState;
  mime: string;
  byteSize: number;
  sha256: string;
  downloadUrl: string | null;
  expiresAt: string | null;
};

export type MediaUploadInput = {
  operationId: string;
  memoryId: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  byteSize: number;
  sha256: string;
};

type UploadActor = { userId: string; sessionId: string; deviceId: string };
type UploadReceipt = { media: MediaDto; uploadUrl: string; expiresAt: string };

type MediaRow = {
  id: string;
  memory_id: string;
  state: MediaState;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  byte_size: number;
  sha256: string;
  object_key: string | null;
  source_sha256: string | null;
  upload_expires_at: Date | null;
  revision: number;
};

const LINK_LIFETIME_MS = 15 * 60 * 1000;
const MAX_MEDIA_PER_MEMORY = 20;
const MAX_FAMILY_MEDIA_BYTES = 250 * 1024 * 1024;
const THUMBNAIL_SUFFIX = '.thumb.webp';

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dto(row: MediaRow, downloadUrl: string | null, expiresAt: Date | null): MediaDto {
  return {
    id: row.id,
    memoryId: row.memory_id,
    state: row.state,
    mime: row.mime,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    downloadUrl,
    expiresAt: iso(expiresAt),
  };
}

function extension(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
}

function mediaUrl(config: AppConfig, mediaId: string, token: string): string {
  return `${config.publicBaseUrl}/v2/media/${mediaId}/content?token=${encodeURIComponent(token)}`;
}

function uploadUrl(config: AppConfig, token: string): string {
  return `${config.publicBaseUrl}/v2/media/upload-targets/${encodeURIComponent(token)}`;
}

async function memoryFamilyId(pool: Pool, memoryId: string, userId: string): Promise<string> {
  const result = await pool.query<{ family_id: string }>(`
    SELECT m.family_id
    FROM app.memories m
    JOIN app.family_members fm ON fm.family_id=m.family_id AND fm.user_id=$2 AND fm.active
    JOIN app.families f ON f.id=m.family_id AND f.deleted_at IS NULL
    WHERE m.id=$1 AND m.deleted_at IS NULL AND m.permanently_deleted_at IS NULL
  `, [memoryId, userId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].family_id;
}

async function mediaFamilyId(pool: Pool, mediaId: string, userId: string): Promise<string> {
  const result = await pool.query<{ family_id: string }>(`
    SELECT md.family_id
    FROM app.media md
    JOIN app.family_members fm ON fm.family_id=md.family_id AND fm.user_id=$2 AND fm.active
    JOIN app.families f ON f.id=md.family_id AND f.deleted_at IS NULL
    WHERE md.id=$1 AND md.deleted_at IS NULL
  `, [mediaId, userId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].family_id;
}

async function mediaFamilyIdForDelete(pool: Pool, mediaId: string, userId: string): Promise<string> {
  const result = await pool.query<{ family_id: string }>(`
    SELECT md.family_id
    FROM app.media md
    JOIN app.family_members fm ON fm.family_id=md.family_id AND fm.user_id=$2 AND fm.active
    JOIN app.families f ON f.id=md.family_id AND f.deleted_at IS NULL
    WHERE md.id=$1
  `, [mediaId, userId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].family_id;
}

async function loadMedia(client: PoolClient, mediaId: string, familyId: string): Promise<MediaRow | null> {
  const result = await client.query<MediaRow>(`
    SELECT id,memory_id,state,mime,byte_size,sha256,object_key,source_sha256,upload_expires_at,revision
    FROM app.media WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL
  `, [mediaId, familyId]);
  return result.rows[0] ?? null;
}

function assertImageSignature(buffer: Buffer, mime: MediaUploadInput['mime']): void {
  const valid = mime === 'image/jpeg'
    ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : mime === 'image/png'
      ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new AppError(422, 'INVALID_IMAGE', '上传内容与照片类型不一致');
}

async function uploadMemberRevision(client: PoolClient, familyId: string, actor: UploadActor): Promise<string> {
  const result = await client.query<{ revision: string }>(`
    SELECT fm.revision
    FROM app.family_members fm
    JOIN app.families f ON f.id=fm.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=fm.user_id AND u.disabled_at IS NULL
    JOIN app.sessions s ON s.id=$3 AND s.user_id=u.id
      AND s.revoked_at IS NULL AND s.refresh_expires_at>clock_timestamp()
    WHERE fm.family_id=$1 AND fm.user_id=$2 AND fm.active
    FOR SHARE OF s
  `, [familyId, actor.userId, actor.sessionId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].revision;
}

/** 重试同一上传只续发失效地址，保留照片和原操作标识。 */
async function replayUploadReceipt(
  pool: Pool,
  config: AppConfig,
  actor: UploadActor,
  familyId: string,
  operationId: string,
  mediaId: string,
): Promise<UploadReceipt> {
  return withTransaction(pool, async client => {
    // 与首次上传使用同样的锁顺序，防止并发重试为同一照片签发不同地址。
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [operationLock(actor.userId, operationId)]);
    await lockFamilyForDeletion(client, familyId);
    const memberRevision = await uploadMemberRevision(client, familyId, actor);
    const previous = await client.query<{ result: UploadReceipt; state: MediaState; valid: boolean | null }>(`
      SELECT op.result, md.state,
        (md.upload_token_hash IS NOT NULL AND md.upload_expires_at>clock_timestamp()
          AND md.upload_member_revision=$5 AND issuer.id IS NOT NULL) AS valid
      FROM app.operations op
      JOIN app.media md ON md.id=$4 AND md.family_id=op.family_id AND md.deleted_at IS NULL
      JOIN app.memories m ON m.id=md.memory_id AND m.family_id=md.family_id AND m.deleted_at IS NULL
      LEFT JOIN app.sessions issuer ON issuer.id=md.upload_session_id AND issuer.user_id=op.actor_user_id
        AND issuer.revoked_at IS NULL AND issuer.refresh_expires_at>clock_timestamp()
      WHERE op.actor_user_id=$1 AND op.operation_id=$2 AND op.family_id=$3 AND op.action='media.upload.create'
        AND op.expires_at>clock_timestamp()
        AND op.result->'media'->>'id'=md.id::text
    `, [actor.userId, operationId, familyId, mediaId, memberRevision]);
    const saved = previous.rows[0];
    if (!saved) throw notFound();
    if (saved.state !== 'pending' || saved.valid) return saved.result;

    const token = opaqueToken();
    const expiresAt = new Date(Date.now() + LINK_LIFETIME_MS);
    await client.query(`
      UPDATE app.media SET upload_token_hash=$2,upload_expires_at=$3,upload_session_id=$4,upload_member_revision=$5
      WHERE id=$1
    `, [mediaId, tokenHash(token), expiresAt, actor.sessionId, memberRevision]);
    const receipt = { ...saved.result, uploadUrl: uploadUrl(config, token), expiresAt: expiresAt.toISOString() };
    await client.query('UPDATE app.operations SET result=$3 WHERE actor_user_id=$1 AND operation_id=$2',
      [actor.userId, operationId, receipt]);
    return receipt;
  });
}

export async function createMediaUpload(
  pool: Pool,
  config: AppConfig,
  actor: UploadActor,
  input: MediaUploadInput,
): Promise<UploadReceipt> {
  const familyId = await memoryFamilyId(pool, input.memoryId, actor.userId);
  const mediaId = randomUUID();
  const uploadToken = opaqueToken();
  const expiresAt = new Date(Date.now() + LINK_LIFETIME_MS);
  const result = await withFamilyWrite<UploadReceipt>(pool, {
    familyId,
    actorUserId: actor.userId,
    deviceId: actor.deviceId,
    operationId: input.operationId,
    action: 'media.upload.create',
    request: { memoryId: input.memoryId, mime: input.mime, byteSize: input.byteSize, sha256: input.sha256 },
  }, async ({ client, appendChange }) => {
    const memberRevision = await uploadMemberRevision(client, familyId, actor);
    const memory = await client.query('SELECT 1 FROM app.memories WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL AND permanently_deleted_at IS NULL FOR UPDATE', [input.memoryId, familyId]);
    if (!memory.rowCount) throw notFound();
    const usage = await client.query<{ count: string; total: string }>(`
      SELECT count(*)::text AS count,COALESCE(sum(byte_size),0)::text AS total
      FROM app.media WHERE family_id=$1 AND deleted_at IS NULL
    `, [familyId]);
    const memoryUsage = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app.media WHERE family_id=$1 AND memory_id=$2 AND deleted_at IS NULL',
      [familyId, input.memoryId],
    );
    if (Number(memoryUsage.rows[0]?.count) >= MAX_MEDIA_PER_MEMORY
      || Number(usage.rows[0]?.total) + input.byteSize > MAX_FAMILY_MEDIA_BYTES) {
      throw new AppError(422, 'MEDIA_QUOTA_EXCEEDED', '照片数量或存储空间超过家庭上限');
    }
    const objectKey = `families/${familyId}/memories/${input.memoryId}/${mediaId}.${extension(input.mime)}`;
    await client.query(`
      INSERT INTO app.media(
        id,family_id,memory_id,state,mime,byte_size,sha256,source_sha256,object_key,
        upload_token_hash,upload_expires_at,upload_session_id,upload_member_revision
      ) VALUES($1,$2,$3,'pending',$4,$5,$6,$6,$7,$8,$9,$10,$11)
    `, [
      mediaId, familyId, input.memoryId, input.mime, input.byteSize,
      input.sha256, objectKey, tokenHash(uploadToken), expiresAt, actor.sessionId, memberRevision,
    ]);
    const row = await loadMedia(client, mediaId, familyId);
    if (!row) throw notFound();
    const media = dto(row, null, null);
    await appendChange({ entity: 'media', id: mediaId, revision: Number(row.revision), deleted: false, payload: media });
    return {
      statusCode: 201,
      body: { media, uploadUrl: uploadUrl(config, uploadToken), expiresAt: expiresAt.toISOString() },
    };
  });
  return result.replayed
    ? replayUploadReceipt(pool, config, actor, familyId, input.operationId, result.body.media.id)
    : result.body;
}

export async function acceptUploadedBytes(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
  token: string,
  contentType: string,
  bytes: Buffer,
): Promise<void> {
  const hash = tokenHash(token);
  const unavailable = () => new AppError(404, 'UPLOAD_TARGET_NOT_FOUND', '上传地址不存在或已过期');
  const found = await pool.query<{ family_id: string }>(
    'SELECT family_id FROM app.media WHERE upload_token_hash=$1', [hash],
  );
  const familyId = found.rows[0]?.family_id;
  if (!familyId) throw unavailable();
  await withTransaction(pool, async client => {
    await lockFamilyForDeletion(client, familyId);
    const result = await client.query<{
      mime: MediaUploadInput['mime']; byte_size: number; object_key: string; upload_expires_at: Date;
    }>(`
      SELECT md.mime,md.byte_size,md.object_key,md.upload_expires_at
      FROM app.media md
      JOIN app.families f ON f.id=md.family_id AND f.deleted_at IS NULL
      JOIN app.memories m ON m.id=md.memory_id AND m.family_id=md.family_id AND m.deleted_at IS NULL
      JOIN app.sessions s ON s.id=md.upload_session_id AND s.revoked_at IS NULL AND s.refresh_expires_at>clock_timestamp()
      JOIN app.users u ON u.id=s.user_id AND u.disabled_at IS NULL
      JOIN app.family_members fm ON fm.family_id=md.family_id AND fm.user_id=u.id
        AND fm.active AND fm.revision=md.upload_member_revision
      WHERE md.family_id=$1 AND md.upload_token_hash=$2 AND md.state='pending' AND md.deleted_at IS NULL
      FOR SHARE OF s
    `, [familyId, hash]);
    const media = result.rows[0];
    if (!media || media.upload_expires_at.getTime() <= Date.now()) throw unavailable();
    if (contentType.split(';', 1)[0]!.trim().toLowerCase() !== media.mime) {
      throw new AppError(422, 'INVALID_IMAGE_TYPE', '照片类型与上传申请不一致');
    }
    if (bytes.length !== Number(media.byte_size)) {
      throw new AppError(422, 'MEDIA_SIZE_MISMATCH', '上传照片大小与申请不一致');
    }
    assertImageSignature(bytes, media.mime);
    await storage.write(media.object_key, bytes);
  });
}

export async function completeMediaUpload(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
  actorUserId: string,
  deviceId: string,
  mediaId: string,
  operationId: string,
): Promise<MediaDto> {
  const familyId = await mediaFamilyId(pool, mediaId, actorUserId);
  const result = await withFamilyWrite(pool, {
    familyId,
    actorUserId,
    deviceId,
    operationId,
    action: 'media.upload.complete',
    request: { mediaId },
  }, async ({ client, appendChange }) => {
    const row = await loadMedia(client, mediaId, familyId);
    if (!row) throw notFound();
    if (row.state !== 'pending') {
      throw new AppError(409, 'INVALID_MEDIA_STATE', '这张照片已经完成上传或正在处理');
    }
    if (!row.object_key || !row.upload_expires_at || row.upload_expires_at.getTime() <= Date.now()) {
      throw new AppError(409, 'UPLOAD_EXPIRED', '上传地址已过期，请重新发起');
    }
    if (!(await storage.exists(row.object_key))) {
      throw new AppError(422, 'UPLOAD_MISSING', '尚未收到照片文件');
    }
    const bytes = await storage.read(row.object_key);
    if (bytes.length !== Number(row.byte_size)) throw new AppError(422, 'MEDIA_SIZE_MISMATCH', '照片大小校验失败');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== row.source_sha256) throw new AppError(422, 'MEDIA_HASH_MISMATCH', '照片摘要校验失败');
    assertImageSignature(bytes, row.mime);
    try {
      await sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
    } catch {
      throw new AppError(422, 'INVALID_IMAGE', '照片无法解码');
    }
    await client.query(`
      UPDATE app.media
      SET state='processing',revision=revision+1,upload_token_hash=NULL,upload_expires_at=NULL,
          upload_session_id=NULL,upload_member_revision=NULL,updated_at=now()
      WHERE id=$1 AND family_id=$2
    `, [mediaId, familyId]);
    const processing = { ...row, state: 'processing' as const, revision: Number(row.revision) + 1 };
    const media = dto(processing, null, null);
    await appendChange({ entity: 'media', id: mediaId, revision: Number(processing.revision), deleted: false, payload: media });
    return { statusCode: 202, body: media };
  });
  void processMedia(pool, storage, mediaId, familyId).catch(() => undefined);
  return result.body;
}

async function processMedia(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
  mediaId: string,
  familyId: string,
): Promise<void> {
  const claimed = await pool.query<MediaRow>(`
    UPDATE app.media
    SET updated_at=now()
    WHERE id=$1 AND family_id=$2 AND state='processing' AND deleted_at IS NULL
    RETURNING id,memory_id,state,mime,byte_size,sha256,object_key,source_sha256,upload_expires_at,revision
  `, [mediaId, familyId]);
  const row = claimed.rows[0];
  if (!row?.object_key) return;
  try {
    const input = await storage.read(row.object_key);
    const pipeline = sharp(input, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
    const output = row.mime === 'image/jpeg'
      ? await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer()
      : row.mime === 'image/png'
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
        : await pipeline.webp({ quality: 88 }).toBuffer();
    const thumbnail = await sharp(output).resize({
      width: 640, height: 640, fit: 'inside', withoutEnlargement: true,
    }).webp({ quality: 78 }).toBuffer();
    const digest = createHash('sha256').update(output).digest('hex');
    const key = row.object_key;
    await updateMediaState(pool, familyId, mediaId, 'ready', digest, output.length, null, async () => {
      await storage.write(key, output);
      await storage.write(`${key}${THUMBNAIL_SUFFIX}`, thumbnail);
    });
  } catch {
    await updateMediaState(pool, familyId, mediaId, 'failed', null, null, 'MEDIA_PROCESSING_FAILED');
  }
}

async function updateMediaState(
  pool: Pool,
  familyId: string,
  mediaId: string,
  state: 'ready' | 'failed',
  digest: string | null,
  byteSize: number | null,
  errorCode: string | null,
  saveFiles?: () => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockFamilyForDeletion(client, familyId);
    const updated = await client.query<MediaRow>(`
      UPDATE app.media
      SET state=$3,sha256=COALESCE($4,sha256),byte_size=COALESCE($5,byte_size),
          revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$2 AND state='processing' AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM app.families f WHERE f.id=$2 AND f.deleted_at IS NULL)
      RETURNING id,memory_id,state,mime,byte_size,sha256,object_key,source_sha256,upload_expires_at,revision
    `, [mediaId, familyId, state, digest, byteSize]);
    const row = updated.rows[0];
    if (row) {
      await saveFiles?.();
      const next = await client.query<{ last_sequence: string }>(
        'UPDATE app.family_clocks SET last_sequence=last_sequence+1 WHERE family_id=$1 RETURNING last_sequence',
        [familyId],
      );
      const payload = { ...dto(row, null, null), ...(errorCode ? { errorCode } : {}) };
      await client.query(`
        INSERT INTO app.changes(family_id,sequence,entity,entity_id,revision,deleted,payload)
        VALUES($1,$2,'media',$3,$4,false,$5)
      `, [familyId, next.rows[0]!.last_sequence, mediaId, Number(row.revision), payload]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resumeProcessingMedia(pool: Pool, storage: LocalPrivateMediaStorage): Promise<void> {
  const rows = await pool.query<{ id: string; family_id: string }>(
    "SELECT id,family_id FROM app.media WHERE state='processing' AND deleted_at IS NULL ORDER BY created_at LIMIT 100",
  );
  for (const row of rows.rows) void processMedia(pool, storage, row.id, row.family_id).catch(() => undefined);
}

export async function getMedia(
  pool: Pool,
  config: AppConfig,
  actor: { userId: string; sessionId: string },
  mediaId: string,
): Promise<MediaDto> {
  const token = opaqueToken();
  const expiresAt = new Date(Date.now() + LINK_LIFETIME_MS);
  const { rows: [row] } = await pool.query<MediaRow>(`
    WITH authorized AS (
      SELECT md.id,md.memory_id,md.state,md.mime,md.byte_size,md.sha256,
             md.object_key,md.source_sha256,md.upload_expires_at,md.revision,
             fm.revision AS member_revision
      FROM app.media md
      JOIN app.families f ON f.id=md.family_id AND f.deleted_at IS NULL
      JOIN app.memories m ON m.id=md.memory_id AND m.family_id=md.family_id AND m.deleted_at IS NULL
      JOIN app.family_members fm ON fm.family_id=md.family_id AND fm.user_id=$2 AND fm.active
      JOIN app.users u ON u.id=fm.user_id AND u.disabled_at IS NULL
      JOIN app.sessions s ON s.id=$3 AND s.user_id=u.id
        AND s.revoked_at IS NULL AND s.refresh_expires_at>now()
      WHERE md.id=$1 AND md.deleted_at IS NULL
      FOR KEY SHARE OF md,s
    ), issued AS (
      INSERT INTO app.media_download_links(token_hash,media_id,session_id,member_revision,expires_at)
      SELECT $4,id,$3,member_revision,$5 FROM authorized WHERE state='ready'
    ), pruned AS (
      DELETE FROM app.media_download_links l USING (
        SELECT token_hash FROM app.media_download_links
        WHERE expires_at<=now() AND EXISTS (SELECT 1 FROM authorized WHERE state='ready')
        ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED
      ) expired WHERE l.token_hash=expired.token_hash
    )
    SELECT * FROM authorized
  `, [mediaId, actor.userId, actor.sessionId, tokenHash(token), expiresAt]);
  if (!row) throw notFound();
  return row.state === 'ready' ? dto(row, mediaUrl(config, mediaId, token), expiresAt) : dto(row, null, null);
}

export async function readSignedMedia(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
  mediaId: string,
  token: string,
): Promise<{ bytes: Buffer; mime: string; sha256: string }> {
  const result = await pool.query<{
    object_key: string; mime: string; sha256: string; byte_size: number;
  }>(`
    SELECT md.object_key,md.mime,md.sha256,md.byte_size FROM app.media md
    JOIN app.media_download_links l ON l.media_id=md.id AND l.token_hash=$2 AND l.expires_at>now()
    JOIN app.sessions s ON s.id=l.session_id AND s.revoked_at IS NULL AND s.refresh_expires_at>now()
    JOIN app.users u ON u.id=s.user_id AND u.disabled_at IS NULL
    JOIN app.families f ON f.id=md.family_id AND f.deleted_at IS NULL
    JOIN app.memories m ON m.id=md.memory_id AND m.family_id=md.family_id AND m.deleted_at IS NULL
    JOIN app.family_members fm ON fm.family_id=md.family_id AND fm.user_id=u.id
      AND fm.active AND fm.revision=l.member_revision
    WHERE md.id=$1 AND md.state='ready' AND md.deleted_at IS NULL
  `, [mediaId, tokenHash(token)]);
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'MEDIA_LINK_NOT_FOUND', '照片链接不存在或已过期');
  const bytes = await storage.read(row.object_key);
  if (bytes.length !== Number(row.byte_size) || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
    throw new AppError(503, 'MEDIA_INTEGRITY_FAILED', '照片文件暂时无法读取');
  }
  return { bytes, mime: row.mime, sha256: row.sha256 };
}

export async function deleteMedia(
  pool: Pool,
  journal: DeletionJournal | null,
  onDeletion: (event: DeletionEvent) => void,
  actorUserId: string,
  deviceId: string,
  mediaId: string,
  operationId: string,
): Promise<{ id: string; revision: number; changeSeq: number }> {
  const familyId = await mediaFamilyIdForDelete(pool, mediaId, actorUserId);
  let event: DeletionEvent | undefined;
  const result = await withFamilyWrite(pool, {
    familyId,
    actorUserId,
    deviceId,
    operationId,
    action: 'media.delete',
    request: { mediaId },
  }, async ({ client }) => {
    const row = await loadMedia(client, mediaId, familyId);
    if (!row) throw notFound();
    event = await registerDeletion(client, journal, {
      kind: 'media', id: mediaId, familyId, memoryId: row.memory_id,
    });
    const { revision, changeSeq } = await hideDeletedGrowth(client, event);
    return { statusCode: 200, body: { id: mediaId, revision, changeSeq } };
  });
  if (event) onDeletion(event);
  return result.body;
}
