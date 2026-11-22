import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError, notFound } from '../errors.js';
import { withFamilySnapshot, withFamilyWrite } from '../db/transactions.js';
import { childFamilyId } from '../families/repository.js';
import { type DeletionEvent, type DeletionJournal, registerDeletion } from '../jobs/deletion-journal.js';
import { hideDeletedGrowth } from '../jobs/deletions.js';
import {
  decodeGrowthCursor,
  decodeMemoryCursor,
  encodeGrowthCursor,
  encodeMemoryCursor,
  listFamilyBooks,
  loadFamilyBook,
  loadMeasurement,
  loadMemory,
  loadObservation,
  mapMeasurement,
  mapMemory,
  mapObservation,
  type FamilyBookDto,
  type MeasurementDto,
  type MeasurementKind,
  type MeasurementMethod,
  type MemoryDto,
  type MemoryType,
  type ObservationDto,
  type ObservationValue,
} from './repository.js';

type Ack = { id: string; revision: number; changeSeq: number };

export type MemoryWriteInput = {
  id?: string;
  operationId: string;
  localDate: string;
  type: MemoryType;
  text: string;
  firstConfirmed: boolean;
  mediaIds: string[];
};

export type MemoryUpdateInput = Omit<MemoryWriteInput, 'id'> & { baseRevision: number };

export type MeasurementInput = {
  id: string;
  localDate: string;
  kind: MeasurementKind;
  value: number;
  unit: 'cm' | 'kg';
  method: MeasurementMethod;
  source: 'home' | 'clinic';
  operationId: string;
};

export type MeasurementUpdateInput = Omit<MeasurementInput, 'id'> & { baseRevision: number };

export type ObservationInput = {
  id: string;
  guideId: string;
  localDate: string;
  value: ObservationValue;
  note: string;
  operationId: string;
};

export type ObservationUpdateInput = Omit<ObservationInput, 'id'> & { baseRevision: number };

export type FamilyBookInput = {
  operationId: string;
  title: string;
  editionId: string | null;
  language: string;
  note: string;
};

export type FamilyBookUpdateInput = {
  operationId: string;
  baseRevision: number;
  note: string;
};

