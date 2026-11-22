-- 每次签发独立的随机链接，下载时重新核对签发会话及当时的成员修订。
CREATE TABLE app.media_download_links (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  media_id uuid NOT NULL REFERENCES app.media(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES app.sessions(id) ON DELETE CASCADE,
  member_revision bigint NOT NULL CHECK (member_revision BETWEEN 1 AND 9007199254740991),
  expires_at timestamptz NOT NULL
);
CREATE INDEX media_download_links_media_idx ON app.media_download_links(media_id);
CREATE INDEX media_download_links_session_idx ON app.media_download_links(session_id);
CREATE INDEX media_download_links_expiry_idx ON app.media_download_links(expires_at);

-- 升级前的链接没有签发人，不再接受；保留旧列供现有清理流程兼容。
UPDATE app.media SET download_token_hash=NULL,download_expires_at=NULL
WHERE download_token_hash IS NOT NULL OR download_expires_at IS NOT NULL;
