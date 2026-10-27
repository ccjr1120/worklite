CREATE INDEX `workflow_runs_workspace_created_idx` ON `workflow_runs` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_created_idx` ON `workflow_runs` (`workflow_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `workflow_node_runs_run_position_idx` ON `workflow_node_runs` (`run_id`, `position`);
--> statement-breakpoint
CREATE INDEX `artifacts_run_created_idx` ON `artifacts` (`run_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `command_executions_status_created_idx` ON `command_executions` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `command_execution_events_type_created_idx` ON `command_execution_events` (`type`, `created_at`);
--> statement-breakpoint
CREATE INDEX `audit_logs_workspace_created_idx` ON `audit_logs` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `audit_logs_action_resource_idx` ON `audit_logs` (`action`, `resource`);
