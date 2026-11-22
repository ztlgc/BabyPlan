-- 最小核心闭环所需的部署授权、内容角色与合同字段补充。
CREATE TABLE app.deployment_admins (
  user_id uuid PRIMARY KEY REFERENCES app.users(id),
  created_by uuid REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.content_roles (
  user_id uuid NOT NULL REFERENCES app.users(id),
  role text NOT NULL CHECK (role IN ('editor','reviewer','publisher')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

ALTER TABLE app.content_releases
  ADD COLUMN package_snapshot jsonb;

ALTER TABLE app.participations
  ADD COLUMN again boolean NOT NULL DEFAULT false;

CREATE INDEX invitations_expiry_idx ON app.invitations(expires_at);
CREATE INDEX participations_plan_active_idx
  ON app.participations(plan_item_id)
  WHERE deleted_at IS NULL;
