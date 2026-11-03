-- Coder Runs no longer support Run-level pause or resume. Retire any stranded
-- paused Run and settle its active task evidence before removing the API path.
INSERT INTO coder_run_events (run_id, sequence, type, payload, created_at)
SELECT
  r.id,
  COALESCE(MAX(e.sequence), 0) + 1,
  'run.status',
  json_object('status', 'failed', 'reason', 'Run-level pause is no longer supported. Continue a role task from Chat or start a new Router Run.'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM coder_runs r
LEFT JOIN coder_run_events e ON e.run_id = r.id
WHERE r.status IN ('queued', 'running', 'waiting_for_input', 'paused')
  AND (r.status = 'paused' OR r.desired_control_state = 'pause_requested')
GROUP BY r.id;
--> statement-breakpoint
UPDATE coder_task_attempts
SET status = 'failed',
    active = 0,
    error = 'Run-level pause is no longer supported. Continue this role task from Chat or start a new Router Run.',
    finished_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE active = 1
  AND run_id IN (
    SELECT id FROM coder_runs
    WHERE status IN ('queued', 'running', 'waiting_for_input', 'paused')
      AND (status = 'paused' OR desired_control_state = 'pause_requested')
  );
--> statement-breakpoint
UPDATE coder_pending_inputs
SET status = 'cancelled',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status = 'pending'
  AND run_id IN (
    SELECT id FROM coder_runs
    WHERE status IN ('queued', 'running', 'waiting_for_input', 'paused')
      AND (status = 'paused' OR desired_control_state = 'pause_requested')
  );
--> statement-breakpoint
UPDATE coder_runs
SET status = 'failed',
    desired_control_state = 'none',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    finished_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status IN ('queued', 'running', 'waiting_for_input', 'paused')
  AND (status = 'paused' OR desired_control_state = 'pause_requested');
