ALTER TABLE `agent_team_memories` ADD `source_run_id` text;--> statement-breakpoint
ALTER TABLE `agent_team_memories` ADD `source_role` text;--> statement-breakpoint
ALTER TABLE `agent_team_memories` ADD `source_task_attempt_id` text;--> statement-breakpoint
ALTER TABLE `agent_team_memories` ADD `created_by` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_team_memories` ADD `upsert_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_memories_upsert_idx` ON `agent_team_memories` (`team_id`,`repository_id`,`upsert_key`);--> statement-breakpoint
CREATE INDEX `agent_team_memories_source_run_idx` ON `agent_team_memories` (`source_run_id`);
