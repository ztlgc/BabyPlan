ALTER TABLE app.media
  ADD COLUMN upload_session_id uuid REFERENCES app.sessions(id) ON DELETE SET NULL,
  ADD COLUMN upload_member_revision bigint CHECK (upload_member_revision BETWEEN 1 AND 9007199254740991);

CREATE INDEX media_upload_session_idx ON app.media(upload_session_id) WHERE upload_session_id IS NOT NULL;

-- 旧上传地址没有签发会话；保留期限让已收到的文件仍可正常确认。
UPDATE app.media SET upload_token_hash=NULL WHERE upload_token_hash IS NOT NULL;
