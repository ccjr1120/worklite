-- Runs captured by pre-Router orchestration versions remain readable as records,
-- but their execution graph and recovery behavior are no longer supported.
INSERT INTO coder_run_events (run_id, sequence, type, payload, created_at)
SELECT
  r.id,
  COALESCE(MAX(e.sequence), 0) + 1,
  'run.status',
  json_object('status', 'failed', 'reason', 'This Run uses a retired orchestration version. Start a new Router Run.'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM coder_runs r
JOIN coder_versions v ON v.id = r.coder_version_id
LEFT JOIN coder_run_events e ON e.run_id = r.id
WHERE COALESCE(json_extract(v.snapshot, '$.orchestrationVersion'), 1) < 12
  AND r.status IN ('queued', 'running', 'waiting_for_input', 'paused')
GROUP BY r.id;
--> statement-breakpoint
UPDATE coder_task_attempts
SET status = 'failed',
    active = 0,
    error = 'This Run uses a retired orchestration version. Start a new Router Run.',
    finished_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE run_id IN (
  SELECT r.id
  FROM coder_runs r
  JOIN coder_versions v ON v.id = r.coder_version_id
  WHERE COALESCE(json_extract(v.snapshot, '$.orchestrationVersion'), 1) < 12
    AND r.status IN ('queued', 'running', 'waiting_for_input', 'paused')
)
  AND active = 1;
--> statement-breakpoint
UPDATE coder_pending_inputs
SET status = 'cancelled',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE run_id IN (
  SELECT r.id
  FROM coder_runs r
  JOIN coder_versions v ON v.id = r.coder_version_id
  WHERE COALESCE(json_extract(v.snapshot, '$.orchestrationVersion'), 1) < 12
    AND r.status IN ('queued', 'running', 'waiting_for_input', 'paused')
)
  AND status = 'pending';
--> statement-breakpoint
UPDATE coder_runs
SET status = 'failed',
    desired_control_state = 'none',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    finished_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id IN (
  SELECT r.id
  FROM coder_runs r
  JOIN coder_versions v ON v.id = r.coder_version_id
  WHERE COALESCE(json_extract(v.snapshot, '$.orchestrationVersion'), 1) < 12
    AND r.status IN ('queued', 'running', 'waiting_for_input', 'paused')
);
