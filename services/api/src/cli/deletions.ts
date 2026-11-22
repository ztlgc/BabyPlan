import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { withTransaction } from '../db/transactions.js';
import { DeletionJournal, verifyJournalCoverage } from '../jobs/deletion-journal.js';
import { replayJournal } from '../jobs/deletions.js';
import { LocalPrivateMediaStorage } from '../media/storage.js';

async function main(): Promise<void> {
  const [command, expectedId] = process.argv.slice(2);
  if (command !== 'prepare-backup' && command !== 'replay-restore') throw new Error('invalid_command');
  if (command === 'replay-restore' && !expectedId) throw new Error('expected_journal_id');
  const config = loadConfig();
  if (!config.deletionJournalRoot) throw new Error('journal_required');
  const journal = new DeletionJournal(config.deletionJournalRoot);
  const storage = new LocalPrivateMediaStorage(config.mediaRoot);
  const pool = createPool(config);
  try {
    const { rows: [identity] } = await pool.query<{ journal_id: string }>(
      'SELECT journal_id FROM app.deletion_journal_identity WHERE singleton',
    );
    if (!identity || (expectedId && identity.journal_id !== expectedId)) throw new Error('journal_identity');
    const journalId = identity.journal_id;
    if (command === 'replay-restore') await migrate(pool);
    // 备份命令不修改源库；恢复只对新库执行重放。
    const stats = command === 'replay-restore'
      ? await replayJournal(pool, storage, journal, journalId)
      : { total: (await verifyJournalCoverage(pool, journal, journalId, true)).length, reapplied: 0 };
    if (command === 'replay-restore') {
      // 快照回滚后，旧的会话、邀请、签名链接和同步游标均不能继承原授权。
      await withTransaction(pool, async client => client.query(`
        UPDATE app.sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE revoked_at IS NULL;
        -- 备份之后被移除的陪伴者不能因恢复而重新获得权限。由所有者复核后重新邀请。
        UPDATE app.family_members SET active=false,revision=revision+1 WHERE active AND role<>'owner';
        UPDATE app.invitations SET revoked_at=COALESCE(revoked_at,now()),
          redemption_operation_id=NULL,redemption_request_hash=NULL;
        DELETE FROM app.operations WHERE action='invitation.create' OR action='media.upload.create';
        UPDATE app.media SET upload_token_hash=NULL,upload_expires_at=NULL,
          download_token_hash=NULL,download_expires_at=NULL
        WHERE upload_token_hash IS NOT NULL OR download_token_hash IS NOT NULL;
        UPDATE app.exports SET download_token_hash=NULL,download_expires_at=NULL WHERE download_token_hash IS NOT NULL;
        UPDATE app.family_clocks SET minimum_cursor=last_sequence+1,last_sequence=last_sequence+1;
      `));
    }
    process.stdout.write(JSON.stringify({ journalId, ...stats }) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // 不回显环境路径、连接串、台账内容或数据库错误详情。
  process.stderr.write('删除台账核对或重放未完成，请检查部署标识、台账文件和数据库迁移。\n');
  process.exitCode = 1;
});
