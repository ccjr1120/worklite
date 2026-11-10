CREATE TABLE stored_json_items (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (owner_id, kind, position)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TRIGGER agent_messages_delete AFTER DELETE ON agent_executions BEGIN
  DELETE FROM stored_json_items WHERE owner_id = OLD.id AND kind IN ('model','display');
END;
--> statement-breakpoint
CREATE TRIGGER task_activities_delete AFTER DELETE ON chat_codex_tasks BEGIN
  DELETE FROM stored_json_items WHERE owner_id = OLD.id AND kind = 'activity';
END;
--> statement-breakpoint
ALTER TABLE agent_runtime_runs ADD COLUMN usage TEXT;
--> statement-breakpoint
UPDATE agent_runtime_runs SET usage = (SELECT json_extract(data, '$.usage') FROM agent_runtime_events WHERE run_id = agent_runtime_runs.id AND json_extract(data,'$.kind') = 'activity' AND json_extract(data,'$.usage') IS NOT NULL ORDER BY sequence DESC LIMIT 1);
--> statement-breakpoint
ALTER TABLE agent_execution_events ADD COLUMN kind TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE agent_execution_events SET kind = coalesce(json_extract(data,'$.kind'),'unknown');
--> statement-breakpoint
CREATE INDEX agent_events_kind_sequence_idx ON agent_execution_events(execution_id, kind, sequence);
--> statement-breakpoint
CREATE TRIGGER agent_event_kind AFTER INSERT ON agent_execution_events WHEN NEW.kind = '' BEGIN
  UPDATE agent_execution_events SET kind = coalesce(json_extract(NEW.data,'$.kind'),'unknown') WHERE execution_id=NEW.execution_id AND sequence=NEW.sequence;
END;
--> statement-breakpoint
CREATE INDEX agent_events_created_idx ON agent_execution_events(created_at);
--> statement-breakpoint
CREATE INDEX runtime_events_created_idx ON agent_runtime_events(created_at);
--> statement-breakpoint
CREATE INDEX agent_history_legacy_idx ON agent_tool_calls(workspace_id, json_extract(input,'$.agentId'), created_at DESC, id DESC) WHERE mcp_tool_name = 'run_agent' AND json_extract(input,'$.__backgroundExecutionId') IS NULL;
--> statement-breakpoint
CREATE INDEX agent_history_invocation_idx ON audit_logs(workspace_id, action, json_extract(metadata,'$.agentId'), created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX agent_history_owner_idx ON audit_logs(workspace_id, action, resource, json_extract(metadata,'$.agentId'));
--> statement-breakpoint
CREATE INDEX agent_history_direct_idx ON agent_executions(workspace_id, agent_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TRIGGER runtime_usage_materialize AFTER INSERT ON agent_runtime_events
WHEN json_extract(NEW.data,'$.kind') = 'activity' AND json_extract(NEW.data,'$.usage') IS NOT NULL
BEGIN
  UPDATE agent_runtime_runs SET usage = json_extract(NEW.data,'$.usage') WHERE id = NEW.run_id;
END;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_tool_calls_command_retention_idx ON agent_tool_calls(command_execution_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS coder_operations_command_retention_idx ON coder_operations(command_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_codex_operations_command_retention_idx ON chat_codex_operations(command_id);
