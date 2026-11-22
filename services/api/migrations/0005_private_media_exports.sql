-- 私有媒体、短期签名访问与家庭导出。保持 PostgreSQL 9.5 兼容。

ALTER TABLE app.media
  ADD COLUMN object_key text,
  ADD COLUMN source_sha256 text,
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  ADD COLUMN upload_token_hash text,
  ADD COLUMN upload_expires_at timestamptz,
  ADD COLUMN download_token_hash text,
  ADD COLUMN download_expires_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE app.media
SET source_sha256=sha256
WHERE source_sha256 IS NULL;

CREATE UNIQUE INDEX media_object_key_idx
  ON app.media(object_key)
  WHERE object_key IS NOT NULL;
CREATE INDEX media_upload_token_idx
  ON app.media(upload_token_hash)
  WHERE upload_token_hash IS NOT NULL;
CREATE INDEX media_download_token_idx
  ON app.media(download_token_hash)
  WHERE download_token_hash IS NOT NULL;

CREATE TABLE app.exports (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES app.families(id),
  created_by uuid NOT NULL REFERENCES app.users(id),
  from_date date NOT NULL,
  to_date date NOT NULL,
  types text[] NOT NULL CHECK (array_length(types, 1) BETWEEN 1 AND 4),
  include_media boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('queued','running','ready','failed','expired')),
  object_key text,
  missing_media jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  available_until timestamptz,
  download_token_hash text,
  download_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, family_id),
  CHECK (from_date <= to_date),
  CHECK (status NOT IN ('ready','expired') OR object_key IS NOT NULL)
);
CREATE INDEX exports_family_created_idx
  ON app.exports(family_id, created_at DESC, id DESC);
CREATE INDEX exports_download_token_idx
  ON app.exports(download_token_hash)
  WHERE download_token_hash IS NOT NULL;
