-- Router assignments and returned role results are distinct events. Keep
-- direct handoffs from pre-Router transcripts as historical evidence.
UPDATE coder_group_messages
SET kind = CASE
  WHEN sender_role = 'router' AND recipient_role IS NOT NULL THEN 'assignment'
  WHEN recipient_role = 'router' THEN 'result'
  ELSE kind
END
WHERE kind = 'handoff'
  AND run_id IN (
    SELECT r.id
    FROM coder_runs r
    JOIN coder_versions v ON v.id = r.coder_version_id
    WHERE json_extract(v.snapshot, '$.orchestrationVersion') = 12
  )
  AND (sender_role = 'router' OR recipient_role = 'router');
