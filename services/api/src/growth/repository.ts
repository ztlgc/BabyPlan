import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { dateValue } from '../families/repository.js';

export type MemoryType = 'quote' | 'story' | 'first';
export type MeasurementKind = 'height' | 'weight';
export type MeasurementUnit = 'cm' | 'kg';
export type MeasurementMethod = 'recumbent' | 'standing' | 'scale';
export type MeasurementSource = 'home' | 'clinic';
export type ObservationValue = 'noticed' | 'not_yet_observed' | 'discuss';

export type MemoryDto = {
  id: string;
  childId: string;
  localDate: string;
  type: MemoryType;
  text: string;
  firstConfirmed: boolean;
  mediaIds: string[];
  addedBy: string;
  revision: number;
  deletedAt: string | null;
};

export type MeasurementDto = {
  id: string;
  childId: string;
  localDate: string;
  kind: MeasurementKind;
  value: number;
  unit: MeasurementUnit;
  method: MeasurementMethod;
  source: MeasurementSource;
  revision: number;
  deletedAt: string | null;
};

export type ObservationDto = {
  id: string;
  guideId: string;
  childId: string;
  localDate: string;
  value: ObservationValue;
  note: string;
  revision: number;
  deletedAt: string | null;
};

export type FamilyBookDto = {
  id: string;
  familyId: string;
  title: string;
  editionId: string | null;
  editionStatus: 'unverified' | 'verified';
  language: string;
  note: string;
  revision: number;
};

type MemoryRow = {
  id: string;
  child_id: string;
  local_date: string | Date;
  type: MemoryType;
  text: string;
  first_confirmed: boolean;
  media_ids: string[];
  added_by: string;
  revision: string | number;
  deleted_at: string | Date | null;
};

export function mapMemory(row: Record<string, unknown>): MemoryDto {
  return {
    id: String(row.id),
    childId: String(row.child_id),
    localDate: dateValue(row.local_date as string | Date)!,
    type: row.type as MemoryType,
    text: String(row.text),
    firstConfirmed: Boolean(row.first_confirmed),
    mediaIds: (row.media_ids as string[] | null) ?? [],
    addedBy: String(row.added_by),
    revision: Number(row.revision),
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string | Date).toISOString() : null,
  };
}

export function mapMeasurement(row: Record<string, unknown>): MeasurementDto {
  return {
    id: String(row.id),
    childId: String(row.child_id),
    localDate: dateValue(row.local_date as string | Date)!,
    kind: row.kind as MeasurementKind,
    value: Number(row.value),
    unit: row.unit as MeasurementUnit,
    method: row.method as MeasurementMethod,
    source: row.source as MeasurementSource,
    revision: Number(row.revision),
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string | Date).toISOString() : null,
  };
}

export function mapObservation(row: Record<string, unknown>): ObservationDto {
  return {
    id: String(row.id),
    guideId: String(row.guide_id),
    childId: String(row.child_id),
    localDate: dateValue(row.local_date as string | Date)!,
    value: row.value as ObservationValue,
    note: String(row.note),
    revision: Number(row.revision),
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string | Date).toISOString() : null,
  };
}

export function mapFamilyBook(row: Record<string, unknown>): FamilyBookDto {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    title: String(row.title),
    editionId: row.edition_id ? String(row.edition_id) : null,
    editionStatus: row.edition_id && row.edition_verified ? 'verified' : 'unverified',
    language: String(row.language),
    note: String(row.note),
    revision: Number(row.revision),
  };
}

const memorySelect = `
  SELECT m.id,m.child_id,m.local_date,m.type,m.text,m.first_confirmed,
         COALESCE(
           ARRAY(
             SELECT md.id::text
             FROM app.media md
             WHERE md.memory_id=m.id AND md.family_id=m.family_id AND md.deleted_at IS NULL
             ORDER BY md.created_at,md.id
           ),
           ARRAY[]::text[]
         ) AS media_ids,
         m.added_by,m.revision,m.deleted_at
  FROM app.memories m
`;

export async function loadMemory(
  client: PoolClient,
  memoryId: string,
  familyId: string,
  includeDeleted = false,
): Promise<MemoryDto | null> {
  const result = await client.query<MemoryRow>(`
    ${memorySelect}
    WHERE m.id=$1 AND m.family_id=$2
      AND m.permanently_deleted_at IS NULL
      ${includeDeleted ? '' : 'AND m.deleted_at IS NULL'}
  `, [memoryId, familyId]);
  return result.rows[0] ? mapMemory(result.rows[0]) : null;
}

export async function loadMeasurement(
  client: PoolClient,
  measurementId: string,
  familyId: string,
  includeDeleted = false,
): Promise<MeasurementDto | null> {
  const result = await client.query(`
    SELECT id,child_id,local_date,kind,value,unit,method,source,revision,deleted_at
    FROM app.measurements
    WHERE id=$1 AND family_id=$2 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `, [measurementId, familyId]);
  return result.rows[0] ? mapMeasurement(result.rows[0]) : null;
}

export async function loadObservation(
  client: PoolClient,
  observationId: string,
  familyId: string,
  includeDeleted = false,
): Promise<ObservationDto | null> {
  const result = await client.query(`
    SELECT id,guide_id,child_id,local_date,value,note,revision,deleted_at
    FROM app.observations
    WHERE id=$1 AND family_id=$2 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `, [observationId, familyId]);
  return result.rows[0] ? mapObservation(result.rows[0]) : null;
}

