-- 账号恢复、敏感操作再认证、家庭删除墓碑与统一后台任务。
-- 保持 PostgreSQL 9.5 兼容；0006 已冻结，本迁移只追加所需状态。

ALTER TABLE app.families
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_job_id uuid;

CREATE TABLE app.account_recovery_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  requested_email_hash text NOT NULL CHECK (requested_email_hash ~ '^[a-f0-9]{64}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX account_recovery_requests_user_created_idx
  ON app.account_recovery_requests(user_id, created_at DESC);
CREATE INDEX account_recovery_requests_expiry_idx
  ON app.account_recovery_requests(expires_at)
  WHERE used_at IS NULL;

CREATE TABLE app.reauth_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  session_id uuid NOT NULL REFERENCES app.sessions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX reauth_tokens_session_scope_idx
  ON app.reauth_tokens(session_id, scope, created_at DESC);
CREATE INDEX reauth_tokens_expiry_idx
  ON app.reauth_tokens(expires_at)
  WHERE consumed_at IS NULL;

-- job.family_id 故意不设外键：家庭清理完成后，发起人仍需查询删除任务。
CREATE TABLE app.jobs (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('family_delete','media_delete','export')),
  state text NOT NULL CHECK (state IN ('queued','running','ready','failed')),
  requested_by uuid NOT NULL REFERENCES app.users(id),
  family_id uuid NOT NULL,
  resource_id uuid,
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_requester_created_idx
  ON app.jobs(requested_by, created_at DESC, id DESC);
CREATE INDEX jobs_state_idx
  ON app.jobs(state, created_at)
  WHERE state IN ('queued','running');

CREATE TABLE app.family_deletion_tombstones (
  family_id uuid PRIMARY KEY,
  family_name_hash text NOT NULL CHECK (family_name_hash ~ '^[a-f0-9]{64}$'),
  requested_by_hash text NOT NULL CHECK (requested_by_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX family_deletion_tombstones_pending_idx
  ON app.family_deletion_tombstones(requested_at)
  WHERE completed_at IS NULL;
