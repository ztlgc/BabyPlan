-- 身份与家庭基础。后续迁移只追加，不回写已经应用的迁移。
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

CREATE TABLE app.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL,
  display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 60),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  device_id uuid NOT NULL,
  client_type text NOT NULL CHECK (client_type IN ('mobile','web')),
  access_token_hash text UNIQUE CHECK (access_token_hash IS NULL OR access_token_hash ~ '^[a-f0-9]{64}$'),
  csrf_token_hash text CHECK (csrf_token_hash IS NULL OR csrf_token_hash ~ '^[a-f0-9]{64}$'),
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (refresh_expires_at >= access_expires_at)
);
CREATE INDEX sessions_user_device_idx ON app.sessions(user_id, device_id);
CREATE INDEX sessions_expiry_idx ON app.sessions(refresh_expires_at);

CREATE TABLE app.refresh_tokens (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES app.sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_session_idx ON app.refresh_tokens(session_id);
CREATE INDEX refresh_tokens_expiry_idx ON app.refresh_tokens(expires_at);

CREATE TABLE app.families (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  timezone text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES app.users(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX families_owner_idx ON app.families(owner_user_id);

CREATE TABLE app.family_members (
  family_id uuid NOT NULL REFERENCES app.families(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  role text NOT NULL CHECK (role IN ('owner','caregiver')),
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)
);
CREATE INDEX family_members_user_active_idx ON app.family_members(user_id, family_id) WHERE active;

CREATE TABLE app.children (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 60),
  age_mode text NOT NULL CHECK (age_mode IN ('months','birthDate')),
  age_months integer CHECK (age_months BETWEEN 0 AND 36),
  age_as_of date,
  birth_date date,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id),
  CHECK ((age_mode='months' AND age_months IS NOT NULL AND age_as_of IS NOT NULL AND birth_date IS NULL)
    OR (age_mode='birthDate' AND birth_date IS NOT NULL AND age_months IS NULL AND age_as_of IS NULL))
);
CREATE INDEX children_family_idx ON app.children(family_id);

CREATE TABLE app.invitations (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES app.users(id),
  accepted_by uuid REFERENCES app.users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL))
);
CREATE INDEX invitations_family_idx ON app.invitations(family_id);
CREATE INDEX invitations_created_by_idx ON app.invitations(created_by);
CREATE INDEX invitations_accepted_by_idx ON app.invitations(accepted_by);

-- 每个家庭具有真正的已提交事件水位，不使用裸 sequence 假定提交先后。
CREATE TABLE app.family_clocks (
  family_id uuid PRIMARY KEY REFERENCES app.families(id),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
  minimum_cursor bigint NOT NULL DEFAULT 0 CHECK (minimum_cursor >= 0 AND minimum_cursor <= last_sequence)
);
CREATE FUNCTION app.create_family_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.family_clocks(family_id) VALUES(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER families_clock AFTER INSERT ON app.families FOR EACH ROW EXECUTE PROCEDURE app.create_family_clock();

CREATE TABLE app.operations (
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  operation_id uuid NOT NULL,
  family_id uuid NOT NULL REFERENCES app.families(id),
  device_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  PRIMARY KEY (actor_user_id, operation_id)
);
CREATE INDEX operations_family_idx ON app.operations(family_id);
CREATE INDEX operations_expiry_idx ON app.operations(expires_at);

CREATE TABLE app.changes (
  family_id uuid NOT NULL REFERENCES app.families(id),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  entity text NOT NULL CHECK (length(entity) BETWEEN 1 AND 80),
  entity_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  deleted boolean NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, sequence),
  CHECK ((deleted AND payload IS NULL) OR (NOT deleted AND payload IS NOT NULL))
);
CREATE INDEX changes_entity_idx ON app.changes(family_id, entity, entity_id, sequence);
