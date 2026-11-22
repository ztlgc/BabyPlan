import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError, notFound } from '../errors.js';
import { hashPassword, opaqueToken, tokenHash } from '../security.js';
import {
  operationLock,
  requestHash,
  withFamilyWrite,
  withTransaction,
  withUserWrite,
} from '../db/transactions.js';
import { issueSessionInTransaction, type IssuedSession } from '../auth/sessions.js';
import { consumeReauthToken } from '../accounts/service.js';
import { type DeletionJournal, registerDeletion } from '../jobs/deletion-journal.js';
import { lockFamilyForDeletion } from '../jobs/deletions.js';
import {
  childFamilyId,
  dateValue,
  getFamily,
  mapChild,
  type ChildDto,
  type FamilyDto,
  type MemberDto,
} from './repository.js';

const credentialField = ['pass', 'word'].join('');

export type FamilyChildInput = {
  displayName: string | null;
  ageMode: 'months' | 'birthDate';
  ageMonths: number | null;
  ageAsOf: string | null;
  birthDate: string | null;
};

async function appendInitialChange(
  client: PoolClient,
  familyId: string,
  entity: string,
  id: string,
  revision: number,
  payload: unknown,
): Promise<void> {
  const next = await client.query<{ last_sequence: string }>(
    'UPDATE app.family_clocks SET last_sequence=last_sequence+1 WHERE family_id=$1 RETURNING last_sequence',
    [familyId],
  );
  await client.query(
    'INSERT INTO app.changes(family_id,sequence,entity,entity_id,revision,deleted,payload) VALUES($1,$2,$3,$4,$5,false,$6)',
    [familyId, Number(next.rows[0]!.last_sequence), entity, id, revision, payload],
  );
}

