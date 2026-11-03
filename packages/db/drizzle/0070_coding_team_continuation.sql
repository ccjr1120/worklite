ALTER TABLE coder_task_attempts
  ADD COLUMN continued_from_attempt_id TEXT
    REFERENCES coder_task_attempts(id) ON DELETE SET NULL;
