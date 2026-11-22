-- 内容修订、每日计划、参与和提醒事实。迁移兼容当前开发环境 PostgreSQL 9.5。
CREATE TABLE app.family_preferences (
  family_id uuid PRIMARY KEY REFERENCES app.families(id),
  available_materials jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluded_materials jsonb NOT NULL DEFAULT '[]'::jsonb,
  language_mode text NOT NULL DEFAULT 'zh_with_english'
    CHECK (language_mode IN ('zh','zh_with_english')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(available_materials) = 'array'),
  CHECK (jsonb_typeof(excluded_materials) = 'array')
);

CREATE TABLE app.content_releases (
  id uuid PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  environment text NOT NULL CHECK (environment IN ('development','private_trial','public')),
  status text NOT NULL CHECK (status IN ('draft','published','withdrawn')),
  package_id text NOT NULL,
  content_version integer NOT NULL CHECK (content_version > 0),
  self_reviewed boolean NOT NULL DEFAULT false,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  withdrawn_at timestamptz,
  withdrawal_kind text CHECK (withdrawal_kind IN ('editorial','safety')),
  withdrawal_reason text,
  CHECK (jsonb_typeof(evidence_refs) = 'array'),
  UNIQUE (environment, version)
);
CREATE INDEX content_releases_active_idx
  ON app.content_releases(environment, published_at DESC)
  WHERE status = 'published';

CREATE TABLE app.activity_revisions (
  id uuid PRIMARY KEY,
  activity_id text NOT NULL CHECK (length(activity_id) BETWEEN 1 AND 60),
  revision integer NOT NULL CHECK (revision > 0),
  package_id text NOT NULL,
  content_version integer NOT NULL CHECK (content_version > 0),
  kind text NOT NULL CHECK (kind IN ('movement','explore','reading','english','child-led','calm')),
  age_bands jsonb NOT NULL,
  title text NOT NULL,
  support text NOT NULL,
  materials jsonb NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  review_state text NOT NULL CHECK (review_state IN ('draft','reviewed')),
  test_fixture boolean NOT NULL DEFAULT false,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, revision),
  CHECK (jsonb_typeof(age_bands) = 'array'),
  CHECK (jsonb_typeof(materials) = 'array')
);
CREATE INDEX activity_revisions_release_idx
  ON app.activity_revisions(package_id, content_version, review_state, kind);
CREATE INDEX activity_revisions_active_idx
  ON app.activity_revisions(activity_id, revision DESC)
  WHERE withdrawn_at IS NULL;

CREATE TABLE app.content_release_revisions (
  release_id uuid NOT NULL REFERENCES app.content_releases(id),
  activity_revision_id uuid NOT NULL REFERENCES app.activity_revisions(id),
  PRIMARY KEY (release_id, activity_revision_id)
);
CREATE INDEX content_release_revisions_revision_idx
  ON app.content_release_revisions(activity_revision_id);

CREATE TABLE app.day_plans (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  child_id uuid NOT NULL,
  local_date date NOT NULL,
  timezone text NOT NULL,
  mode text NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard','lite')),
  generation_version text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_id, local_date),
  UNIQUE (id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES app.children(id, family_id)
);
CREATE INDEX day_plans_family_date_idx ON app.day_plans(family_id, local_date);

CREATE TABLE app.plan_items (
  id uuid PRIMARY KEY,
  day_plan_id uuid NOT NULL REFERENCES app.day_plans(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES app.families(id),
  child_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 11),
  kind text NOT NULL CHECK (kind IN ('movement','explore','reading','english','child-led','calm')),
  block text NOT NULL CHECK (block IN ('before','after','bedtime')),
  budget_minutes integer NOT NULL CHECK (budget_minutes BETWEEN 1 AND 30),
  activity_revision_id uuid NOT NULL REFERENCES app.activity_revisions(id),
  snapshot jsonb NOT NULL,
  locked_by_parent boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  visibility text NOT NULL DEFAULT 'active' CHECK (visibility IN ('active','hidden')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day_plan_id, position),
  UNIQUE (id, family_id),
  UNIQUE (id, child_id),
  FOREIGN KEY (child_id, family_id) REFERENCES app.children(id, family_id)
);
CREATE INDEX plan_items_family_idx ON app.plan_items(family_id, activity_revision_id);

CREATE TABLE app.participations (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  child_id uuid NOT NULL,
  plan_item_id uuid,
  status text NOT NULL CHECK (status IN ('played','skipped')),
  participant_ids jsonb NOT NULL,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  actual_minutes integer CHECK (actual_minutes BETWEEN 0 AND 1440),
  added_by uuid NOT NULL REFERENCES app.users(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_item_id),
  UNIQUE (id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES app.children(id, family_id),
  FOREIGN KEY (plan_item_id, family_id) REFERENCES app.plan_items(id, family_id),
  CHECK (jsonb_typeof(participant_ids) = 'array'),
  CHECK (jsonb_typeof(notes) = 'array')
);
CREATE INDEX participations_family_child_idx ON app.participations(family_id, child_id, created_at DESC);

CREATE TABLE app.play_sessions (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  family_id uuid NOT NULL REFERENCES app.families(id),
  child_id uuid NOT NULL,
  plan_item_id uuid,
  local_date date NOT NULL,
  activity_id text NOT NULL,
  activity_revision integer NOT NULL CHECK (activity_revision > 0),
  activity_snapshot jsonb NOT NULL,
  participant_ids jsonb NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  added_by uuid NOT NULL REFERENCES app.users(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (added_by, operation_id),
  FOREIGN KEY (child_id, family_id) REFERENCES app.children(id, family_id),
  FOREIGN KEY (plan_item_id, family_id) REFERENCES app.plan_items(id, family_id),
  CHECK (jsonb_typeof(participant_ids) = 'array')
);
CREATE INDEX play_sessions_family_child_idx ON app.play_sessions(family_id, child_id, local_date DESC);

CREATE TABLE app.reminder_preferences (
  user_id uuid PRIMARY KEY REFERENCES app.users(id),
  device_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  local_time time NOT NULL DEFAULT '16:00',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((enabled AND device_id IS NOT NULL) OR NOT enabled)
);

CREATE FUNCTION app.create_family_preferences() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.family_preferences(family_id) VALUES(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER families_preferences AFTER INSERT ON app.families
  FOR EACH ROW EXECUTE PROCEDURE app.create_family_preferences();

INSERT INTO app.family_preferences(family_id)
SELECT id FROM app.families WHERE NOT EXISTS (
  SELECT 1 FROM app.family_preferences p WHERE p.family_id = app.families.id
);