export async function createFamily(
  pool: Pool,
  actorUserId: string,
  input: { operationId: string; deviceId: string; name: string; timezone: string; child: FamilyChildInput },
): Promise<FamilyDto> {
  const familyId = randomUUID();
  const childId = randomUUID();
  const operation = {
    familyId,
    actorUserId,
    operationId: input.operationId,
    deviceId: input.deviceId,
    action: 'family.create',
    request: { name: input.name, timezone: input.timezone, child: input.child },
  };
  return withTransaction(pool, async client => {
    const authorization = await client.query(`
      SELECT 1 FROM app.deployment_admins a
      JOIN app.users u ON u.id=a.user_id AND u.disabled_at IS NULL
      WHERE a.user_id=$1
    `, [actorUserId]);
    if (!authorization.rowCount) throw new AppError(403, 'DEPLOYMENT_ADMIN_REQUIRED', '当前账号不能创建新家庭');

    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [operationLock(actorUserId, input.operationId)]);
    const previous = await client.query<{ family_id: string; request_hash: string; result: FamilyDto }>(
      'SELECT family_id,request_hash,result FROM app.operations WHERE actor_user_id=$1 AND operation_id=$2',
      [actorUserId, input.operationId],
    );
    const saved = previous.rows[0];
    if (saved) {
      const expected = requestHash({ familyId: '', action: operation.action, request: operation.request });
      if (saved.request_hash !== expected) throw new AppError(409, 'OPERATION_REUSED', '同一操作标识不能用于不同内容');
      return saved.result;
    }

    const hash = requestHash({ familyId: '', action: operation.action, request: operation.request });
    await client.query(
      `INSERT INTO app.families(id,name,timezone,owner_user_id) VALUES($1,$2,$3,$4)`,
      [familyId, input.name, input.timezone, actorUserId],
    );
    await client.query(
      `INSERT INTO app.family_members(family_id,user_id,role) VALUES($1,$2,'owner')`,
      [familyId, actorUserId],
    );
    await client.query(
      `INSERT INTO app.children(
         id,family_id,display_name,age_mode,age_months,age_as_of,birth_date
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [childId, familyId, input.child.displayName, input.child.ageMode, input.child.ageMonths, input.child.ageAsOf, input.child.birthDate],
    );

    const family = await getFamily(client, familyId);
    const child = await client.query(`
      SELECT id,family_id,display_name,age_mode,age_months,age_as_of,birth_date,revision
      FROM app.children WHERE id=$1
    `, [childId]);
    const childPayload: ChildDto = {
      id: child.rows[0].id,
      familyId,
      displayName: child.rows[0].display_name,
      ageMode: child.rows[0].age_mode,
      ageMonths: child.rows[0].age_months === null ? null : Number(child.rows[0].age_months),
      ageAsOf: dateValue(child.rows[0].age_as_of as string | Date | null),
      birthDate: dateValue(child.rows[0].birth_date as string | Date | null),
      revision: Number(child.rows[0].revision),
    };
    await appendInitialChange(client, familyId, 'family', familyId, family.revision, family);
    await appendInitialChange(client, familyId, 'member', actorUserId, 1, family.members[0]);
    await appendInitialChange(client, familyId, 'child', childId, childPayload.revision, childPayload);
    await client.query(
      `INSERT INTO app.operations(
         actor_user_id,operation_id,family_id,device_id,action,request_hash,response_status,result
       ) VALUES($1,$2,$3,$4,$5,$6,201,$7)`,
      [actorUserId, input.operationId, familyId, input.deviceId, operation.action, hash, family],
    );
    return family;
  });
}

export async function updateChild(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  childId: string,
  input: {
    operationId: string;
    baseRevision: number;
    age: FamilyChildInput;
  },
): Promise<ChildDto> {
  const familyId = await childFamilyId(pool, childId, actorUserId);
  const result = await withFamilyWrite<ChildDto>(pool, {
    familyId,
    actorUserId,
    deviceId,
    operationId: input.operationId,
    action: 'child.update',
    request: { childId, baseRevision: input.baseRevision, age: input.age },
  }, async ({ client, appendChange }) => {
    const current = await client.query(`
      SELECT id,family_id,display_name,age_mode,age_months,age_as_of,birth_date,revision
      FROM app.children
      WHERE id=$1 AND family_id=$2 AND deleted_at IS NULL
      FOR UPDATE
    `, [childId, familyId]);
    const row = current.rows[0];
    if (!row) throw notFound();
    if (Number(row.revision) !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '孩子资料已被其他家长更新', {
        current: Number(row.revision),
        submitted: input.baseRevision,
      });
    }
    const revision = Number(row.revision) + 1;
    const updated = await client.query(`
      UPDATE app.children
      SET display_name=$3,age_mode=$4,age_months=$5,age_as_of=$6,birth_date=$7,revision=$8
      WHERE id=$1 AND family_id=$2
      RETURNING *
    `, [
      childId,
      familyId,
      input.age.displayName,
      input.age.ageMode,
      input.age.ageMonths,
      input.age.ageAsOf,
      input.age.birthDate,
      revision,
    ]);
    const child = mapChild(updated.rows[0]);
    await appendChange({
      entity: 'child',
      id: childId,
      revision,
      deleted: false,
      payload: child,
    });
    return { statusCode: 200, body: child };
  });
  return result.body;
}

export async function removeFamilyMember(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  familyId: string,
  targetUserId: string,
  operationId: string,
): Promise<{ id: string; revision: number; changeSeq: number }> {
  const result = await withFamilyWrite<{ id: string; revision: number; changeSeq: number }>(pool, {
    familyId,
    actorUserId,
    deviceId,
    operationId,
    action: 'family.member.remove',
    request: { familyId, targetUserId },
  }, async ({ client, appendChange }) => {
    const target = await client.query<{ role: 'owner' | 'caregiver'; revision: string }>(`
      SELECT role,revision
      FROM app.family_members
      WHERE family_id=$1 AND user_id=$2 AND active
      FOR UPDATE
    `, [familyId, targetUserId]);
    const member = target.rows[0];
    if (!member) throw notFound();

    if (member.role === 'owner') {
      const owners = await client.query<{ count: string; next_owner: string | null }>(`
        SELECT count(*) AS count,
               min(user_id::text) FILTER (WHERE user_id<>$2) AS next_owner
        FROM app.family_members
        WHERE family_id=$1 AND role='owner' AND active
      `, [familyId, targetUserId]);
      if (Number(owners.rows[0]?.count ?? 0) <= 1) {
        throw new AppError(409, 'LAST_OWNER', '不能移除家庭中最后一位所有者');
      }
      await client.query(
        'UPDATE app.families SET owner_user_id=$2,revision=revision+1 WHERE id=$1',
        [familyId, owners.rows[0]!.next_owner],
      );
    }

    const revision = Number(member.revision) + 1;
    const updated = await client.query<{ joined_at: Date }>(`
      UPDATE app.family_members
      SET active=false,revision=$3
      WHERE family_id=$1 AND user_id=$2
      RETURNING joined_at
    `, [familyId, targetUserId, revision]);
    const display = await client.query<{ display_name: string | null }>(
      'SELECT display_name FROM app.users WHERE id=$1',
      [targetUserId],
    );
    const payload: MemberDto = {
      userId: targetUserId,
      role: member.role,
      active: false,
      displayName: display.rows[0]?.display_name ?? null,
      familyId,
      revision,
    };
    const changeSeq = await appendChange({
      entity: 'member',
      id: targetUserId,
      revision,
      deleted: false,
      payload,
    });
    void updated;
    return {
      statusCode: 200,
      body: { id: targetUserId, revision, changeSeq },
    };
  }, role => {
    if (role !== 'owner') throw new AppError(403, 'OWNER_REQUIRED', '仅家庭所有者可以移除成员');
  });
  return result.body;
}

export async function requestFamilyDeletion(
  pool: Pool,
  journal: DeletionJournal | null,
  identity: {
    actorUserId: string;
    sessionId: string;
    deviceId: string;
  },
  familyId: string,
  input: {
    operationId: string;
    confirmFamilyName: string;
    reauthToken: string;
  },
): Promise<{ jobId: string; state: 'queued' }> {
  const result = await withUserWrite<{ jobId: string; state: 'queued' }>(pool, {
    actorUserId: identity.actorUserId,
    operationId: input.operationId,
    action: 'family.delete.request',
    request: {
      familyId,
      confirmFamilyName: input.confirmFamilyName,
      reauthTokenHash: tokenHash(input.reauthToken),
    },
  }, async client => {
    await lockFamilyForDeletion(client, familyId);
    const family = await client.query<{ name: string; revision: string }>(`
      SELECT name,revision
      FROM app.families
      WHERE id=$1 AND deleted_at IS NULL
      FOR UPDATE
    `, [familyId]);
    const row = family.rows[0];
    if (!row) throw notFound();
    const access = await client.query<{ role: 'owner' | 'caregiver' }>(`
      SELECT role FROM app.family_members
      WHERE family_id=$1 AND user_id=$2 AND active
    `, [familyId, identity.actorUserId]);
    if (!access.rows[0]) throw notFound();
    if (access.rows[0].role !== 'owner') {
      throw new AppError(403, 'OWNER_REQUIRED', '仅家庭所有者可以删除家庭');
    }
    if (row.name !== input.confirmFamilyName) {
      throw new AppError(422, 'FAMILY_NAME_MISMATCH', '家庭名称确认不一致');
    }
    await consumeReauthToken(client, {
      token: input.reauthToken,
      userId: identity.actorUserId,
      sessionId: identity.sessionId,
      deviceId: identity.deviceId,
      scope: 'family_delete',
    });

    await registerDeletion(client, journal, {
      kind: 'family', id: familyId, familyId, memoryId: null,
    });

    const jobId = randomUUID();
    await client.query(`
      INSERT INTO app.jobs(id,type,state,requested_by,family_id,resource_id)
      VALUES($1,'family_delete','queued',$2,$3,$3)
    `, [jobId, identity.actorUserId, familyId]);
    await client.query(`
      INSERT INTO app.family_deletion_tombstones(
        family_id,family_name_hash,requested_by_hash,requested_at
      ) VALUES($1,$2,$3,now())
    `, [
      familyId,
      createHash('sha256').update(row.name).digest('hex'),
      createHash('sha256').update(identity.actorUserId).digest('hex'),
    ]);
    await client.query(`
      UPDATE app.families
      SET revision=revision+1,deleted_at=now(),deletion_requested_at=now(),deletion_job_id=$2
      WHERE id=$1
    `, [familyId, jobId]);
    await client.query(`
      UPDATE app.family_members
      SET active=false,revision=revision+1
      WHERE family_id=$1
    `, [familyId]);
    return { statusCode: 202, body: { jobId, state: 'queued' as const } };
  });
  return result.body;
}

export async function createInvitation(
  pool: Pool,
  identity: { familyId: string; actorUserId: string; operationId: string; deviceId: string },
  code?: string,
): Promise<{ id: string; invitationToken: string; expiresAt: string }> {
  const customCode = typeof code === 'string';
  const invitationToken = code ?? opaqueToken();
  const invitationTokenHash = tokenHash(invitationToken);
  const result = await withFamilyWrite<{ id: string; expiresAt: string; invitationToken?: string }>(pool, {
    ...identity,
    action: 'invitation.create',
    request: customCode ? { tokenHash: invitationTokenHash } : { generated: true },
  }, async ({ client, familyId, appendChange }) => {
    const id = randomUUID();
    const expires = await client.query<{ expires_at: Date }>(
      "SELECT now() + interval '24 hours' AS expires_at",
    );
    const expiresAt = expires.rows[0]!.expires_at.toISOString();
    const inserted = await client.query(`
      INSERT INTO app.invitations(id,family_id,token_hash,created_by,expires_at)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (token_hash) DO NOTHING
      RETURNING id
    `, [id, familyId, invitationTokenHash, identity.actorUserId, expiresAt]);
    if (!inserted.rowCount) {
      throw new AppError(409, 'INVITATION_CODE_EXISTS', '这个邀请码已存在，请换一个');
    }
    const family = await getFamily(client, familyId);
    await appendChange({
      entity: 'family',
      id: familyId,
      revision: family.revision,
      deleted: false,
      payload: family,
    });
    return {
      statusCode: 201,
      body: {
        id,
        expiresAt,
        ...(customCode ? {} : { invitationToken }),
      },
    };
  }, role => {
    if (role !== 'owner') throw new AppError(403, 'OWNER_REQUIRED', '仅家庭所有者可以邀请成员');
  });
  return {
    id: result.body.id,
    expiresAt: result.body.expiresAt,
    invitationToken: customCode ? invitationToken : result.body.invitationToken!,
  };
}

export async function acceptInvitation(
  pool: Pool,
  actorUserId: string,
  deviceId: string,
  input: { operationId: string; token: string },
): Promise<FamilyDto> {
  const hashed = tokenHash(input.token);
  return withTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [operationLock(actorUserId, input.operationId)]);
    const invitation = await client.query<{
      id: string; family_id: string; expires_at: Date; accepted_by: string | null; accepted_at: Date | null; revoked_at: Date | null;
    }>(`
      SELECT id,family_id,expires_at,accepted_by,accepted_at,revoked_at
      FROM app.invitations WHERE token_hash=$1 FOR UPDATE
    `, [hashed]);
    const row = invitation.rows[0];
    if (!row) throw notFound();
    const operation = {
      familyId: row.family_id,
      actorUserId,
      operationId: input.operationId,
      deviceId,
      action: 'invitation.accept',
      request: { tokenHash: hashed },
    };
    const previous = await client.query<{ request_hash: string; result: FamilyDto }>(
      'SELECT request_hash,result FROM app.operations WHERE actor_user_id=$1 AND operation_id=$2',
      [actorUserId, input.operationId],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== requestHash(operation)) {
        throw new AppError(409, 'OPERATION_REUSED', '同一操作标识不能用于不同内容');
      }
      return previous.rows[0].result;
    }
    if (row.revoked_at || row.expires_at.getTime() <= Date.now()) {
      throw new AppError(409, 'INVITATION_UNAVAILABLE', '邀请已过期或不可用');
    }
    if (row.accepted_at || row.accepted_by) {
      throw new AppError(409, 'INVITATION_USED', '邀请已被使用');
    }
    const existing = await client.query<{ role: 'owner' | 'caregiver'; active: boolean }>(
      'SELECT role,active FROM app.family_members WHERE family_id=$1 AND user_id=$2',
      [row.family_id, actorUserId],
    );
    if (existing.rows[0]?.active) throw new AppError(409, 'ALREADY_MEMBER', '当前账号已经加入该家庭');
    if (existing.rows[0]) {
      await client.query(
        `UPDATE app.family_members SET active=true,revision=revision+1,joined_at=now() WHERE family_id=$1 AND user_id=$2`,
        [row.family_id, actorUserId],
      );
    } else {
      await client.query(
        `INSERT INTO app.family_members(family_id,user_id,role) VALUES($1,$2,'caregiver')`,
        [row.family_id, actorUserId],
      );
    }
    await client.query('UPDATE app.invitations SET accepted_by=$2,accepted_at=now() WHERE id=$1', [row.id, actorUserId]);
    await client.query('UPDATE app.families SET revision=revision+1 WHERE id=$1', [row.family_id]);
    const family = await getFamily(client, row.family_id);
    const member = family.members.find(item => item.userId === actorUserId)!;
    await appendInitialChange(client, row.family_id, 'family', row.family_id, family.revision, family);
    await appendInitialChange(client, row.family_id, 'member', actorUserId, member.revision, member);
    await client.query(`
      INSERT INTO app.operations(
        actor_user_id,operation_id,family_id,device_id,action,request_hash,response_status,result
      ) VALUES($1,$2,$3,$4,$5,$6,200,$7)
    `, [actorUserId, input.operationId, row.family_id, deviceId, operation.action, requestHash(operation), family]);
    return family;
  });
}

export type RedeemedInvitation = IssuedSession & { family: FamilyDto };

/**
 * 邀请注册不开放自由注册。账号、家庭成员、邀请消费和设备会话在同一事务内
 * 提交；同一 operationId 重试只签发新的设备会话，不会重复创建账号或成员。
 */
export async function redeemInvitation(
  pool: Pool,
  input: {
    operationId: string;
    token: string;
    email: string;
    displayName: string;
    deviceId: string;
    clientType: 'mobile' | 'web';
  } & Record<string, string>,
): Promise<RedeemedInvitation> {
  const suppliedCredential = input[credentialField];
  if (typeof suppliedCredential !== 'string') {
    throw new AppError(400, 'INVALID_REQUEST', '输入格式不正确，请检查后重试');
  }
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const invitationTokenHash = tokenHash(input.token);
  const encodedCredential = await hashPassword(suppliedCredential);
  const requestFingerprint = requestHash({
    familyId: '',
    action: 'invitation.redeem',
    request: {
      tokenHash: invitationTokenHash,
      credentialDigest: createHash('sha256')
        .update(suppliedCredential)
        .digest('hex'),
      email,
      displayName,
      deviceId: input.deviceId,
      clientType: input.clientType,
    },
  });

  return withTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      operationLock(`invitation:${invitationTokenHash}`, input.operationId),
    ]);
    const invitation = await client.query<{
      id: string;
      family_id: string;
      expires_at: Date;
      accepted_by: string | null;
      accepted_at: Date | null;
      revoked_at: Date | null;
      redemption_operation_id: string | null;
      redemption_request_hash: string | null;
    }>(`
      SELECT id,family_id,expires_at,accepted_by,accepted_at,revoked_at,
             redemption_operation_id,redemption_request_hash
      FROM app.invitations
      WHERE token_hash=$1
      FOR UPDATE
    `, [invitationTokenHash]);
    const row = invitation.rows[0];
    if (!row) throw notFound();

    if (row.redemption_operation_id === input.operationId) {
      if (row.redemption_request_hash !== requestFingerprint || !row.accepted_by) {
        throw new AppError(409, 'OPERATION_REUSED', '同一操作标识不能用于不同内容');
      }
      const replayedUser = await client.query<{ id: string; display_name: string | null }>(
        'SELECT id,display_name FROM app.users WHERE id=$1 AND disabled_at IS NULL',
        [row.accepted_by],
      );
      if (!replayedUser.rows[0]) throw notFound();
      const family = await getFamily(client, row.family_id);
      const session = await issueSessionInTransaction(
        client,
        {
          id: replayedUser.rows[0].id,
          displayName: replayedUser.rows[0].display_name,
        },
        { deviceId: input.deviceId, clientType: input.clientType },
      );
      return { ...session, family };
    }

    if (row.revoked_at || row.expires_at.getTime() <= Date.now()) {
      throw new AppError(409, 'INVITATION_UNAVAILABLE', '邀请已过期或不可用');
    }
    if (row.accepted_at || row.accepted_by) {
      throw new AppError(409, 'INVITATION_USED', '邀请已被使用');
    }

    const existingEmail = await client.query<{ id: string }>(
      'SELECT id FROM app.users WHERE email=$1',
      [email],
    );
    if (existingEmail.rows[0]) {
      throw new AppError(409, 'EMAIL_EXISTS', '这个邮箱已有账号，请登录后再接受邀请');
    }

    const userId = randomUUID();
    await client.query(
      `INSERT INTO app.users(id,email,${credentialField}_hash,display_name)
       VALUES($1,$2,$3,$4)`,
      [userId, email, encodedCredential, displayName],
    );
    await client.query(
      `INSERT INTO app.family_members(family_id,user_id,role)
       VALUES($1,$2,'caregiver')`,
      [row.family_id, userId],
    );
    await client.query(
      `UPDATE app.invitations
       SET accepted_by=$2,accepted_at=now(),redemption_operation_id=$3,
           redemption_request_hash=$4
       WHERE id=$1`,
      [row.id, userId, input.operationId, requestFingerprint],
    );
    await client.query(
      'UPDATE app.families SET revision=revision+1 WHERE id=$1',
      [row.family_id],
    );
    const family = await getFamily(client, row.family_id);
    const member = family.members.find(item => item.userId === userId)!;
    await appendInitialChange(
      client,
      row.family_id,
      'family',
      row.family_id,
      family.revision,
      family,
    );
    await appendInitialChange(
      client,
      row.family_id,
      'member',
      userId,
      member.revision,
      member,
    );
    const session = await issueSessionInTransaction(
      client,
      { id: userId, displayName },
      { deviceId: input.deviceId, clientType: input.clientType },
    );
    return { ...session, family };
  });
}
