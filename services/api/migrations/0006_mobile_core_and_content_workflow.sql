-- 手机核心闭环与内容审读工作台。迁移保持 PostgreSQL 9.5 兼容。

-- 轻松一天会临时缩小未开始项目预算；恢复标准模式时必须回到原始预算。
ALTER TABLE app.plan_items
  ADD COLUMN base_budget_minutes integer;
UPDATE app.plan_items SET base_budget_minutes=budget_minutes;
ALTER TABLE app.plan_items
  ALTER COLUMN base_budget_minutes SET NOT NULL,
  ADD CONSTRAINT plan_items_base_budget_minutes_check
    CHECK (base_budget_minutes BETWEEN 1 AND 30);

-- 无账号邀请注册需要一个不保存原始口令或原始会话令牌的幂等标记。
ALTER TABLE app.invitations
  ADD COLUMN redemption_operation_id uuid,
  ADD COLUMN redemption_request_hash text;

-- 发布版本必须明确切换单一活跃版本；撤回后不能悄悄回退到旧版本。
ALTER TABLE app.content_releases
  ADD COLUMN active boolean NOT NULL DEFAULT false;
UPDATE app.content_releases cr
SET active=true
FROM (
  SELECT DISTINCT ON (environment) id
  FROM app.content_releases
  WHERE status='published'
  ORDER BY environment,published_at DESC NULLS LAST,version DESC
) selected
WHERE cr.id=selected.id;
CREATE UNIQUE INDEX content_releases_one_active_idx
  ON app.content_releases(environment)
  WHERE active;

CREATE TABLE app.content_sources (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 60),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  url text NOT NULL,
  verified_on date NOT NULL,
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (url ~ '^https?://')
);

INSERT INTO app.content_sources(id,title,url,verified_on,scope)
SELECT DISTINCT ON (source->>'id')
  source->>'id',
  source->>'title',
  source->>'url',
  (source->>'verifiedOn')::date,
  source->>'scope'
FROM app.content_releases release
CROSS JOIN LATERAL jsonb_array_elements(release.package_snapshot->'sources') source
WHERE release.package_snapshot IS NOT NULL
  AND release.package_snapshot ? 'sources'
ORDER BY source->>'id',release.version DESC,release.published_at DESC NULLS LAST;

CREATE TABLE app.content_revision_workflow (
  revision_id uuid PRIMARY KEY REFERENCES app.activity_revisions(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','approved','published','withdrawn')),
  author_id uuid NOT NULL REFERENCES app.users(id),
  change_note text NOT NULL DEFAULT '' CHECK (length(change_note) <= 2000),
  review_note text NOT NULL DEFAULT '' CHECK (length(review_note) <= 2000),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES app.users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(evidence_refs) = 'array')
);
CREATE INDEX content_revision_workflow_status_idx
  ON app.content_revision_workflow(status,created_at DESC,revision_id DESC);

CREATE TABLE app.content_review_evidence (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  kind text NOT NULL
    CHECK (kind IN ('editorial_review','expert_review','family_trial','rights_license')),
  card_id text NOT NULL CHECK (length(card_id) BETWEEN 1 AND 60),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 100),
  actor_kind text NOT NULL DEFAULT 'human' CHECK (actor_kind='human'),
  evidence_created_at timestamptz NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 1000),
  author_id text,
  self_reviewed boolean,
  checks jsonb,
  qualification_ref text,
  completed_at timestamptz,
  authorization_ref text,
  scope text,
  allowed_environments text[],
  record jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  inserted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (self_reviewed IS NULL OR jsonb_typeof(checks)='array' OR kind='expert_review'),
  CHECK (allowed_environments IS NULL OR array_length(allowed_environments,1) BETWEEN 1 AND 2)
);
CREATE INDEX content_review_evidence_revision_idx
  ON app.content_review_evidence(card_id,revision_number,content_hash,kind,decision);

CREATE TABLE app.content_operations (
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  operation_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  PRIMARY KEY (actor_user_id,operation_id)
);
CREATE INDEX content_operations_expiry_idx ON app.content_operations(expires_at);
