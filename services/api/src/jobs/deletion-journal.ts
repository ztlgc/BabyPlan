import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../db/transactions.js';

const eventSchema = z.strictObject({
  kind: z.enum(['family', 'memory', 'media']),
  id: z.uuid().transform(value => value.toLowerCase()),
  familyId: z.uuid().transform(value => value.toLowerCase()),
  memoryId: z.uuid().transform(value => value.toLowerCase()).nullable(),
  requestedAt: z.iso.datetime({ precision: 3 }),
}).refine(event =>
  (event.kind !== 'family' || event.id === event.familyId) &&
  (event.kind === 'media') === (event.memoryId !== null));

export type DeletionEvent = z.infer<typeof eventSchema>;
type DeletionRow = {
  kind: DeletionEvent['kind']; resource_id: string; family_id: string;
  memory_id: string | null; requested_at: Date;
};

const markerName = 'journal.json';
const markerSchema = z.strictObject({
  format: z.literal('babyplan-deletion-journal-v1'),
  journalId: z.uuid(),
});

function fileName(event: Pick<DeletionEvent, 'id' | 'kind'>): string {
  return `${event.kind}-${event.id}.json`;
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function readRecord(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
    throw new Error('删除台账中有无效文件');
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

async function assertDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await assertDirectory(parent);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('删除台账目录不能经过符号链接');
}

async function assertDirectoryOrParents(path: string): Promise<void> {
  try { await assertDirectory(path); }
  catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(path);
    if (parent !== path) await assertDirectoryOrParents(parent);
  }
}

export class DeletionJournal {
  private readonly root: string;

  constructor(root: string) { this.root = resolve(root); }

