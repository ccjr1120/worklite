ALTER TABLE agent_executions ADD COLUMN queued_messages text NOT NULL DEFAULT '[]';