function localDateParts(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function familyTimezone(client: PoolClient, familyId: string): Promise<string> {
  const result = await client.query<{ timezone: string }>(
    'SELECT timezone FROM app.families WHERE id=$1 AND deleted_at IS NULL',
    [familyId],
  );
  if (!result.rows[0]) throw notFound();
  return result.rows[0].timezone;
}

async function assertDateAllowed(client: PoolClient, familyId: string, localDate: string): Promise<void> {
  const timezone = await familyTimezone(client, familyId);
  if (localDate > localDateParts(timezone)) {
    throw new AppError(422, 'INVALID_DATE', '日期不能在今天之后');
  }
}

async function requireChild(client: PoolClient, childId: string, familyId: string): Promise<void> {
  const child = await client.query(
    'SELECT 1 FROM app.children WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL',
    [childId, familyId],
  );
  if (!child.rowCount) throw notFound();
}

async function assertMediaBelongsToMemory(
  client: PoolClient,
  memoryId: string,
  familyId: string,
  mediaIds: string[],
): Promise<void> {
  if (!mediaIds.length) return;
  if (new Set(mediaIds).size !== mediaIds.length) {
    throw new AppError(400, 'INVALID_REQUEST', '输入格式不正确，请检查后重试');
  }
  const media = await client.query<{ count: string }>(`
    SELECT count(*) FROM app.media
    WHERE family_id=$1 AND memory_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL
  `, [familyId, memoryId, mediaIds]);
  if (Number(media.rows[0]?.count) !== mediaIds.length) {
    throw new AppError(422, 'INVALID_MEDIA', '媒体必须属于当前家庭且属于这条成长记录');
  }
}

async function memoryFamily(pool: Pool, memoryId: string, userId: string, includePermanent = false): Promise<string> {
  const result = await pool.query(`
    SELECT m.family_id
    FROM app.memories m
    JOIN app.family_members fm ON fm.family_id=m.family_id AND fm.user_id=$2 AND fm.active
    JOIN app.families f ON f.id=m.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=fm.user_id AND u.disabled_at IS NULL
    WHERE m.id=$1 AND ($3 OR m.permanently_deleted_at IS NULL)
  `, [memoryId, userId, includePermanent]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].family_id;
}

async function measurementFamily(pool: Pool, measurementId: string, userId: string): Promise<string> {
  const result = await pool.query(`
    SELECT x.family_id
    FROM app.measurements x
    JOIN app.family_members fm ON fm.family_id=x.family_id AND fm.user_id=$2 AND fm.active
    JOIN app.families f ON f.id=x.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=fm.user_id AND u.disabled_at IS NULL
    WHERE x.id=$1
  `, [measurementId, userId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].family_id;
}

async function observationFamily(pool: Pool, observationId: string, userId: string): Promise<string> {
  const result = await pool.query(`
    SELECT x.family_id
    FROM app.observations x
    JOIN app.family_members fm ON fm.family_id=x.family_id AND fm.user_id=$2 AND fm.active
    JOIN app.families f ON f.id=x.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=fm.user_id AND u.disabled_at IS NULL
    WHERE x.id=$1
  `, [observationId, userId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].family_id;
}

async function familyBookFamily(pool: Pool, bookId: string, userId: string): Promise<string> {
  const result = await pool.query(`
    SELECT fb.family_id
    FROM app.family_books fb
    JOIN app.family_members fm ON fm.family_id=fb.family_id AND fm.user_id=$2 AND fm.active
    JOIN app.families f ON f.id=fb.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=fm.user_id AND u.disabled_at IS NULL
    WHERE fb.id=$1
  `, [bookId, userId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].family_id;
}

function validateMemoryConfirmation(type: MemoryType, firstConfirmed: boolean): void {
  if (type === 'first' && !firstConfirmed) {
    throw new AppError(422, 'FIRST_CONFIRMATION_REQUIRED', '第一次记录需要家长明确确认');
  }
}

export async function createMemory(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  childId: string,
  input: MemoryWriteInput & { id: string },
): Promise<MemoryDto> {
  validateMemoryConfirmation(input.type, input.firstConfirmed);
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const result = await withFamilyWrite<MemoryDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'memory.create',
    request: { childId, ...input },
  }, async ({ client, appendChange }) => {
    await requireChild(client, childId, familyId);
    await assertDateAllowed(client, familyId, input.localDate);
    const existing = await client.query(`
      SELECT 1 FROM app.memories WHERE id=$1
      UNION ALL SELECT 1 FROM app.permanent_deletions WHERE kind='memory' AND resource_id=$1
    `, [input.id]);
    if (existing.rowCount) throw new AppError(409, 'ID_CONFLICT', '同一记录标识已被使用');
    if (input.mediaIds.length) {
      throw new AppError(422, 'INVALID_MEDIA', '媒体必须属于当前家庭且属于这条成长记录');
    }
    await client.query(`
      INSERT INTO app.memories(
        id,family_id,child_id,local_date,type,text,first_confirmed,added_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    `, [input.id, familyId, childId, input.localDate, input.type, input.text, input.firstConfirmed, actorUserId]);
    const memory = await loadMemory(client, input.id, familyId);
    if (!memory) throw notFound();
    await appendChange({
      entity: 'memory',
      id: memory.id,
      revision: memory.revision,
      deleted: false,
      payload: memory,
    });
    return { statusCode: 201, body: memory };
  });
  return result.body;
}

export async function listMemories(
  pool: Pool,
  actorUserId: string,
  childId: string,
  input: {
    cursor?: string | undefined;
    limit?: number | undefined;
    from?: string | undefined;
    to?: string | undefined;
    type?: MemoryType | undefined;
    deleted?: boolean | undefined;
  },
): Promise<{ items: MemoryDto[]; nextCursor: string | null }> {
  if (input.from && input.to && input.from > input.to) {
    throw new AppError(400, 'INVALID_REQUEST', '开始日期不能晚于结束日期');
  }
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const deleted = input.deleted ?? false;
  const type = input.type ?? null;
  const cursor = input.cursor
    ? decodeMemoryCursor(input.cursor, familyId, childId, deleted, type)
    : null;
  const limit = input.limit ?? 50;
  const snapshot = await withFamilySnapshot(pool, { familyId, actorUserId }, async client => {
    const values: unknown[] = [familyId, childId];
    const where = [
      'm.family_id=$1',
      'm.child_id=$2',
      'm.permanently_deleted_at IS NULL',
      deleted ? 'm.deleted_at IS NOT NULL' : 'm.deleted_at IS NULL',
    ];
    if (input.from) {
      values.push(input.from);
      where.push(`m.local_date >= $${values.length}`);
    }
    if (input.to) {
      values.push(input.to);
      where.push(`m.local_date <= $${values.length}`);
    }
    if (type) {
      values.push(type);
      where.push(`m.type=$${values.length}`);
    }
    if (cursor) {
      values.push(cursor.localDate, cursor.id);
      where.push(`(m.local_date < $${values.length - 1} OR (m.local_date=$${values.length - 1} AND m.id < $${values.length}))`);
    }
    values.push(limit + 1);
    const result = await client.query(`
      SELECT m.id,m.child_id,m.local_date,m.type,m.text,m.first_confirmed,
             COALESCE(
               ARRAY(
                 SELECT md.id::text FROM app.media md
                 WHERE md.memory_id=m.id AND md.family_id=m.family_id AND md.deleted_at IS NULL
                 ORDER BY md.created_at,md.id
               ),
               ARRAY[]::text[]
             ) AS media_ids,
             m.added_by,m.revision,m.deleted_at
      FROM app.memories m
      WHERE ${where.join(' AND ')}
      ORDER BY m.local_date DESC,m.id DESC
      LIMIT $${values.length}
    `, values);
    const page = result.rows.slice(0, limit).map(mapMemory);
    return { page, hasMore: result.rows.length > limit };
  });
  const last = snapshot.data.page[snapshot.data.page.length - 1];
  return {
    items: snapshot.data.page,
    nextCursor: snapshot.data.hasMore && last
      ? encodeMemoryCursor({ familyId, childId, localDate: last.localDate, id: last.id, deleted, type })
      : null,
  };
}

export async function updateMemory(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  memoryId: string,
  input: MemoryUpdateInput,
): Promise<MemoryDto> {
  validateMemoryConfirmation(input.type, input.firstConfirmed);
  const familyId = await memoryFamily(pool, memoryId, actorUserId);
  const result = await withFamilyWrite<MemoryDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'memory.update',
    request: { memoryId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await loadMemory(client, memoryId, familyId);
    if (!current) throw notFound();
    if (current.revision !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '成长记录已被其他家长更新', {
        current: current.revision,
        submitted: input.baseRevision,
      });
    }
    await assertDateAllowed(client, familyId, input.localDate);
    await assertMediaBelongsToMemory(client, memoryId, familyId, input.mediaIds);
    await client.query(`
      UPDATE app.memories
      SET local_date=$2,type=$3,text=$4,first_confirmed=$5,revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$6 AND deleted_at IS NULL
    `, [memoryId, input.localDate, input.type, input.text, input.firstConfirmed, familyId]);
    const memory = await loadMemory(client, memoryId, familyId);
    if (!memory) throw notFound();
    await appendChange({
      entity: 'memory',
      id: memory.id,
      revision: memory.revision,
      deleted: false,
      payload: memory,
    });
    return { statusCode: 200, body: memory };
  });
  return result.body;
}

