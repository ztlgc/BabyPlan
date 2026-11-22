import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/transactions.js';
import { LocalPrivateMediaStorage } from '../media/storage.js';
import { type DeletionEvent, type DeletionJournal, registerDeletion, verifyJournalCoverage } from './deletion-journal.js';

export async function lockFamilyForDeletion(client: PoolClient, familyId: string): Promise<void> {
  await client.query('SELECT family_id FROM app.family_clocks WHERE family_id=$1 FOR UPDATE', [familyId]);
}

export async function invalidateFamilyExports(client: PoolClient, familyId: string): Promise<void> {
  await client.query(`
    UPDATE app.exports
    SET status='failed',object_key=NULL,download_token_hash=NULL,download_expires_at=NULL,
        error_code='DATA_DELETED',updated_at=now()
    WHERE family_id=$1 AND (error_code IS DISTINCT FROM 'DATA_DELETED' OR object_key IS NOT NULL)
  `, [familyId]);
}

async function stripGrowthChangeHistory(client: PoolClient, event: DeletionEvent): Promise<void> {
  // 同步历史和幂等结果也不能再返回已永久删除的正文或照片。
  const memoryId = event.kind === 'memory' ? event.id : event.memoryId;
  if (!memoryId) throw new Error('删除记录缺少成长小记标识');
  await client.query(`
    DELETE FROM app.changes
    WHERE family_id=$1 AND (
      ($3='memory' AND ((entity='memory' AND entity_id=$2) OR
        (entity='media' AND (entity_id IN (SELECT id FROM app.media WHERE family_id=$1 AND memory_id=$2)
          OR payload->>'memoryId'=$2::uuid::text))))
      OR ($3='media' AND ((entity='media' AND entity_id=$4) OR
        (entity='memory' AND entity_id=$2 AND NOT deleted)))
    )
  `, [event.familyId, memoryId, event.kind, event.id]);
  await client.query(`
    DELETE FROM app.operations
    WHERE family_id=$1 AND (
      (action LIKE 'memory.%' AND result->>'id'=$2::uuid::text AND result ? 'text'
        AND ($3='memory' OR (result->'mediaIds') ? $4::uuid::text))
      OR (action='media.upload.create' AND
        (result->'media'->>'id'=$4::uuid::text OR ($3='memory' AND result->'media'->>'memoryId'=$2::uuid::text)))
      OR (action='media.upload.complete' AND
        (result->>'id'=$4::uuid::text OR ($3='memory' AND result->>'memoryId'=$2::uuid::text)))
    )
  `, [event.familyId, memoryId, event.kind, event.id]);
}

/** 在家庭写入事务中执行；移除正文/链接并刷新同步水位，磁盘由同一事件重试清理。 */
export async function hideDeletedGrowth(
  client: PoolClient, event: DeletionEvent,
): Promise<{ changeSeq: number; revision: number }> {
  if (event.kind === 'family') throw new Error('家庭删除必须整组清理');
  const memoryId = event.kind === 'memory' ? event.id : event.memoryId!;
  await stripGrowthChangeHistory(client, event);
  if (event.kind === 'memory') {
    await client.query(`
      UPDATE app.media
      SET state='deleted',deleted_at=COALESCE(deleted_at,$3),updated_at=now(),
          upload_token_hash=NULL,upload_expires_at=NULL,download_token_hash=NULL,download_expires_at=NULL,
          revision=revision+1
      WHERE family_id=$1 AND memory_id=$2 AND state<>'deleted'
    `, [event.familyId, memoryId, event.requestedAt]);
  }
  const row = event.kind === 'memory'
    ? (await client.query<{ revision: string }>(`
        UPDATE app.memories
        SET text='（已删除）',deleted_at=COALESCE(deleted_at,$3),
            permanently_deleted_at=COALESCE(permanently_deleted_at,$3),revision=revision+1,updated_at=now()
        WHERE family_id=$1 AND id=$2
        RETURNING revision
      `, [event.familyId, memoryId, event.requestedAt])).rows[0]
    : (await client.query<{ revision: string }>(`
        UPDATE app.media
        SET state='deleted',deleted_at=COALESCE(deleted_at,$3),updated_at=now(),
            upload_token_hash=NULL,upload_expires_at=NULL,download_token_hash=NULL,download_expires_at=NULL,
            revision=revision+1
        WHERE family_id=$1 AND id=$2 AND memory_id=$4
        RETURNING revision
      `, [event.familyId, event.id, event.requestedAt, memoryId])).rows[0];
  await invalidateFamilyExports(client, event.familyId);
  if (!row) return { changeSeq: 0, revision: 0 };
  const clock = await client.query<{ last_sequence: string }>(`
    UPDATE app.family_clocks SET minimum_cursor=last_sequence,last_sequence=last_sequence+1
    WHERE family_id=$1 RETURNING last_sequence
  `, [event.familyId]);
  const changeSeq = Number(clock.rows[0]!.last_sequence);
  await client.query(`
    INSERT INTO app.changes(family_id,sequence,entity,entity_id,revision,deleted)
    VALUES($1,$2,$3,$4,$5,true)
  `, [event.familyId, changeSeq, event.kind, event.id, row.revision]);
  return { changeSeq, revision: Number(row.revision) };
}

