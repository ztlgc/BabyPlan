import type { Pool } from 'pg';
import { notFound } from '../errors.js';
import type { LocalPrivateMediaStorage } from '../media/storage.js';
import { cleanupDeletion } from './deletions.js';

export type JobState = 'queued' | 'running' | 'ready' | 'failed';
export type JobDto = {
  id: string;
  type: 'family_delete' | 'media_delete' | 'export';
  state: JobState;
  errorCode: string | null;
};

type JobRow = {
  id: string;
  type: JobDto['type'];
  state: JobState;
  requested_by: string;
  family_id: string;
  error_code: string | null;
};

export async function processFamilyDeletion(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
  jobId: string,
): Promise<void> {
  const claimed = await pool.query<JobRow>(`
    UPDATE app.jobs
    SET state='running',started_at=now(),updated_at=now(),error_code=NULL
    WHERE id=$1 AND type='family_delete' AND state='queued'
    RETURNING id,type,state,requested_by,family_id,error_code
  `, [jobId]);
  const job = claimed.rows[0];
  if (!job) return;

  try {
    await cleanupDeletion(pool, storage, {
      kind: 'family', id: job.family_id, familyId: job.family_id, memoryId: null,
      requestedAt: new Date().toISOString(),
    });
  } catch {
    await pool.query(`
      UPDATE app.jobs
      SET state='failed',error_code='FAMILY_DELETE_FAILED',finished_at=now(),updated_at=now()
      WHERE id=$1 AND state='running'
    `, [jobId]);
  }
}

export async function resumeFamilyDeletionJobs(
  pool: Pool,
  storage: LocalPrivateMediaStorage,
): Promise<void> {
  await pool.query(`
    UPDATE app.jobs
    SET state='queued',started_at=NULL,updated_at=now()
    WHERE type='family_delete' AND state='running'
  `);
  const rows = await pool.query<{ id: string }>(`
    SELECT id FROM app.jobs
    WHERE type='family_delete' AND state='queued'
    ORDER BY created_at
    LIMIT 20
  `);
  for (const row of rows.rows) {
    await processFamilyDeletion(pool, storage, row.id);
  }
}

export async function getJob(pool: Pool, actorUserId: string, jobId: string): Promise<JobDto> {
  const result = await pool.query<JobRow>(`
    SELECT id,type,state,requested_by,family_id,error_code
    FROM app.jobs
    WHERE id=$1 AND requested_by=$2
  `, [jobId, actorUserId]);
  const job = result.rows[0];
  if (job) {
    if (job.type !== 'family_delete') {
      const access = await pool.query(`
        SELECT 1 FROM app.family_members
        WHERE family_id=$1 AND user_id=$2 AND active
      `, [job.family_id, actorUserId]);
      if (!access.rowCount) throw notFound();
    }
    return {
      id: job.id,
      type: job.type,
      state: job.state,
      errorCode: job.error_code,
    };
  }

  const exported = await pool.query<{
    id: string;
    status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  }>(`
    SELECT e.id,e.status
    FROM app.exports e
    JOIN app.family_members fm ON fm.family_id=e.family_id
      AND fm.user_id=$2 AND fm.active AND fm.role='owner'
    JOIN app.families f ON f.id=e.family_id AND f.deleted_at IS NULL
    WHERE e.id=$1 AND e.created_by=$2
  `, [jobId, actorUserId]);
  const exportRow = exported.rows[0];
  if (!exportRow) throw notFound();
  return {
    id: exportRow.id,
    type: 'export',
    state: exportRow.status === 'expired' ? 'failed' : exportRow.status,
    errorCode: exportRow.status === 'expired' ? 'EXPORT_EXPIRED' : null,
  };
}