export async function deleteMemory(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  memoryId: string,
  input: { operationId: string; baseRevision: number; permanent: boolean },
  journal: DeletionJournal | null,
  onDeletion: (event: DeletionEvent) => void,
): Promise<Ack> {
  const familyId = await memoryFamily(pool, memoryId, actorUserId, true);
  let event: DeletionEvent | undefined;
  const result = await withFamilyWrite<Ack>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'memory.delete',
    request: { memoryId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number }>(`
      SELECT revision FROM app.memories
      WHERE id=$1 AND family_id=$2 AND ($3 OR deleted_at IS NULL) AND permanently_deleted_at IS NULL
      FOR UPDATE
    `, [memoryId, familyId, input.permanent]);
    const row = current.rows[0];
    if (!row) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '成长记录已被其他家长更新', {
        current: Number(row.revision),
        submitted: input.baseRevision,
      });
    }
    if (input.permanent) {
      event = await registerDeletion(client, journal, {
        kind: 'memory', id: memoryId, familyId, memoryId: null,
      });
      const { revision, changeSeq } = await hideDeletedGrowth(client, event);
      return { statusCode: 200, body: { id: memoryId, revision, changeSeq } };
    }
    const revision = Number(row.revision) + 1;
    await client.query(`
      UPDATE app.memories
      SET deleted_at=now(),revision=$2,updated_at=now()
      WHERE id=$1
    `, [memoryId, revision]);
    const changeSeq = await appendChange({
      entity: 'memory',
      id: memoryId,
      revision,
      deleted: true,
      payload: null,
    });
    return { statusCode: 200, body: { id: memoryId, revision, changeSeq } };
  });
  if (event) onDeletion(event);
  return result.body;
}