  // 先持久化记录，再允许提交数据库事务。崩溃后的重放优先保留删除意图。
  private async write(name: string, value: unknown): Promise<void> {
    const path = join(this.root, name);
    const tmp = join(this.root, `.pending-${randomUUID()}`);
    const file = await open(tmp, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(value) + '\n', 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      if (process.platform !== 'win32') {
        const directory = await open(this.root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await unlink(tmp).catch(error => { if (!missing(error)) throw error; });
    }
  }

  async initialize(pool: Pool, expectedId?: string): Promise<string> {
    return withTransaction(pool, async client => {
      await client.query('LOCK TABLE app.deletion_journal_identity IN EXCLUSIVE MODE');
      const { rows: [identity] } = await client.query<{ journal_id: string }>(
        'SELECT journal_id FROM app.deletion_journal_identity WHERE singleton',
      );
      if (expectedId && identity?.journal_id !== expectedId) throw new Error('备份部署标识与数据库不一致');
      if (identity) {
        await this.checkIdentity(identity.journal_id);
        return identity.journal_id;
      }
      await assertDirectoryOrParents(this.root);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await assertDirectory(this.root);
      const entries = await readdir(this.root);
      if (entries.some(name => name !== markerName && !/^\.pending-[a-f0-9-]{36}$/.test(name))) {
        throw new Error('新数据库不能绑定非空删除台账');
      }
      // 首次初始化在写标识后中断时，可安全接续尚未承载删除数据的台账。
      const journalId = entries.includes(markerName)
        ? markerSchema.parse(await readRecord(join(this.root, markerName))).journalId
        : randomUUID();
      if (!entries.includes(markerName)) await this.write(markerName, { format: 'babyplan-deletion-journal-v1', journalId });
      await client.query('INSERT INTO app.deletion_journal_identity(journal_id) VALUES ($1)', [journalId]);
      return journalId;
    });
  }

  async checkIdentity(journalId: string): Promise<void> {
    await assertDirectory(this.root);
    const marker = markerSchema.parse(await readRecord(join(this.root, markerName)));
    if (marker.journalId !== journalId) throw new Error('删除台账不属于当前部署');
  }

  async record(event: DeletionEvent): Promise<DeletionEvent> {
    const valid = eventSchema.parse(event);
    // 部署过的台账丢失时不能自动创建空目录。
    await assertDirectory(this.root);
    markerSchema.parse(await readRecord(join(this.root, markerName)));
    const name = fileName(valid);
    try {
      const original = eventSchema.parse(await readRecord(join(this.root, name)));
      if (original.kind !== valid.kind || original.id !== valid.id ||
          original.familyId !== valid.familyId || original.memoryId !== valid.memoryId) {
        throw new Error('删除台账中的对象归属不一致');
      }
      return original;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await this.write(name, valid);
    return valid;
  }

  async events(journalId: string): Promise<DeletionEvent[]> {
    await this.checkIdentity(journalId);
    const events: DeletionEvent[] = [];
    for (const name of (await readdir(this.root)).sort()) {
      if (name === markerName || /^\.pending-[a-f0-9-]{36}$/.test(name)) continue;
      const event = eventSchema.parse(await readRecord(join(this.root, name)));
      if (fileName(event) !== name) throw new Error('删除台账文件与对象标识不一致');
      events.push(event);
    }
    return events;
  }
}

export function fromDeletionRow(row: DeletionRow): DeletionEvent {
  return eventSchema.parse({
    kind: row.kind, id: row.resource_id, familyId: row.family_id,
    memoryId: row.memory_id, requestedAt: row.requested_at.toISOString(),
  });
}

export async function registerDeletion(
  client: PoolClient,
  journal: DeletionJournal | null,
  event: Omit<DeletionEvent, 'requestedAt'> & { requestedAt?: string },
): Promise<DeletionEvent> {
  let requestedAt = event.requestedAt;
  if (!requestedAt) {
    const time = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    requestedAt = time.rows[0]!.now.toISOString();
  }
  let entry = eventSchema.parse({ ...event, requestedAt });
  if (journal) entry = await journal.record(entry);
  const { rows: [row] } = await client.query<DeletionRow>(`
    INSERT INTO app.permanent_deletions(kind,resource_id,family_id,memory_id,requested_at)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (kind,resource_id) DO UPDATE SET
      requested_at=LEAST(app.permanent_deletions.requested_at,excluded.requested_at)
    WHERE app.permanent_deletions.family_id=excluded.family_id
      AND app.permanent_deletions.memory_id IS NOT DISTINCT FROM excluded.memory_id
    RETURNING kind,resource_id,family_id,memory_id,requested_at
  `, [entry.kind, entry.id, entry.familyId, entry.memoryId, entry.requestedAt]);
  if (!row) throw new Error('永久删除标识与已登记对象不一致');
  return fromDeletionRow(row);
}

export async function prepareJournal(pool: Pool, journal: DeletionJournal): Promise<string> {
  const id = await journal.initialize(pool);
  const rows = await pool.query<DeletionRow>(
    'SELECT kind,resource_id,family_id,memory_id,requested_at FROM app.permanent_deletions',
  );
  // 接续升级前仍留在数据库里的删除记录。
  for (const row of rows.rows) await journal.record(fromDeletionRow(row));
  return id;
}

export async function verifyJournalCoverage(
  pool: Pool, journal: DeletionJournal, journalId: string, requireClean: boolean,
): Promise<DeletionEvent[]> {
  const events = await journal.events(journalId);
  const present = new Map(events.map(event => [fileName(event), event]));
  const rows = await pool.query<DeletionRow & { cleaned: boolean }>(`
    SELECT kind,resource_id,family_id,memory_id,requested_at,cleaned_at IS NOT NULL AS cleaned
    FROM app.permanent_deletions
  `);
  for (const row of rows.rows) {
    const event = fromDeletionRow(row);
    const entry = present.get(fileName(event));
    if (!entry || entry.familyId !== event.familyId || entry.memoryId !== event.memoryId ||
        entry.requestedAt !== event.requestedAt || (requireClean && !row.cleaned)) {
      throw new Error('删除台账不完整或仍有未清理记录');
    }
  }
  if (requireClean && events.length !== rows.rows.length) throw new Error('删除台账仍有待重放记录');
  return events;
}

export async function pendingDeletions(pool: Pool): Promise<DeletionEvent[]> {
  const rows = await pool.query<DeletionRow>(`
    SELECT kind,resource_id,family_id,memory_id,requested_at FROM app.permanent_deletions
    WHERE cleaned_at IS NULL ORDER BY requested_at,kind,resource_id LIMIT 100
  `);
  return rows.rows.map(fromDeletionRow);
}
