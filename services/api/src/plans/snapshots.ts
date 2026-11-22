import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { listContentWithdrawals } from '../content/workflow.js';
import { withFamilySnapshot } from '../db/transactions.js';
import { AppError } from '../errors.js';
import { opaqueToken } from '../security.js';
import { encodeCursor, readFamilySnapshotData } from './service.js';

const arrays = ['children', 'days', 'memories', 'measurements', 'observations',
  'sessions', 'books', 'media', 'withdrawals'] as const;
type Data = Awaited<ReturnType<typeof readFamilySnapshotData>>['data'];
type Page = Record<(typeof arrays)[number], unknown[]> & Pick<Data, 'family' | 'preferences'> & {
  snapshotId: string; cursor: string; expiresAt: string; nextPageToken: string | null; hasMore: boolean;
};
type SavedSnapshot = {
  familyId: string; actorUserId: string; sequence: number; withdrawalVersion: string;
  pages: Page[]; tokens: string[]; bytes: number; timeout: ReturnType<typeof setTimeout>;
};

function expired(): AppError {
  return new AppError(410, 'SNAPSHOT_EXPIRED', '家庭快照已失效，请从第一页重试');
}

function withdrawalVersion(withdrawals: Data['withdrawals']): string {
  return JSON.stringify(withdrawals);
}

// 单进程私有部署；重启、到期和挤出后的令牌统一返回 410。
// 快照不落盘，避免在备份中产生另一份家庭正文或旧照片授权。
export function createFamilySnapshotReader(pool: Pool) {
  const snapshots = new Map<string, SavedSnapshot>();
  const byToken = new Map<string, { id: string; index: number }>();
  const lifetimeMs = 30 * 60_000;
  const byteBudget = 128 * 1024 * 1024;
  let totalBytes = 0;

  function remove(id: string): void {
    const saved = snapshots.get(id);
    if (!saved) return;
    clearTimeout(saved.timeout);
    for (const token of saved.tokens) byToken.delete(token);
    totalBytes -= saved.bytes;
    snapshots.delete(id);
  }

  async function read(familyId: string, actorUserId: string, pageToken?: string, limit = 100): Promise<Page> {
    if (pageToken) {
      const location = byToken.get(pageToken);
      const saved = location && snapshots.get(location.id);
      if (!location || !saved || saved.familyId !== familyId || saved.actorUserId !== actorUserId) throw expired();

      // 每页重新核验成员。软删和永久删除立即作废包含旧事实的分页。
      const current = await withFamilySnapshot(pool, { familyId, actorUserId }, async client => {
        const result = await client.query<{ invalidated: boolean }>(`
          SELECT minimum_cursor>$2 OR EXISTS (
            SELECT 1 FROM app.changes WHERE family_id=$1 AND sequence>$2 AND deleted
          ) AS invalidated FROM app.family_clocks WHERE family_id=$1
        `, [familyId, saved.sequence]);
        return !result.rows[0]?.invalidated &&
          withdrawalVersion(await listContentWithdrawals(client)) === saved.withdrawalVersion;
      });
      const page = saved.pages[location.index];
      if (!page || !current.data || !snapshots.has(location.id) || Date.parse(page.expiresAt) <= Date.now()) {
        remove(location.id);
        throw expired();
      }
      return page;
    }

    const { sequence, data } = await readFamilySnapshotData(pool, actorUserId, familyId);
    const snapshotId = randomUUID();
    const cursor = encodeCursor(familyId, sequence);
    const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
    function page(): Page {
      return {
        family: data.family, preferences: data.preferences, snapshotId, cursor, expiresAt,
        children: [], days: [], memories: [], measurements: [], observations: [],
        sessions: [], books: [], media: [], withdrawals: [], nextPageToken: null, hasMore: false,
      };
    }
    const pages: Page[] = [page()];
    let count = 0;
    for (const kind of arrays) {
      for (const item of data[kind]) {
        if (count === limit) {
          pages.push(page());
          count = 0;
        }
        pages[pages.length - 1]![kind].push(item);
        count++;
      }
    }
    if (pages.length > 1) {
      // 防止一个家庭同时保留很多历史副本；容量回收也按过期处理。
      const bytes = Buffer.byteLength(JSON.stringify(data)) * 2;
      if (bytes > byteBudget) throw new AppError(503, 'SNAPSHOT_TOO_LARGE', '家庭历史过大，暂时无法刷新完整快照');
      for (const [id, saved] of snapshots) {
        if (saved.familyId === familyId && saved.actorUserId === actorUserId) remove(id);
      }
      while (snapshots.size >= 32 || totalBytes + bytes > byteBudget) {
        const oldest = snapshots.keys().next().value;
        if (!oldest) break;
        remove(oldest);
      }
      const tokens: string[] = [];
      for (let index = 1; index < pages.length; index++) {
        const token = opaqueToken();
        tokens.push(token);
        byToken.set(token, { id: snapshotId, index });
        pages[index - 1]!.nextPageToken = token;
        pages[index - 1]!.hasMore = true;
      }
      const timeout = setTimeout(() => remove(snapshotId), lifetimeMs);
      timeout.unref();
      totalBytes += bytes;
      snapshots.set(snapshotId, {
        familyId, actorUserId, sequence, pages, tokens, bytes, timeout,
        withdrawalVersion: withdrawalVersion(data.withdrawals),
      });
    }
    return pages[0]!;
  }

  return { read, close: () => { for (const id of snapshots.keys()) remove(id); } };
}
