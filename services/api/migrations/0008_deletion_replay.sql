-- 备份与实时删除台账共用部署标识。恢复时必须校对最新的独立台账。
CREATE TABLE app.deletion_journal_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  journal_id uuid NOT NULL
);

CREATE TABLE app.permanent_deletions (
  kind text NOT NULL CHECK (kind IN ('family','memory','media')),
  resource_id uuid NOT NULL,
  family_id uuid NOT NULL,
  memory_id uuid,
  requested_at timestamptz NOT NULL,
  cleaned_at timestamptz,
  PRIMARY KEY (kind, resource_id),
  CHECK (kind <> 'family' OR family_id=resource_id),
  CHECK ((kind='media') = (memory_id IS NOT NULL))
);
CREATE INDEX permanent_deletions_pending_idx
  ON app.permanent_deletions(requested_at,kind,resource_id) WHERE cleaned_at IS NULL;

-- 旧版本已知的永久删除也必须进入台账。保留为待清理，核对磁盘及旧导出。
INSERT INTO app.permanent_deletions(kind,resource_id,family_id,memory_id,requested_at)
SELECT 'family',family_id,family_id,NULL::uuid,requested_at FROM app.family_deletion_tombstones
UNION ALL
SELECT 'memory',id,family_id,NULL::uuid,permanently_deleted_at FROM app.memories
  WHERE permanently_deleted_at IS NOT NULL
UNION ALL
SELECT 'media',id,family_id,memory_id,deleted_at FROM app.media
  WHERE state='deleted' AND deleted_at IS NOT NULL;
