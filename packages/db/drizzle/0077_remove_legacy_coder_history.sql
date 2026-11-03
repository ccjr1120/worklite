-- Coder history is Router-only from orchestration v12 onward. Remove every
-- pre-Router Run and the evidence that exists only to display or recover it.
CREATE TEMP TABLE legacy_coder_run_ids AS
SELECT r.id
FROM coder_runs r
JOIN coder_versions v ON v.id = r.coder_version_id
WHERE COALESCE(json_extract(v.snapshot, '$.orchestrationVersion'), 1) < 12;
--> statement-breakpoint
CREATE TEMP TABLE router_coder_source_messages AS
SELECT r.group_message_id AS id
FROM coder_runs r
JOIN coder_versions v ON v.id = r.coder_version_id
WHERE json_extract(v.snapshot, '$.orchestrationVersion') = 12
  AND r.group_message_id IS NOT NULL
UNION
SELECT json_extract(r.group_context, '$.initialMessageId') AS id
FROM coder_runs r
JOIN coder_versions v ON v.id = r.coder_version_id
WHERE json_extract(v.snapshot, '$.orchestrationVersion') = 12
  AND json_extract(r.group_context, '$.initialMessageId') IS NOT NULL;
--> statement-breakpoint
DELETE FROM chat_submissions
WHERE json_extract(reference, '$.kind') = 'coder'
  AND json_extract(reference, '$.runId') IN (SELECT id FROM legacy_coder_run_ids);
--> statement-breakpoint
UPDATE coder_group_messages
SET submission_id = NULL
WHERE submission_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM chat_submissions WHERE chat_submissions.id = coder_group_messages.submission_id);
--> statement-breakpoint
UPDATE coder_memories
SET source_run_id = NULL,
    source_task_attempt_id = NULL
WHERE source_run_id IN (SELECT id FROM legacy_coder_run_ids)
   OR source_task_attempt_id IN (
     SELECT a.id FROM coder_task_attempts a
     WHERE a.run_id IN (SELECT id FROM legacy_coder_run_ids)
   );
--> statement-breakpoint
DELETE FROM coder_memories WHERE role IS NOT NULL;
--> statement-breakpoint
UPDATE coder_runs
SET group_context = json_set(
  group_context,
  '$.memories',
  json(COALESCE((
    SELECT json_group_array(json_object(
      'id', json_extract(memory.value, '$.id'),
      'repositoryId', json_extract(memory.value, '$.repositoryId'),
      'content', json_extract(memory.value, '$.content')
    ))
    FROM json_each(coder_runs.group_context, '$.memories') AS memory
    WHERE json_type(memory.value, '$.role') IS NULL
       OR json_type(memory.value, '$.role') = 'null'
  ), '[]'))
)
WHERE group_context IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM coder_versions v
    WHERE v.id = coder_runs.coder_version_id
      AND json_extract(v.snapshot, '$.orchestrationVersion') = 12
  );
--> statement-breakpoint
UPDATE coder_runs
SET group_context = json_remove(group_context, '$.continuation')
WHERE json_extract(group_context, '$.continuation.sourceRunId') IN (SELECT id FROM legacy_coder_run_ids)
   OR json_extract(group_context, '$.continuation.sourceTaskAttemptId') IN (
     SELECT a.id FROM coder_task_attempts a
     WHERE a.run_id IN (SELECT id FROM legacy_coder_run_ids)
   );
--> statement-breakpoint
UPDATE coder_group_messages
SET kind = CASE WHEN sender = 'role' THEN 'result' ELSE 'text' END
WHERE kind = 'handoff';
--> statement-breakpoint
UPDATE coder_group_events
SET payload = json_set(
  payload,
  '$.message.kind',
  (SELECT m.kind FROM coder_group_messages m WHERE m.id = json_extract(coder_group_events.payload, '$.message.id')),
  '$.message.submissionId',
  (SELECT m.submission_id FROM coder_group_messages m WHERE m.id = json_extract(coder_group_events.payload, '$.message.id'))
)
WHERE type = 'message'
  AND EXISTS (
    SELECT 1 FROM coder_group_messages m
    WHERE m.id = json_extract(coder_group_events.payload, '$.message.id')
  );