export async function restoreMemory(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  memoryId: string,
  input: { operationId: string; baseRevision: number },
): Promise<MemoryDto> {
  const familyId = await memoryFamily(pool, memoryId, actorUserId);
  const result = await withFamilyWrite<MemoryDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'memory.restore',
    request: { memoryId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number; deleted_at: Date; permanently_deleted_at: Date | null }>(`
      SELECT revision,deleted_at,permanently_deleted_at FROM app.memories
      WHERE id=$1 AND family_id=$2 FOR UPDATE
    `, [memoryId, familyId]);
    const row = current.rows[0];
    if (!row || !row.deleted_at || row.permanently_deleted_at) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '成长记录已被其他家长更新', {
        current: Number(row.revision),
        submitted: input.baseRevision,
      });
    }
    if (row.deleted_at.getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000) {
      throw new AppError(422, 'RESTORE_WINDOW_EXPIRED', '该成长记录已超过可恢复期限');
    }
    await client.query(`
      UPDATE app.memories SET deleted_at=NULL,revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$2
    `, [memoryId, familyId]);
    const memory = await loadMemory(client, memoryId, familyId);
    if (!memory) throw notFound();
    await appendChange({
      entity: 'memory',
      id: memory.id,
      revision: memory.revision,
      deleted: false,
      payload: memory,
    });
    return { statusCode: 200, body: memory };
  });
  return result.body;
}

function validateMeasurementInput(
  kind: MeasurementKind,
  unit: 'cm' | 'kg',
  method: MeasurementMethod,
): void {
  const valid = (kind === 'height' && unit === 'cm' && ['recumbent', 'standing'].includes(method))
    || (kind === 'weight' && unit === 'kg' && method === 'scale');
  if (!valid) {
    throw new AppError(422, 'INVALID_MEASUREMENT', '测量类型、单位和方法的组合不正确');
  }
}

