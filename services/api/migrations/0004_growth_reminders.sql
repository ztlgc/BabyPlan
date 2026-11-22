-- 成长记录、家庭书架与提醒幂等。保持 PostgreSQL 9.5 兼容。

CREATE TABLE app.books (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.book_editions (
  id uuid PRIMARY KEY,
  book_id uuid NOT NULL REFERENCES app.books(id),
  verified boolean NOT NULL DEFAULT false,
  source_ref text CHECK (source_ref IS NULL OR length(btrim(source_ref)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT verified OR source_ref IS NOT NULL)
);
CREATE INDEX book_editions_book_idx ON app.book_editions(book_id);

CREATE TABLE app.memories (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  child_id uuid NOT NULL,
  local_date date NOT NULL,
  type text NOT NULL CHECK (type IN ('quote','story','first')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  first_confirmed boolean NOT NULL DEFAULT false,
  added_by uuid NOT NULL REFERENCES app.users(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted_at timestamptz,
  permanently_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES app.children(id, family_id),
  CHECK (type <> 'first' OR first_confirmed),
  CHECK (permanently_deleted_at IS NULL OR deleted_at IS NOT NULL)
);
CREATE INDEX memories_family_child_date_idx
  ON app.memories(family_id, child_id, local_date DESC, id DESC)
  WHERE permanently_deleted_at IS NULL;
CREATE INDEX memories_deleted_idx
  ON app.memories(family_id, child_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL AND permanently_deleted_at IS NULL;

CREATE TABLE app.measurements (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  child_id uuid NOT NULL,
  local_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('height','weight')),
  value numeric(8,3) NOT NULL CHECK (value > 0 AND value <= 300),
  unit text NOT NULL CHECK (unit IN ('cm','kg')),
  method text NOT NULL CHECK (method IN ('recumbent','standing','scale')),
  source text NOT NULL CHECK (source IN ('home','clinic')),
  added_by uuid NOT NULL REFERENCES app.users(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES app.children(id, family_id),
  CHECK (
    (kind='height' AND unit='cm' AND method IN ('recumbent','standing'))
    OR (kind='weight' AND unit='kg' AND method='scale')
  )
);
CREATE INDEX measurements_family_child_date_idx
  ON app.measurements(family_id, child_id, local_date DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE app.observations (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  child_id uuid NOT NULL,
  guide_id text NOT NULL CHECK (length(guide_id) BETWEEN 1 AND 60),
  local_date date NOT NULL,
  value text NOT NULL CHECK (value IN ('noticed','not_yet_observed','discuss')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  added_by uuid NOT NULL REFERENCES app.users(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id),
  FOREIGN KEY (child_id, family_id) REFERENCES app.children(id, family_id)
);
CREATE INDEX observations_family_child_date_idx
  ON app.observations(family_id, child_id, local_date DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE app.media (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  memory_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','processing','ready','failed','deleted')),
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  download_url text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, family_id),
  FOREIGN KEY (memory_id, family_id) REFERENCES app.memories(id, family_id)
);
CREATE INDEX media_memory_idx
  ON app.media(family_id, memory_id, created_at, id)
  WHERE deleted_at IS NULL;

CREATE TABLE app.family_books (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  book_id uuid REFERENCES app.books(id),
  edition_id uuid REFERENCES app.book_editions(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  language text NOT NULL CHECK (length(language) BETWEEN 1 AND 60),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  added_by uuid NOT NULL REFERENCES app.users(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id),
  CHECK (book_id IS NOT NULL OR edition_id IS NULL),
  CHECK (edition_id IS NULL OR book_id IS NOT NULL)
);
CREATE INDEX family_books_family_idx
  ON app.family_books(family_id, created_at, id)
  WHERE deleted_at IS NULL;

CREATE TABLE app.user_operations (
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  operation_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  PRIMARY KEY (actor_user_id, operation_id)
);
CREATE INDEX user_operations_expiry_idx ON app.user_operations(expires_at);