const familyBookSelect = `
  SELECT fb.id,fb.family_id,fb.title,fb.edition_id,fb.language,fb.note,fb.revision,
         COALESCE(be.verified,false) AS edition_verified
  FROM app.family_books fb
  LEFT JOIN app.book_editions be ON be.id=fb.edition_id
`;

export async function loadFamilyBook(
  client: PoolClient,
  bookId: string,
  familyId: string,
  includeDeleted = false,
): Promise<FamilyBookDto | null> {
  const result = await client.query(`
    ${familyBookSelect}
    WHERE fb.id=$1 AND fb.family_id=$2 ${includeDeleted ? '' : 'AND fb.deleted_at IS NULL'}
  `, [bookId, familyId]);
  return result.rows[0] ? mapFamilyBook(result.rows[0]) : null;
}

export async function listFamilyMemories(client: PoolClient, familyId: string, childId?: string): Promise<MemoryDto[]> {
  const result = await client.query<MemoryRow>(`
    ${memorySelect}
    WHERE m.family_id=$1 AND m.deleted_at IS NULL
      ${childId ? 'AND m.child_id=$2' : ''}
    ORDER BY m.local_date,m.created_at,m.id
  `, childId ? [familyId, childId] : [familyId]);
  return result.rows.map(mapMemory);
}

export async function listFamilyMeasurements(client: PoolClient, familyId: string, childId?: string): Promise<MeasurementDto[]> {
  const result = await client.query(`
    SELECT id,child_id,local_date,kind,value,unit,method,source,revision,deleted_at
    FROM app.measurements
    WHERE family_id=$1 AND deleted_at IS NULL ${childId ? 'AND child_id=$2' : ''}
    ORDER BY local_date,created_at,id
  `, childId ? [familyId, childId] : [familyId]);
  return result.rows.map(mapMeasurement);
}

export async function listFamilyObservations(client: PoolClient, familyId: string, childId?: string): Promise<ObservationDto[]> {
  const result = await client.query(`
    SELECT id,guide_id,child_id,local_date,value,note,revision,deleted_at
    FROM app.observations
    WHERE family_id=$1 AND deleted_at IS NULL ${childId ? 'AND child_id=$2' : ''}
    ORDER BY local_date,created_at,id
  `, childId ? [familyId, childId] : [familyId]);
  return result.rows.map(mapObservation);
}

export async function listFamilyBooks(client: PoolClient, familyId: string, limit: number | null = 1000): Promise<FamilyBookDto[]> {
  const result = await client.query(`
    ${familyBookSelect}
    WHERE fb.family_id=$1 AND fb.deleted_at IS NULL
    ORDER BY fb.created_at,fb.id
    LIMIT $2
  `, [familyId, limit]);
  return result.rows.map(mapFamilyBook);
}

export async function listFamilyMedia(client: PoolClient, familyId: string): Promise<Array<{
  id: string;
  memoryId: string;
  state: 'pending' | 'processing' | 'ready' | 'failed' | 'deleted';
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  byteSize: number;
  sha256: string;
  downloadUrl: string | null;
  expiresAt: string | null;
}>> {
  const result = await client.query(`
    SELECT md.id,md.memory_id,md.state,md.mime,md.byte_size,md.sha256
    FROM app.media md
    JOIN app.memories m ON m.id=md.memory_id AND m.family_id=md.family_id
    WHERE md.family_id=$1 AND md.deleted_at IS NULL AND m.deleted_at IS NULL
    ORDER BY md.created_at,md.id
  `, [familyId]);
  return result.rows.map(row => ({
    id: row.id,
    memoryId: row.memory_id,
    state: row.state,
    mime: row.mime,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    downloadUrl: null,
    expiresAt: null,
  }));
}

export type MemoryListCursor = {
  familyId: string;
  childId: string;
  localDate: string;
  id: string;
  deleted: boolean;
  type: MemoryType | null;
};

export function encodeMemoryCursor(value: MemoryListCursor): string {
  return Buffer.from(JSON.stringify({ ...value, kind: 'memories' }), 'utf8').toString('base64url');
}

export function decodeMemoryCursor(
  cursor: string,
  familyId: string,
  childId: string,
  deleted: boolean,
  type: MemoryType | null,
): MemoryListCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<MemoryListCursor> & { kind?: unknown };
    if (
      value.kind !== 'memories'
      || value.familyId !== familyId
      || value.childId !== childId
      || value.deleted !== deleted
      || (value.type ?? null) !== type
      || typeof value.localDate !== 'string'
      || typeof value.id !== 'string'
    ) throw new Error();
    return value as MemoryListCursor;
  } catch {
    throw new AppError(400, 'INVALID_REQUEST', '分页游标无效');
  }
}

export type GrowthListCursor = {
  familyId: string;
  childId: string;
  localDate: string;
  id: string;
  deleted: boolean;
};

export function encodeGrowthCursor(kind: 'measurements' | 'observations', value: GrowthListCursor): string {
  return Buffer.from(JSON.stringify({ ...value, kind }), 'utf8').toString('base64url');
}

export function decodeGrowthCursor(
  kind: 'measurements' | 'observations',
  cursor: string,
  familyId: string,
  childId: string,
  deleted: boolean,
): GrowthListCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<GrowthListCursor> & { kind?: unknown };
    if (
      value.kind !== kind
      || value.familyId !== familyId
      || value.childId !== childId
      || value.deleted !== deleted
      || typeof value.localDate !== 'string'
      || typeof value.id !== 'string'
    ) throw new Error();
    return value as GrowthListCursor;
  } catch {
    throw new AppError(400, 'INVALID_REQUEST', '分页游标无效');
  }
}
