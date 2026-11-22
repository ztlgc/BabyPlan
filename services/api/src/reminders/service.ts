import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { withUserWrite } from '../db/transactions.js';

export type ReminderPreferenceDto = {
  userId: string;
  deviceId: string | null;
  enabled: boolean;
  localTime: string;
  revision: number;
};

type ReminderRow = {
  user_id: string;
  device_id: string | null;
  enabled: boolean;
  local_time: string;
  revision: string | number;
};

function mapReminder(row: ReminderRow): ReminderPreferenceDto {
  return {
    userId: row.user_id,
    deviceId: row.device_id,
    enabled: row.enabled,
    localTime: row.local_time.slice(0, 5),
    revision: Number(row.revision),
  };
}

async function loadReminder(queryable: Pool | PoolClient, userId: string): Promise<ReminderPreferenceDto> {
  const result = await queryable.query<ReminderRow>(`
    SELECT user_id,device_id,enabled,to_char(local_time,'HH24:MI') AS local_time,revision
    FROM app.reminder_preferences WHERE user_id=$1
  `, [userId]);
  if (result.rows[0]) return mapReminder(result.rows[0]);
  return { userId, deviceId: null, enabled: false, localTime: '16:00', revision: 0 };
}

export async function getReminderPreference(pool: Pool, userId: string): Promise<ReminderPreferenceDto> {
  return loadReminder(pool, userId);
}

export async function putReminderPreference(
  pool: Pool,
  userId: string,
  input: {
    operationId: string;
    baseRevision: number;
    deviceId: string | null;
    enabled: boolean;
    localTime: string;
  },
): Promise<ReminderPreferenceDto> {
  if (input.enabled && !input.deviceId) {
    throw new AppError(422, 'DEVICE_REQUIRED', '开启提醒前需要选择一台设备');
  }
  const result = await withUserWrite<ReminderPreferenceDto>(pool, {
    actorUserId: userId,
    operationId: input.operationId,
    action: 'reminder.put',
    request: input,
  }, async client => {
    if (input.deviceId) {
      const session = await client.query(`
        SELECT 1 FROM app.sessions
        WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL AND refresh_expires_at > now()
        ORDER BY created_at DESC LIMIT 1
      `, [userId, input.deviceId]);
      if (!session.rowCount) {
        throw new AppError(422, 'INVALID_DEVICE', '提醒设备必须是当前账号的有效设备');
      }
    }
    const current = await client.query<{ revision: string }>(
      'SELECT revision FROM app.reminder_preferences WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    const revision = current.rows[0] ? Number(current.rows[0].revision) : 0;
    if (revision !== input.baseRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', '提醒设置已在其他设备更新', {
        current: revision,
        submitted: input.baseRevision,
      });
    }
    if (!current.rows[0]) {
      await client.query(`
        INSERT INTO app.reminder_preferences(user_id,device_id,enabled,local_time)
        VALUES($1,$2,$3,$4)
      `, [userId, input.deviceId, input.enabled, input.localTime]);
    } else {
      await client.query(`
        UPDATE app.reminder_preferences
        SET device_id=$2,enabled=$3,local_time=$4,revision=revision+1,updated_at=now()
        WHERE user_id=$1
      `, [userId, input.deviceId, input.enabled, input.localTime]);
    }
    return { statusCode: 200, body: await loadReminder(client, userId) };
  });
  return result.body;
}