export async function createMeasurement(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  childId: string,
  input: MeasurementInput,
): Promise<MeasurementDto> {
  validateMeasurementInput(input.kind, input.unit, input.method);
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const result = await withFamilyWrite<MeasurementDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'measurement.create',
    request: { childId, ...input },
  }, async ({ client, appendChange }) => {
    await requireChild(client, childId, familyId);
    await assertDateAllowed(client, familyId, input.localDate);
    const duplicate = await client.query('SELECT 1 FROM app.measurements WHERE id=$1', [input.id]);
    if (duplicate.rowCount) throw new AppError(409, 'ID_CONFLICT', '同一记录标识已被使用');
    await client.query(`
      INSERT INTO app.measurements(
        id,family_id,child_id,local_date,kind,value,unit,method,source,added_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      input.id,
      familyId,
      childId,
      input.localDate,
      input.kind,
      input.value,
      input.unit,
      input.method,
      input.source,
      actorUserId,
    ]);
    const measurement = await loadMeasurement(client, input.id, familyId);
    if (!measurement) throw notFound();
    await appendChange({
      entity: 'measurement',
      id: measurement.id,
      revision: measurement.revision,
      deleted: false,
      payload: measurement,
    });
    return { statusCode: 201, body: measurement };
  });
  return result.body;
}

export async function listMeasurements(
  pool: Pool,
  actorUserId: string,
  childId: string,
  input: {
    cursor?: string | undefined;
    limit?: number | undefined;
    from?: string | undefined;
    to?: string | undefined;
    deleted?: boolean | undefined;
  },
): Promise<{ items: MeasurementDto[]; nextCursor: string | null }> {
  if (input.from && input.to && input.from > input.to) {
    throw new AppError(400, 'INVALID_REQUEST', '开始日期不能晚于结束日期');
  }
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const deleted = input.deleted ?? false;
  const cursor = input.cursor
    ? decodeGrowthCursor('measurements', input.cursor, familyId, childId, deleted)
    : null;
  const limit = input.limit ?? 50;
  const snapshot = await withFamilySnapshot(pool, { familyId, actorUserId }, async client => {
    const values: unknown[] = [familyId, childId];
    const where = [
      'family_id=$1',
      'child_id=$2',
      deleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL',
    ];
    if (input.from) {
      values.push(input.from);
      where.push(`local_date >= $${values.length}`);
    }
    if (input.to) {
      values.push(input.to);
      where.push(`local_date <= $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.localDate, cursor.id);
      where.push(`(local_date < $${values.length - 1} OR (local_date=$${values.length - 1} AND id < $${values.length}))`);
    }
    values.push(limit + 1);
    const result = await client.query(`
      SELECT id,child_id,local_date,kind,value,unit,method,source,revision,deleted_at
      FROM app.measurements
      WHERE ${where.join(' AND ')}
      ORDER BY local_date DESC,id DESC
      LIMIT $${values.length}
    `, values);
    return {
      page: result.rows.slice(0, limit).map(mapMeasurement),
      hasMore: result.rows.length > limit,
    };
  });
  const last = snapshot.data.page[snapshot.data.page.length - 1];
  return {
    items: snapshot.data.page,
    nextCursor: snapshot.data.hasMore && last
      ? encodeGrowthCursor('measurements', { familyId, childId, localDate: last.localDate, id: last.id, deleted })
      : null,
  };
}

export async function updateMeasurement(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  measurementId: string,
  input: MeasurementUpdateInput,
): Promise<MeasurementDto> {
  validateMeasurementInput(input.kind, input.unit, input.method);
  const familyId = await measurementFamily(pool, measurementId, actorUserId);
  const result = await withFamilyWrite<MeasurementDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'measurement.update',
    request: { measurementId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await loadMeasurement(client, measurementId, familyId);
    if (!current) throw notFound();
    if (current.revision !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '测量记录已被其他家长更新', {
        current: current.revision,
        submitted: input.baseRevision,
      });
    }
    await assertDateAllowed(client, familyId, input.localDate);
    await client.query(`
      UPDATE app.measurements
      SET local_date=$2,kind=$3,value=$4,unit=$5,method=$6,source=$7,
          revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$8 AND deleted_at IS NULL
    `, [
      measurementId,
      input.localDate,
      input.kind,
      input.value,
      input.unit,
      input.method,
      input.source,
      familyId,
    ]);
    const measurement = await loadMeasurement(client, measurementId, familyId);
    if (!measurement) throw notFound();
    await appendChange({
      entity: 'measurement',
      id: measurement.id,
      revision: measurement.revision,
      deleted: false,
      payload: measurement,
    });
    return { statusCode: 200, body: measurement };
  });
  return result.body;
}

