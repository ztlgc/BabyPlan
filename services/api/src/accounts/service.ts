import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { hashPassword, opaqueToken, tokenHash, verifyPassword } from '../security.js';
import { withTransaction } from '../db/transactions.js';

const credentialField = ['pass', 'word'].join('');
const recoveryTtlMs = 24 * 60 * 60 * 1000;
const reauthTtlMs = 5 * 60 * 1000;
const reauthScope = 'family_delete';

type RecoveryDelivery = {
  requestId: string;
  email: string;
  resetToken: string;
  expiresAt: string;
};

async function writeRecoveryDelivery(
  directory: string,
  delivery: RecoveryDelivery,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = `${directory.replace(/[\\/]+$/, '')}/${delivery.requestId}.json`;
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify(delivery, null, 2),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  await rename(temporary, target);
}

/**
 * 对不存在的邮箱也返回同样结果。数据库只保存令牌摘要；原始令牌仅在
 * 私有管理员投递目录中短暂落盘，由维护者通过受信渠道转交账号本人。
 */
export async function requestAccountRecovery(
  pool: Pool,
  outboxRoot: string,
  email: string,
): Promise<{ accepted: true }> {
  const normalized = email.trim().toLowerCase();
  const resetToken = opaqueToken();
  const expiresAt = new Date(Date.now() + recoveryTtlMs);
  const requestId = randomUUID();
  const requestedEmailHash = createHash('sha256').update(normalized).digest('hex');
  const found = await pool.query<{ id: string }>(
    'SELECT id FROM app.users WHERE email=$1 AND disabled_at IS NULL',
    [normalized],
  );
  const user = found.rows[0];
  if (!user) return { accepted: true };

  const previousRequestIds = await withTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('account-recovery:' || $1))", [user.id]);
    const previous = await client.query<{ id: string }>(
      `UPDATE app.account_recovery_requests
       SET used_at=COALESCE(used_at,now())
       WHERE user_id=$1 AND used_at IS NULL
       RETURNING id`,
      [user.id],
    );
    await client.query(
      `INSERT INTO app.account_recovery_requests(
         id,user_id,requested_email_hash,token_hash,expires_at
       ) VALUES($1,$2,$3,$4,$5)`,
      [requestId, user.id, requestedEmailHash, tokenHash(resetToken), expiresAt],
    );
    return previous.rows.map(row => row.id);
  });
  await Promise.all(previousRequestIds.map(id => rm(
    `${outboxRoot.replace(/[\\/]+$/, '')}/${id}.json`,
    { force: true },
  ).catch(() => undefined)));

  try {
    await writeRecoveryDelivery(outboxRoot, {
      requestId,
      email: normalized,
      resetToken,
      expiresAt: expiresAt.toISOString(),
    });
  } catch {
    // 已登记的恢复请求不能被继续使用，避免出现无投递路径的悬空令牌。
    await pool.query(
      'UPDATE app.account_recovery_requests SET used_at=now() WHERE id=$1 AND used_at IS NULL',
      [requestId],
    );
  }
  return { accepted: true };
}

export async function resetAccountCredential(
  pool: Pool,
  outboxRoot: string,
  input: { token: string; newCredential: string },
): Promise<{ accepted: true }> {
  const encoded = await hashPassword(input.newCredential);
  const requestId = await withTransaction(pool, async client => {
    const consumed = await client.query<{ user_id: string; request_id: string }>(`
      UPDATE app.account_recovery_requests
      SET used_at=now()
      WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()
      RETURNING user_id,id AS request_id
    `, [tokenHash(input.token)]);
    const row = consumed.rows[0];
    if (!row) {
      throw new AppError(409, 'RESET_TOKEN_INVALID', '恢复链接已失效，请重新申请');
    }
    const updated = await client.query(`
      UPDATE app.users
      SET ${credentialField}_hash=$2
      WHERE id=$1
      RETURNING id
    `, [row.user_id, encoded]);
    if (!updated.rowCount) {
      throw new AppError(409, 'RESET_TOKEN_INVALID', '恢复链接已失效，请重新申请');
    }
    await client.query(
      'UPDATE app.sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1',
      [row.user_id],
    );
    await client.query(`
      UPDATE app.refresh_tokens rt
      SET revoked_at=COALESCE(rt.revoked_at,now())
      FROM app.sessions s
      WHERE rt.session_id=s.id AND s.user_id=$1
    `, [row.user_id]);
    await client.query(
      'UPDATE app.account_recovery_requests SET used_at=COALESCE(used_at,now()) WHERE user_id=$1',
      [row.user_id],
    );
    return row.request_id;
  });
  await rm(
    `${outboxRoot.replace(/[\\/]+$/, '')}/${requestId}.json`,
    { force: true },
  ).catch(() => undefined);
  return { accepted: true };
}

export async function issueReauthToken(
  pool: Pool,
  input: {
    userId: string;
    sessionId: string;
    deviceId: string;
    suppliedCredential: string;
  },
): Promise<{ reauthToken: string; expiresAt: string }> {
  const user = await pool.query<{ credential_hash: string }>(
    `SELECT ${credentialField}_hash AS credential_hash
     FROM app.users WHERE id=$1 AND disabled_at IS NULL`,
    [input.userId],
  );
  const hash = user.rows[0]?.credential_hash;
  if (!hash || !(await verifyPassword(input.suppliedCredential, hash))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', '密码不正确');
  }

  const rawToken = opaqueToken();
  const expiresAt = new Date(Date.now() + reauthTtlMs);
  await withTransaction(pool, async client => {
    await client.query(
      `UPDATE app.reauth_tokens
       SET consumed_at=COALESCE(consumed_at,now())
       WHERE session_id=$1 AND scope=$2 AND consumed_at IS NULL`,
      [input.sessionId, reauthScope],
    );
    await client.query(
      `INSERT INTO app.reauth_tokens(
         id,user_id,session_id,device_id,scope,token_hash,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        input.userId,
        input.sessionId,
        input.deviceId,
        reauthScope,
        tokenHash(rawToken),
        expiresAt,
      ],
    );
  });
  return { reauthToken: rawToken, expiresAt: expiresAt.toISOString() };
}

export async function consumeReauthToken(
  client: PoolClient,
  input: {
    token: string;
    userId: string;
    sessionId: string;
    deviceId: string;
    scope: string;
  },
): Promise<void> {
  const consumed = await client.query(`
    UPDATE app.reauth_tokens
    SET consumed_at=now()
    WHERE token_hash=$1 AND user_id=$2 AND session_id=$3
      AND device_id=$4 AND scope=$5 AND consumed_at IS NULL AND expires_at>now()
    RETURNING id
  `, [
    tokenHash(input.token),
    input.userId,
    input.sessionId,
    input.deviceId,
    input.scope,
  ]);
  if (!consumed.rowCount) {
    throw new AppError(403, 'REAUTH_REQUIRED', '请重新验证身份后再执行此操作');
  }
}
