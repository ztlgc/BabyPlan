import type { Pool, PoolClient } from 'pg';
import { notFound } from '../errors.js';

type Queryable = Pool | PoolClient;

export type MemberDto = {
  userId: string;
  role: 'owner' | 'caregiver';
  active: boolean;
  displayName: string | null;
  familyId: string;
  revision: number;
};

export type FamilyDto = {
  id: string;
  name: string;
  timezone: string;
  members: MemberDto[];
  revision: number;
};

export type ChildDto = {
  id: string;
  familyId: string;
  displayName: string | null;
  ageMode: 'months' | 'birthDate';
  ageMonths: number | null;
  ageAsOf: string | null;
  birthDate: string | null;
  revision: number;
};

export function dateValue(value: string | Date | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function mapChild(row: Record<string, unknown>): ChildDto {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    displayName: row.display_name as string | null,
    ageMode: row.age_mode as 'months' | 'birthDate',
    ageMonths: row.age_months === null ? null : Number(row.age_months),
    ageAsOf: dateValue(row.age_as_of as string | Date | null),
    birthDate: dateValue(row.birth_date as string | Date | null),
    revision: Number(row.revision),
  };
}

export async function getFamily(queryable: Queryable, familyId: string): Promise<FamilyDto> {
  const family = await queryable.query(`
    SELECT id,name,timezone,revision FROM app.families WHERE id=$1 AND deleted_at IS NULL
  `, [familyId]);
  const row = family.rows[0];
  if (!row) throw notFound();
  const members = await queryable.query(`
    SELECT m.user_id,m.role,m.active,u.display_name,m.family_id,m.revision
    FROM app.family_members m
    JOIN app.users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE m.family_id=$1 AND m.active
    ORDER BY m.joined_at,m.user_id
  `, [familyId]);
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    members: members.rows.map(member => ({
      userId: member.user_id,
      role: member.role,
      active: member.active,
      displayName: member.display_name,
      familyId: member.family_id,
      revision: Number(member.revision),
    })),
    revision: Number(row.revision),
  };
}

export async function listFamiliesForUser(pool: Pool, userId: string): Promise<FamilyDto[]> {
  const families = await pool.query(`
    SELECT f.id FROM app.families f
    JOIN app.family_members m ON m.family_id=f.id AND m.user_id=$1 AND m.active
    WHERE f.deleted_at IS NULL
    ORDER BY f.created_at
  `, [userId]);
  return Promise.all(families.rows.map(row => getFamily(pool, row.id)));
}

export async function listChildrenForUser(pool: Pool, userId: string): Promise<ChildDto[]> {
  const children = await pool.query(`
    SELECT c.* FROM app.children c
    JOIN app.family_members m ON m.family_id=c.family_id AND m.user_id=$1 AND m.active
    JOIN app.families f ON f.id=c.family_id AND f.deleted_at IS NULL
    WHERE c.deleted_at IS NULL
    ORDER BY c.created_at
  `, [userId]);
  return children.rows.map(mapChild);
}

export async function childFamilyId(queryable: Queryable, childId: string, userId: string): Promise<string> {
  const result = await queryable.query(`
    SELECT c.family_id
    FROM app.children c
    JOIN app.family_members m ON m.family_id=c.family_id AND m.user_id=$2 AND m.active
    JOIN app.families f ON f.id=c.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE c.id=$1 AND c.deleted_at IS NULL
  `, [childId, userId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0].family_id;
}

export async function activeFamilyRole(
  queryable: Queryable,
  familyId: string,
  userId: string,
): Promise<'owner' | 'caregiver' | null> {
  const result = await queryable.query<{ role: 'owner' | 'caregiver' }>(`
    SELECT m.role
    FROM app.family_members m
    JOIN app.families f ON f.id=m.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE m.family_id=$1 AND m.user_id=$2 AND m.active
  `, [familyId, userId]);
  return result.rows[0]?.role ?? null;
}
