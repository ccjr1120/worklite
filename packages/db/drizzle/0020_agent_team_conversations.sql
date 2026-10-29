ALTER TABLE `agent_team_documents` ADD `delivery_status` text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_team_documents` ADD `delivery_error` text;
--> statement-breakpoint
CREATE TABLE `agent_team_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`executor_category_id` text NOT NULL,
	`latest_project_directory` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`executor_category_id`) REFERENCES `agent_teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_conversations_workspace_id_executor_category_id_unique` ON `agent_team_conversations` (`workspace_id`,`executor_category_id`);
--> statement-breakpoint
CREATE TABLE `agent_team_intakes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`goal` text,
	`project_directory` text,
	`mode` text,
	`unresolved_field` text,
	`status` text DEFAULT 'collecting' NOT NULL,
	`run_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_team_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_team_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_intakes_conversation_id_submission_id_unique` ON `agent_team_intakes` (`conversation_id`,`submission_id`);
--> statement-breakpoint
CREATE INDEX `agent_team_intakes_conversation_status_idx` ON `agent_team_intakes` (`conversation_id`,`status`);
--> statement-breakpoint
CREATE TABLE `agent_team_conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`intake_id` text,
	`run_id` text,
	`speaker` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`deduplication_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_team_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`intake_id`) REFERENCES `agent_team_intakes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `agent_team_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `agent_team_conversation_messages_conversation_id_sequence_unique` UNIQUE(`conversation_id`,`sequence`),
	CONSTRAINT `agent_team_conversation_messages_conversation_id_deduplication_key_unique` UNIQUE(`conversation_id`,`deduplication_key`)
);
--> statement-breakpoint
CREATE INDEX `agent_team_conversation_messages_run_idx` ON `agent_team_conversation_messages` (`run_id`);
--> statement-breakpoint
CREATE TABLE `agent_team_conversation_events` (
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_team_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `agent_team_conversation_events_conversation_id_sequence_pk` PRIMARY KEY (`conversation_id`,`sequence`)
);