export async function deleteMeasurement(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  measurementId: string,
  input: { operationId: string; baseRevision: number },
): Promise<Ack> {
  const familyId = await measurementFamily(pool, measurementId, actorUserId);
  const result = await withFamilyWrite<Ack>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'measurement.delete',
    request: { measurementId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number }>(`
      SELECT revision FROM app.measurements
      WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL FOR UPDATE
    `, [measurementId, familyId]);
    const row = current.rows[0];
    if (!row) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '测量记录已被其他家长更新', {
        current: Number(row.revision),
        submitted: input.baseRevision,
      });
    }
    const revision = Number(row.revision) + 1;
    await client.query(`
      UPDATE app.measurements SET deleted_at=now(),revision=$2,updated_at=now() WHERE id=$1
    `, [measurementId, revision]);
    const changeSeq = await appendChange({
      entity: 'measurement',
      id: measurementId,
      revision,
      deleted: true,
      payload: null,
    });
    return { statusCode: 200, body: { id: measurementId, revision, changeSeq } };
  });
  return result.body;
}

export async function restoreMeasurement(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  measurementId: string,
  input: { operationId: string; baseRevision: number },
): Promise<MeasurementDto> {
  const familyId = await measurementFamily(pool, measurementId, actorUserId);
  const result = await withFamilyWrite<MeasurementDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'measurement.restore',
    request: { measurementId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number; deleted_at: Date | string | null }>(`
      SELECT revision,deleted_at FROM app.measurements
      WHERE id=$1 AND family_id=$2 FOR UPDATE
    `, [measurementId, familyId]);
    const row = current.rows[0];
    if (!row || !row.deleted_at) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '测量记录已被其他家长更新', {
        current: Number(row.revision),
        submitted: input.baseRevision,
      });
    }
    if (new Date(row.deleted_at).getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000) {
      throw new AppError(422, 'RESTORE_WINDOW_EXPIRED', '该测量记录已超过可恢复期限');
    }
    await client.query(`
      UPDATE app.measurements SET deleted_at=NULL,revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$2
    `, [measurementId, familyId]);
    const measurement = await loadMeasurement(client, measurementId, familyId);
    if (!measurement) throw notFound();
    await appendChange({
      entity: 'measurement',
      id: measurement.id,
      revision: measurement.revision,
      deleted: false,
      payload: measurement,
    });
    return { statusCode: 200, body: measurement };
  });
  return result.body;
}

export async function createObservation(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  childId: string,
  input: ObservationInput,
): Promise<ObservationDto> {
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const result = await withFamilyWrite<ObservationDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'observation.create',
    request: { childId, ...input },
  }, async ({ client, appendChange }) => {
    await requireChild(client, childId, familyId);
    await assertDateAllowed(client, familyId, input.localDate);
    const duplicate = await client.query('SELECT 1 FROM app.observations WHERE id=$1', [input.id]);
    if (duplicate.rowCount) throw new AppError(409, 'ID_CONFLICT', '同一记录标识已被使用');
    await client.query(`
      INSERT INTO app.observations(
        id,family_id,child_id,guide_id,local_date,value,note,added_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    `, [input.id, familyId, childId, input.guideId, input.localDate, input.value, input.note, actorUserId]);
    const observation = await loadObservation(client, input.id, familyId);
    if (!observation) throw notFound();
    await appendChange({
      entity: 'observation',
      id: observation.id,
      revision: observation.revision,
      deleted: false,
      payload: observation,
    });
    return { statusCode: 201, body: observation };
  });
  return result.body;
}

