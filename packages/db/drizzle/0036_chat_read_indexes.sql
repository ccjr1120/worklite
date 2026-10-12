CREATE INDEX `agent_tool_calls_execution_idx` ON `agent_tool_calls` (`execution_id`);
--> statement-breakpoint
CREATE INDEX `chat_submissions_execution_idx` ON `chat_submissions` (`execution_id`);
--> statement-breakpoint
CREATE INDEX `agent_executions_workspace_agent_updated_idx` ON `agent_executions` (`workspace_id`, `agent_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `feishu_events_chat_idx` ON `feishu_events` (`chat_id`);
