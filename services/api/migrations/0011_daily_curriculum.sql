-- 每日一项与既有六项计划共存。默认值保留原有计划的缺项含义。
ALTER TABLE app.day_plans
  ADD COLUMN planned_kinds jsonb NOT NULL
    DEFAULT '["movement","explore","reading","english","child-led","calm"]'::jsonb
    CHECK (jsonb_typeof(planned_kinds) = 'array');
