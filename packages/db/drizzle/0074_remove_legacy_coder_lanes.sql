-- Coder configuration no longer contains parallel developer lanes. Remove
-- those keys from current settings while preserving captured Run snapshots as
-- read-only evidence.
UPDATE coders
SET roles = (
  SELECT json_group_array(json_remove(role.value, '$.developerInstances', '$.developerConcurrency'))
  FROM json_each(coders.roles) AS role
  WHERE json_extract(role.value, '$.role') IS NULL
     OR json_extract(role.value, '$.role') NOT IN ('dispatcher', 'executor-manager', 'worktree-manager')
)
WHERE json_valid(roles)
  AND json_type(roles) = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(coders.roles) AS role
    WHERE json_type(role.value, '$.developerInstances') IS NOT NULL
       OR json_type(role.value, '$.developerConcurrency') IS NOT NULL
       OR json_extract(role.value, '$.role') IN ('dispatcher', 'executor-manager', 'worktree-manager')
  );