--> statement-breakpoint
UPDATE coder_group_messages
SET submission_id = NULL
WHERE run_id IN (SELECT id FROM legacy_coder_run_ids)
  AND id IN (SELECT id FROM router_coder_source_messages);
--> statement-breakpoint
UPDATE coder_group_events
SET payload = json_remove(payload, '$.message.runId', '$.message.taskAttemptId', '$.message.submissionId')
WHERE type = 'message'
  AND json_extract(payload, '$.message.id') IN (
    SELECT m.id
    FROM coder_group_messages m
    WHERE m.run_id IN (SELECT id FROM legacy_coder_run_ids)
      AND m.id IN (SELECT id FROM router_coder_source_messages)
  );
--> statement-breakpoint
DELETE FROM coder_group_messages
WHERE run_id IN (SELECT id FROM legacy_coder_run_ids)
  AND id NOT IN (SELECT id FROM router_coder_source_messages);
--> statement-breakpoint
DELETE FROM coder_runs WHERE id IN (SELECT id FROM legacy_coder_run_ids);
--> statement-breakpoint
DELETE FROM coder_groups
WHERE NOT EXISTS (
  SELECT 1
  FROM coder_runs r
  JOIN coder_versions v ON v.id = r.coder_version_id
  WHERE r.group_id = coder_groups.id
    AND json_extract(v.snapshot, '$.orchestrationVersion') = 12
);
--> statement-breakpoint
DELETE FROM coder_group_messages
WHERE group_id IN (
  SELECT DISTINCT r.group_id
  FROM coder_runs r
  JOIN coder_versions v ON v.id = r.coder_version_id
  WHERE json_extract(v.snapshot, '$.orchestrationVersion') = 12
    AND r.group_id IS NOT NULL
)
  AND id NOT IN (SELECT id FROM router_coder_source_messages)
  AND NOT EXISTS (
    SELECT 1
    FROM coder_runs r
    JOIN coder_versions v ON v.id = r.coder_version_id
    WHERE r.id = coder_group_messages.run_id
      AND json_extract(v.snapshot, '$.orchestrationVersion') = 12
  );
--> statement-breakpoint
DELETE FROM coder_group_events
WHERE group_id IN (
  SELECT DISTINCT r.group_id
  FROM coder_runs r
  JOIN coder_versions v ON v.id = r.coder_version_id
  WHERE json_extract(v.snapshot, '$.orchestrationVersion') = 12
    AND r.group_id IS NOT NULL
)
  AND NOT (
    type = 'run.updated'
    AND json_extract(payload, '$.runId') IN (
      SELECT r.id
      FROM coder_runs r
      JOIN coder_versions v ON v.id = r.coder_version_id
      WHERE json_extract(v.snapshot, '$.orchestrationVersion') = 12
    )
  )
  AND NOT (
    type = 'message'
    AND json_extract(payload, '$.message.id') IN (
      SELECT id FROM coder_group_messages
    )
  );
--> statement-breakpoint
DELETE FROM coder_versions
WHERE COALESCE(json_extract(snapshot, '$.orchestrationVersion'), 1) < 12
  AND NOT EXISTS (
    SELECT 1 FROM coder_runs WHERE coder_runs.coder_version_id = coder_versions.id
  );
--> statement-breakpoint
DROP INDEX coder_memories_scope_idx;
--> statement-breakpoint
CREATE INDEX coder_memories_scope_idx ON coder_memories (coder_id, coder_repository_id, updated_at);
--> statement-breakpoint
ALTER TABLE coder_memories DROP COLUMN role;
--> statement-breakpoint
DROP INDEX coder_group_messages_attempt_completion_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_group_messages_attempt_completion_idx
ON coder_group_messages (task_attempt_id)
WHERE kind IN ('text', 'result');
--> statement-breakpoint
ALTER TABLE coder_task_attempts DROP COLUMN developer_id;
--> statement-breakpoint
ALTER TABLE coder_runs DROP COLUMN authorized_commands;
--> statement-breakpoint
DROP TABLE router_coder_source_messages;
--> statement-breakpoint
DROP TABLE legacy_coder_run_ids;