export async function purgeFamilyRows(client: PoolClient, familyId: string): Promise<void> {
  // 先删依赖家庭的明细，最后删除孩子、成员、家庭时钟与家庭本身。
  for (const table of [
    'media', 'exports', 'observations', 'measurements', 'memories', 'family_books',
    'participations', 'play_sessions', 'plan_items', 'day_plans', 'changes',
    'operations', 'family_preferences', 'invitations', 'children', 'family_members', 'family_clocks',
  ]) {
    await client.query(`DELETE FROM app.${table} WHERE family_id=$1`, [familyId]);
  }
  await client.query("DELETE FROM app.jobs WHERE family_id=$1 AND type<>'family_delete'", [familyId]);
  await client.query('DELETE FROM app.families WHERE id=$1', [familyId]);
  await client.query('UPDATE app.family_deletion_tombstones SET completed_at=COALESCE(completed_at,now()) WHERE family_id=$1', [familyId]);
}

export async function cleanupDeletion(
  pool: Pool, storage: LocalPrivateMediaStorage, event: DeletionEvent,
): Promise<void> {
  const familyPrefix = `families/${event.familyId}`;
  if (event.kind === 'family') {
    // 家庭已经冻结；清理文件可重试。受家庭锁保护的上传、生成和导出不能在冻结后写入。
    await storage.deleteTree(familyPrefix);
  } else if (event.kind === 'memory') {
    await storage.deleteTree(`${familyPrefix}/memories/${event.id}`);
  } else {
    const prefix = `${familyPrefix}/memories/${event.memoryId}/${event.id}`;
    for (const extension of ['jpg', 'png', 'webp']) {
      const key = `${prefix}.${extension}`;
      await storage.deleteObjectWithTemporaryCopies(key);
      await storage.deleteObjectWithTemporaryCopies(`${key}.thumb.webp`);
    }
  }
  if (event.kind !== 'family') {
    const exports = await pool.query<{ id: string }>(
      "SELECT id FROM app.exports WHERE family_id=$1 AND error_code='DATA_DELETED'", [event.familyId],
    );
    for (const { id } of exports.rows) {
      await storage.deleteObjectWithTemporaryCopies(`${familyPrefix}/exports/${id}.zip`);
    }
  }
  await withTransaction(pool, async client => {
    if (event.kind === 'family') {
      await lockFamilyForDeletion(client, event.familyId);
      await purgeFamilyRows(client, event.familyId);
      await client.query(`
        UPDATE app.jobs SET state='ready',finished_at=now(),updated_at=now(),error_code=NULL
        WHERE family_id=$1 AND type='family_delete' AND state<>'ready'
      `, [event.familyId]);
    }
    await client.query(`
      UPDATE app.permanent_deletions SET cleaned_at=COALESCE(cleaned_at,now())
      WHERE kind=$1 AND resource_id=$2 AND family_id=$3
    `, [event.kind, event.id, event.familyId]);
  });
}

/** 恢复库或服务启动前把已持久化的删除应用到数据库；操作可重复。 */
export async function replayDeletion(
  pool: Pool, storage: LocalPrivateMediaStorage, event: DeletionEvent,
): Promise<boolean> {
  const needsCleanup = await withTransaction(pool, async client => {
    await lockFamilyForDeletion(client, event.familyId);
    const known = await client.query<{ cleaned: boolean }>(`
      SELECT cleaned_at IS NOT NULL AS cleaned FROM app.permanent_deletions
      WHERE kind=$1 AND resource_id=$2 AND family_id=$3
    `, [event.kind, event.id, event.familyId]);
    if (known.rows[0]?.cleaned) return false;
    await registerDeletion(client, null, event);
    if (event.kind === 'family') {
      await client.query(`
        UPDATE app.families SET deleted_at=COALESCE(deleted_at,$2),
          deletion_requested_at=COALESCE(deletion_requested_at,$2)
        WHERE id=$1
      `, [event.familyId, event.requestedAt]);
      await client.query('UPDATE app.family_members SET active=false WHERE family_id=$1 AND active', [event.familyId]);
    } else {
      await hideDeletedGrowth(client, event);
    }
    return true;
  });
  if (needsCleanup) await cleanupDeletion(pool, storage, event);
  return needsCleanup;
}

export async function replayJournal(
  pool: Pool, storage: LocalPrivateMediaStorage, journal: DeletionJournal, journalId: string,
): Promise<{ total: number; reapplied: number }> {
  const events = await verifyJournalCoverage(pool, journal, journalId, false);
  let reapplied = 0;
  // 整个家庭先处理，避免对同一个已删家庭逐条改写成长资料。
  events.sort((left, right) => Number(right.kind === 'family') - Number(left.kind === 'family'));
  for (const event of events) if (await replayDeletion(pool, storage, event)) reapplied++;
  return { total: events.length, reapplied };
}
