import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError, notFound } from '../errors.js';

export type FamilyIdentity = { familyId: string; actorUserId: string };
export type FamilyOperation = FamilyIdentity & { operationId: string; deviceId: string; action: string; request: unknown };
export type UserOperation = { actorUserId: string; operationId: string; action: string; request: unknown };
export type OperationResult<T> = { statusCode: number; body: T };
export type ChangeInput = { entity: string; id: string; revision: number; deleted: boolean; payload: unknown | null };
export type FamilyWriteContext = { client: PoolClient; familyId: string; actorUserId: string; role: 'owner' | 'caregiver'; appendChange(change: ChangeInput): Promise<number> };

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value as object).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new AppError(400, 'INVALID_REQUEST', '请求包含不支持的数据');
}

export function requestHash(operation: Pick<FamilyOperation, 'familyId' | 'action' | 'request'>): string {
  return createHash('sha256').update(canonical(operation)).digest('hex');
}

export function userRequestHash(operation: Pick<UserOperation, 'actorUserId' | 'action' | 'request'>): string {
  return createHash('sha256').update(canonical(operation)).digest('hex');
}

export function operationLock(actor: string, operation: string): string {
  return createHash('sha256').update(`operation:${actor}:${operation}`).digest().readBigInt64BE(0).toString();
}

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function activeMember(client: PoolClient, identity: FamilyIdentity): Promise<'owner' | 'caregiver'> {
  const member = await client.query<{ role: 'owner' | 'caregiver' }>(`
    SELECT m.role FROM app.family_members m
    JOIN app.families f ON f.id=m.family_id AND f.deleted_at IS NULL
    JOIN app.users u ON u.id=m.user_id AND u.disabled_at IS NULL
    WHERE m.family_id=$1 AND m.user_id=$2 AND m.active`, [identity.familyId, identity.actorUserId]);
  if (!member.rows[0]) throw notFound();
  return member.rows[0].role;
}

/** 仅供已认证身份调用。该工具负责当前成员授权；会话有效性仍由认证层验证。 */
export async function withFamilyWrite<T>(pool: Pool, operation: FamilyOperation, work: (context: FamilyWriteContext) => Promise<OperationResult<T>>, authorize?: (role: 'owner' | 'caregiver') => void): Promise<OperationResult<T> & { replayed: boolean }> {
  const hash = requestHash({ familyId: operation.familyId, action: operation.action, request: operation.request });
  return withTransaction(pool, async client => {
    // 所有调用使用相同锁顺序：操作 → 家庭水位 → 业务对象。
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [operationLock(operation.actorUserId, operation.operationId)]);
    const clock = await client.query('SELECT family_id FROM app.family_clocks WHERE family_id=$1 FOR UPDATE', [operation.familyId]);
    if (!clock.rowCount) throw notFound();
    const role = await activeMember(client, operation);
    authorize?.(role);
    const previous = await client.query<{ request_hash: string; result: T; response_status: number; expired: boolean }>(
      'SELECT request_hash,result,response_status,expires_at <= now() AS expired FROM app.operations WHERE actor_user_id=$1 AND operation_id=$2',
      [operation.actorUserId, operation.operationId]);
    const saved = previous.rows[0];
    if (saved) {
      if (saved.request_hash !== hash) throw new AppError(409, 'OPERATION_REUSED', '同一操作标识不能用于不同内容');
      if (saved.expired) throw new AppError(409, 'OPERATION_EXPIRED', '该操作已过期，请先核对现有记录');
      return { statusCode: saved.response_status, body: saved.result, replayed: true };
    }
    const result = await work({
      client, familyId: operation.familyId, actorUserId: operation.actorUserId, role,
      appendChange: async change => {
        if (!Number.isSafeInteger(change.revision) || change.revision < 0 || (change.deleted ? change.payload !== null : change.payload === null)) {
          throw new Error('变更事件不满足内部约束');
        }
        const next = await client.query<{ last_sequence: string }>('UPDATE app.family_clocks SET last_sequence=last_sequence+1 WHERE family_id=$1 RETURNING last_sequence', [operation.familyId]);
        const sequence = Number(next.rows[0]!.last_sequence);
        await client.query('INSERT INTO app.changes(family_id,sequence,entity,entity_id,revision,deleted,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [operation.familyId, sequence, change.entity, change.id, change.revision, change.deleted, change.payload]);
        return sequence;
      },
    });
    if (result.statusCode < 200 || result.statusCode > 299) throw new Error('幂等工具只持久化成功结果');
    await client.query('INSERT INTO app.operations(actor_user_id,operation_id,family_id,device_id,action,request_hash,response_status,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [operation.actorUserId, operation.operationId, operation.familyId, operation.deviceId, operation.action, hash, result.statusCode, result.body]);
    return { ...result, replayed: false };
  });
}

export async function withUserWrite<T>(
  pool: Pool,
  operation: UserOperation,
  work: (client: PoolClient) => Promise<OperationResult<T>>,
): Promise<OperationResult<T> & { replayed: boolean }> {
  const hash = userRequestHash(operation);
  return withTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [operationLock(operation.actorUserId, operation.operationId)]);
    const previous = await client.query<{ request_hash: string; result: T; response_status: number; expired: boolean }>(
      'SELECT request_hash,result,response_status,expires_at <= now() AS expired FROM app.user_operations WHERE actor_user_id=$1 AND operation_id=$2',
      [operation.actorUserId, operation.operationId],
    );
    const saved = previous.rows[0];
    if (saved) {
      if (saved.request_hash !== hash) throw new AppError(409, 'OPERATION_REUSED', '同一操作标识不能用于不同内容');
      if (saved.expired) throw new AppError(409, 'OPERATION_EXPIRED', '该操作已过期，请先核对现有记录');
      return { statusCode: saved.response_status, body: saved.result, replayed: true };
    }
    const result = await work(client);
    if (result.statusCode < 200 || result.statusCode > 299) throw new Error('幂等工具只持久化成功结果');
    await client.query(
      'INSERT INTO app.user_operations(actor_user_id,operation_id,action,request_hash,response_status,result) VALUES($1,$2,$3,$4,$5,$6)',
      [operation.actorUserId, operation.operationId, operation.action, hash, result.statusCode, result.body],
    );
    return { ...result, replayed: false };
  });
}

export async function withFamilySnapshot<T>(pool: Pool, identity: FamilyIdentity, read: (client: PoolClient) => Promise<T>): Promise<{ sequence: number; data: T }> {
  return withTransaction(pool, async client => {
    await activeMember(client, identity);
    const clock = await client.query<{ last_sequence: string }>('SELECT last_sequence FROM app.family_clocks WHERE family_id=$1', [identity.familyId]);
    if (!clock.rows[0]) throw notFound();
    const data = await read(client);
    return { sequence: Number(clock.rows[0].last_sequence), data };
  }, true);
}
