-- Remove roles from retired orchestration versions while preserving every current
-- user-configured role, then add the stable, server-owned Router role.
UPDATE coders
SET roles = (
  SELECT json_group_array(json(value))
  FROM (
    SELECT value
    FROM json_each(coders.roles)
    WHERE json_extract(value, '$.role') NOT IN ('dispatcher', 'executor-manager')
    ORDER BY CAST(key AS INTEGER)
  )
)
WHERE json_valid(roles)
  AND json_type(roles) = 'array';
--> statement-breakpoint
UPDATE coders
SET roles = json_insert(
  roles,
  '$[#]',
  json_object(
    'role', 'router',
    'displayName', 'Router',
    'publicModelId', '',
    'instructions', 'Coordinate this task continuously. Use only captured roles and the authorized repository scope. Decide whether to answer directly, ask one material question, or assign one or more concrete role tasks. Every role result returns to Router; make the next decision from the persisted results. Never hand work directly from one role to another. Do not use fixed role order or infer the implementation role from configuration order. Do not dispatch deployment or other protected operations unless the user authorized them and the selected role has the required capability.',
    'entryPoints', json('[]'),
    'skills', json('[]'),
    'mcpServers', json('[]'),
    'toolNames', json('["read","glob","grep","process_reference"]')
  )
)
WHERE json_valid(roles)
  AND json_type(roles) = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(coders.roles)
    WHERE json_extract(json_each.value, '$.role') = 'router'
  );