export async function listObservations(
  pool: Pool,
  actorUserId: string,
  childId: string,
  input: {
    cursor?: string | undefined;
    limit?: number | undefined;
    from?: string | undefined;
    to?: string | undefined;
    deleted?: boolean | undefined;
  },
): Promise<{ items: ObservationDto[]; nextCursor: string | null }> {
  if (input.from && input.to && input.from > input.to) {
    throw new AppError(400, 'INVALID_REQUEST', '开始日期不能晚于结束日期');
  }
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const deleted = input.deleted ?? false;
  const cursor = input.cursor
    ? decodeGrowthCursor('observations', input.cursor, familyId, childId, deleted)
    : null;
  const limit = input.limit ?? 50;
  const snapshot = await withFamilySnapshot(pool, { familyId, actorUserId }, async client => {
    const values: unknown[] = [familyId, childId];
    const where = [
      'family_id=$1',
      'child_id=$2',
      deleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL',
    ];
    if (input.from) {
      values.push(input.from);
      where.push(`local_date >= $${values.length}`);
    }
    if (input.to) {
      values.push(input.to);
      where.push(`local_date <= $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.localDate, cursor.id);
      where.push(`(local_date < $${values.length - 1} OR (local_date=$${values.length - 1} AND id < $${values.length}))`);
    }
    values.push(limit + 1);
    const result = await client.query(`
      SELECT id,guide_id,child_id,local_date,value,note,revision,deleted_at
      FROM app.observations
      WHERE ${where.join(' AND ')}
      ORDER BY local_date DESC,id DESC
      LIMIT $${values.length}
    `, values);
    return {
      page: result.rows.slice(0, limit).map(mapObservation),
      hasMore: result.rows.length > limit,
    };
  });
  const last = snapshot.data.page[snapshot.data.page.length - 1];
  return {
    items: snapshot.data.page,
    nextCursor: snapshot.data.hasMore && last
      ? encodeGrowthCursor('observations', { familyId, childId, localDate: last.localDate, id: last.id, deleted })
      : null,
  };
}

export async function updateObservation(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  observationId: string,
  input: ObservationUpdateInput,
): Promise<ObservationDto> {
  const familyId = await observationFamily(pool, observationId, actorUserId);
  const result = await withFamilyWrite<ObservationDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'observation.update',
    request: { observationId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await loadObservation(client, observationId, familyId);
    if (!current) throw notFound();
    if (current.revision !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '阶段观察已被其他家长更新', {
        current: current.revision,
        submitted: input.baseRevision,
      });
    }
    await assertDateAllowed(client, familyId, input.localDate);
    await client.query(`
      UPDATE app.observations
      SET guide_id=$2,local_date=$3,value=$4,note=$5,revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$6 AND deleted_at IS NULL
    `, [observationId, input.guideId, input.localDate, input.value, input.note, familyId]);
    const observation = await loadObservation(client, observationId, familyId);
    if (!observation) throw notFound();
    await appendChange({
      entity: 'observation',
      id: observation.id,
      revision: observation.revision,
      deleted: false,
      payload: observation,
    });
    return { statusCode: 200, body: observation };
  });
  return result.body;
}

export async function deleteObservation(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  observationId: string,
  input: { operationId: string; baseRevision: number },
): Promise<Ack> {
  const familyId = await observationFamily(pool, observationId, actorUserId);
  const result = await withFamilyWrite<Ack>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'observation.delete',
    request: { observationId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number }>(`
      SELECT revision FROM app.observations
      WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL FOR UPDATE
    `, [observationId, familyId]);
    const row = current.rows[0];
    if (!row) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '阶段观察已被其他家长更新', {
        current: Number(row.revision),
        submitted: input.baseRevision,
      });
    }
    const revision = Number(row.revision) + 1;
    await client.query(`
      UPDATE app.observations SET deleted_at=now(),revision=$2,updated_at=now() WHERE id=$1
    `, [observationId, revision]);
    const changeSeq = await appendChange({
      entity: 'observation',
      id: observationId,
      revision,
      deleted: true,
      payload: null,
    });
    return { statusCode: 200, body: { id: observationId, revision, changeSeq } };
  });
  return result.body;
}

export async function restoreObservation(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  observationId: string,
  input: { operationId: string; baseRevision: number },
): Promise<ObservationDto> {
  const familyId = await observationFamily(pool, observationId, actorUserId);
  const result = await withFamilyWrite<ObservationDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'observation.restore',
    request: { observationId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number; deleted_at: Date | string | null }>(`
      SELECT revision,deleted_at FROM app.observations
      WHERE id=$1 AND family_id=$2 FOR UPDATE
    `, [observationId, familyId]);
    const row = current.rows[0];
    if (!row || !row.deleted_at) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '阶段观察已被其他家长更新', {
        current: Number(row.revision),
        submitted: input.baseRevision,
      });
    }
    if (new Date(row.deleted_at).getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000) {
      throw new AppError(422, 'RESTORE_WINDOW_EXPIRED', '该阶段观察已超过可恢复期限');
    }
    await client.query(`
      UPDATE app.observations SET deleted_at=NULL,revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$2
    `, [observationId, familyId]);
    const observation = await loadObservation(client, observationId, familyId);
    if (!observation) throw notFound();
    await appendChange({
      entity: 'observation',
      id: observation.id,
      revision: observation.revision,
      deleted: false,
      payload: observation,
    });
    return { statusCode: 200, body: observation };
  });
  return result.body;
}

export async function getFamilyBooks(
  pool: Pool,
  actorUserId: string,
  familyId: string,
): Promise<{ books: FamilyBookDto[] }> {
  const snapshot = await withFamilySnapshot(pool, { familyId, actorUserId }, client => listFamilyBooks(client, familyId));
  return { books: snapshot.data };
}

export async function createFamilyBook(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  familyId: string,
  input: FamilyBookInput,
): Promise<FamilyBookDto> {
  const result = await withFamilyWrite<FamilyBookDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'family_book.create',
    request: input,
  }, async ({ client, appendChange }) => {
    let bookId: string | null = null;
    if (input.editionId) {
      const edition = await client.query<{ book_id: string }>(
        'SELECT book_id FROM app.book_editions WHERE id=$1',
        [input.editionId],
      );
      if (!edition.rows[0]) throw new AppError(422, 'INVALID_EDITION', '书目版本不存在');
      bookId = edition.rows[0].book_id;
    }
    const id = randomUUID();
    await client.query(`
      INSERT INTO app.family_books(
        id,family_id,book_id,edition_id,title,language,note,added_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    `, [id, familyId, bookId, input.editionId, input.title, input.language, input.note, actorUserId]);
    const book = await loadFamilyBook(client, id, familyId);
    if (!book) throw notFound();
    await appendChange({
      entity: 'family_book',
      id: book.id,
      revision: book.revision,
      deleted: false,
      payload: book,
    });
    return { statusCode: 201, body: book };
  });
  return result.body;
}

export async function updateFamilyBook(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  bookId: string,
  input: FamilyBookUpdateInput,
): Promise<FamilyBookDto> {
  const familyId = await familyBookFamily(pool, bookId, actorUserId);
  const result = await withFamilyWrite<FamilyBookDto>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'family_book.update',
    request: { bookId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await loadFamilyBook(client, bookId, familyId);
    if (!current) throw notFound();
    if (current.revision !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '家庭书架条目已被其他家长更新', {
        current: current.revision,
        submitted: input.baseRevision,
      });
    }
    await client.query(`
      UPDATE app.family_books
      SET note=$2,revision=revision+1,updated_at=now()
      WHERE id=$1 AND family_id=$3 AND deleted_at IS NULL
    `, [bookId, input.note, familyId]);
    const book = await loadFamilyBook(client, bookId, familyId);
    if (!book) throw notFound();
    await appendChange({
      entity: 'family_book',
      id: book.id,
      revision: book.revision,
      deleted: false,
      payload: book,
    });
    return { statusCode: 200, body: book };
  });
  return result.body;
}

export async function deleteFamilyBook(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  bookId: string,
  input: { operationId: string; baseRevision: number },
): Promise<Ack> {
  const familyId = await familyBookFamily(pool, bookId, actorUserId);
  const result = await withFamilyWrite<Ack>(pool, {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId,
    action: 'family_book.delete',
    request: { bookId, ...input },
  }, async ({ client, appendChange }) => {
    const current = await client.query<{ revision: number }>(`
      SELECT revision FROM app.family_books
      WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL FOR UPDATE
    `, [bookId, familyId]);
    const row = current.rows[0];
    if (!row) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '家庭书架条目已被其他家长更新', {
        current: Number(row.revision),
        submitted: input.baseRevision,
      });
    }
    const revision = Number(row.revision) + 1;
    await client.query(`
      UPDATE app.family_books SET deleted_at=now(),revision=$2,updated_at=now() WHERE id=$1
    `, [bookId, revision]);
    const changeSeq = await appendChange({
      entity: 'family_book',
      id: bookId,
      revision,
      deleted: true,
      payload: null,
    });
    return { statusCode: 200, body: { id: bookId, revision, changeSeq } };
  });
  return result.body;
}

