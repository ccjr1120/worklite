-- Rename the QuickCoder role id `executor` to `implementer`. The execution engine field
-- (role.executor: 'claude'/'codex') and the retired `executor-manager` role id keep their
-- names; only the role id literal `executor` changes. Historical coder_versions snapshots,
-- coder_run_events and coder_task_attempts stay as captured, matching the 0063 precedent of
-- leaving log and event history untouched.
UPDATE coders
SET roles = (
  SELECT json_group_array(json(CASE
    WHEN json_extract(value, '$.role') = 'executor'
    THEN json_set(value, '$.role', 'implementer')
    ELSE value END))
  FROM json_each(coders.roles)
), updated_at = max(updated_at + 1, unixepoch() * 1000)
WHERE deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM json_each(coders.roles) WHERE json_extract(value, '$.role') = 'executor'
);
