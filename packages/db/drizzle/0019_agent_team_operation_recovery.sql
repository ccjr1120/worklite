ALTER TABLE `agent_team_pending_inputs` ADD `kind` text DEFAULT 'question' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_team_pending_inputs` ADD `operation_key` text;
--> statement-breakpoint
ALTER TABLE `agent_team_operations` ADD `recovery_decision` text;
--> statement-breakpoint
ALTER TABLE `agent_team_operations` ADD `recovery_decided_at` integer;
