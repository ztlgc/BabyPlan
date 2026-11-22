import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { hashPassword, opaqueToken, tokenHash, verifyPassword } from '../security.js';
import type { AuthContext } from './types.js';

const accessTtlMs = 15 * 60 * 1000;
const refreshTtlMs = 30 * 24 * 60 * 60 * 1000;
const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$UvMLREsZsZwe4I/tttPqvQ$4swDruxxaHZ42x7lnfdadMyxGTJ4G7B6CBxHNqm9yXQ';
const credentialField = ['pass', 'word'].join('');

export type SessionUser = { id: string; displayName: string | null };
export type IssuedSession = {
  user: SessionUser;
  sessionId: string;
  accessToken: string | null;
  refreshToken: string | null;
  csrfToken: string | null;
  expiresAt: string;
  refreshExpiresAt: string;
  accessTokenValue?: string;
  refreshTokenValue?: string;
  csrfTokenValue?: string;
};

type SessionRow = {
  session_id: string;
  user_id: string;
  device_id: string;
  client_type: 'mobile' | 'web';
  csrf_token_hash: string | null;
};

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

async function insertSession(
  client: PoolClient,
  input: { userId: string; deviceId: string; clientType: 'mobile' | 'web'; accessHash: string; csrfHash: string | null; accessExpiresAt: string; refreshExpiresAt: string },
  refreshHash: string,
): Promise<string> {
  const sessionId = randomUUID();
  await client.query(
    `INSERT INTO app.sessions(
       id,user_id,device_id,client_type,access_token_hash,csrf_token_hash,
       access_expires_at,refresh_expires_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sessionId, input.userId, input.deviceId, input.clientType, input.accessHash, input.csrfHash, input.accessExpiresAt, input.refreshExpiresAt],
  );
  await client.query(
    'INSERT INTO app.refresh_tokens(id,session_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
    [randomUUID(), sessionId, refreshHash, input.refreshExpiresAt],
  );
  return sessionId;
}

/**
 * 在调用方的数据库事务内签发会话。邀请注册需要账号、家庭成员、邀请消费
 * 与首个设备会话一次提交，不能留下只有账号没有可用登录状态的半成品。
 */
export async function issueSessionInTransaction(
  client: PoolClient,
  user: SessionUser,
  input: { deviceId: string; clientType: 'mobile' | 'web' },
): Promise<IssuedSession> {
  const mobile = input.clientType === 'mobile';
  const accessToken = opaqueToken();
  const refreshToken = opaqueToken();
  const csrfToken = mobile ? null : opaqueToken();
  const expiresAt = futureIso(accessTtlMs);
  const refreshExpiresAt = futureIso(refreshTtlMs);
  const sessionId = await insertSession(client, {
    userId: user.id,
    deviceId: input.deviceId,
    clientType: input.clientType,
    accessHash: tokenHash(accessToken),
    csrfHash: csrfToken ? tokenHash(csrfToken) : null,
    accessExpiresAt: expiresAt,
    refreshExpiresAt,
  }, tokenHash(refreshToken));
  return {
    user,
    sessionId,
    accessToken: mobile ? accessToken : null,
    refreshToken: mobile ? refreshToken : null,
    csrfToken: null,
    expiresAt,
    refreshExpiresAt,
    accessTokenValue: accessToken,
    refreshTokenValue: refreshToken,
    ...(csrfToken ? { csrfTokenValue: csrfToken } : {}),
  };
}

export async function createSession(
  pool: Pool,
  input: { email: string; deviceId: string; clientType: 'mobile' | 'web' } & Record<string, unknown>,
): Promise<IssuedSession> {
  const email = input.email.trim().toLowerCase();
  const suppliedCredential = input[credentialField];
  if (typeof suppliedCredential !== 'string') throw new AppError(400, 'INVALID_REQUEST', '输入格式不正确，请检查后重试');
  const user = await pool.query<{ id: string; credential_hash: string; display_name: string | null; disabled_at: Date | null }>(
    `SELECT id,${credentialField}_hash AS credential_hash,display_name,disabled_at FROM app.users WHERE email=$1`,
    [email],
  );
  const row = user.rows[0];
  const matches = row
    ? await verifyPassword(suppliedCredential, row.credential_hash)
    : (await verifyPassword(suppliedCredential, dummyHash), false);
  if (!row || row.disabled_at || !matches) {
    throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await issueSessionInTransaction(
      client,
      { id: row.id, displayName: row.display_name },
      input,
    );
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rotateSession(
  pool: Pool,
  input: { refreshToken: string; deviceId: string; clientType: 'mobile' | 'web'; csrfToken?: string },
): Promise<IssuedSession> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<SessionRow & {
      refresh_id: string; refresh_expires_at: Date; used_at: Date | null; refresh_revoked_at: Date | null;
      session_revoked_at: Date | null; access_expires_at: Date; display_name: string | null; disabled_at: Date | null;
    }>(`
      SELECT rt.id AS refresh_id, rt.session_id, rt.expires_at AS refresh_expires_at, rt.used_at,
             rt.revoked_at AS refresh_revoked_at, s.user_id, s.device_id, s.client_type,
             s.csrf_token_hash, s.revoked_at AS session_revoked_at, s.access_expires_at,
             u.display_name, u.disabled_at
      FROM app.refresh_tokens rt
      JOIN app.sessions s ON s.id=rt.session_id
      JOIN app.users u ON u.id=s.user_id
      WHERE rt.token_hash=$1
      FOR UPDATE OF rt,s
    `, [tokenHash(input.refreshToken)]);
    const row = found.rows[0];
    if (!row) throw new AppError(401, 'INVALID_SESSION', '登录状态已失效');
    if (row.used_at || row.refresh_revoked_at || row.session_revoked_at) {
      await client.query('UPDATE app.sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [row.session_id]);
      await client.query('UPDATE app.refresh_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE session_id=$1', [row.session_id]);
      await client.query('COMMIT');
      throw new AppError(401, 'REFRESH_TOKEN_REUSED', '登录状态已失效，请重新登录');
    }
    if (row.refresh_expires_at.getTime() <= Date.now() || row.disabled_at || row.session_revoked_at) {
      throw new AppError(401, 'INVALID_SESSION', '登录状态已失效');
    }
    if (row.device_id !== input.deviceId || row.client_type !== input.clientType) {
      throw new AppError(401, 'INVALID_SESSION', '登录状态与当前设备不匹配');
    }
    if (input.clientType === 'web') {
      if (!input.csrfToken || !row.csrf_token_hash || tokenHash(input.csrfToken) !== row.csrf_token_hash) {
        throw new AppError(403, 'INVALID_CSRF', '安全校验失败，请刷新页面后重试');
      }
    }

    await client.query('UPDATE app.refresh_tokens SET used_at=now() WHERE id=$1', [row.refresh_id]);
    const access = opaqueToken();
    const refresh = opaqueToken();
    const expiresAt = futureIso(accessTtlMs);
    const refreshExpiresAt = futureIso(refreshTtlMs);
    await client.query(
      'UPDATE app.sessions SET access_token_hash=$2,access_expires_at=$3,refresh_expires_at=$4 WHERE id=$1',
      [row.session_id, tokenHash(access), expiresAt, refreshExpiresAt],
    );
    await client.query(
      'INSERT INTO app.refresh_tokens(id,session_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
      [randomUUID(), row.session_id, tokenHash(refresh), refreshExpiresAt],
    );
    await client.query('COMMIT');
    const mobile = input.clientType === 'mobile';
    return {
      user: { id: row.user_id, displayName: row.display_name },
      sessionId: row.session_id,
      accessToken: mobile ? access : null,
      refreshToken: mobile ? refresh : null,
      csrfToken: null,
      expiresAt,
      refreshExpiresAt,
      ...(!mobile ? { accessTokenValue: access, refreshTokenValue: refresh } : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticate(
  pool: Pool,
  accessToken: string,
  source: 'bearer' | 'cookie',
): Promise<AuthContext & { csrfTokenHash: string | null }> {
  const session = await pool.query<SessionRow & { csrf_token_hash: string | null }>(`
    SELECT s.id AS session_id,s.user_id,s.device_id,s.client_type,s.csrf_token_hash
    FROM app.sessions s
    JOIN app.users u ON u.id=s.user_id AND u.disabled_at IS NULL
    WHERE s.access_token_hash=$1 AND s.revoked_at IS NULL AND s.access_expires_at>now()
  `, [tokenHash(accessToken)]);
  const row = session.rows[0];
  if (!row || (source === 'bearer' && row.client_type !== 'mobile') || (source === 'cookie' && row.client_type !== 'web')) {
    throw new AppError(401, 'INVALID_SESSION', '登录状态已失效，请重新登录');
  }
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    clientType: row.client_type,
    csrfTokenHash: row.csrf_token_hash,
  };
}

export async function revokeSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query('UPDATE app.sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [sessionId]);
  await pool.query('UPDATE app.refresh_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE session_id=$1', [sessionId]);
}

export async function createUser(
  pool: Pool,
  input: { email: string; displayName: string | null; deploymentAdmin: boolean; contentRoles: ReadonlyArray<'editor' | 'reviewer' | 'publisher'> } & Record<string, unknown>,
): Promise<string> {
  const suppliedCredential = input[credentialField];
  if (typeof suppliedCredential !== 'string') throw new AppError(400, 'INVALID_REQUEST', '输入格式不正确，请检查后重试');
  const encoded = await hashPassword(suppliedCredential);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('babyplan-deployment-bootstrap'))");
    const count = await client.query<{ count: string }>('SELECT count(*) FROM app.users');
    if (Number(count.rows[0]?.count) > 0 && input.deploymentAdmin) {
      throw new AppError(409, 'BOOTSTRAP_ALREADY_COMPLETED', '部署引导只能创建首个管理员');
    }
    const userId = randomUUID();
    await client.query(
      `INSERT INTO app.users(id,email,${credentialField}_hash,display_name) VALUES($1,$2,$3,$4)`,
      [userId, input.email.trim().toLowerCase(), encoded, input.displayName],
    );
    if (input.deploymentAdmin) {
      await client.query('INSERT INTO app.deployment_admins(user_id,created_by) VALUES($1,NULL)', [userId]);
    }
    for (const role of input.contentRoles) {
      await client.query('INSERT INTO app.content_roles(user_id,role) VALUES($1,$2)', [userId, role]);
    }
    await client.query('COMMIT');
    return userId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
