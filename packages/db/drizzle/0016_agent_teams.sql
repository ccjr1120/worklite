CREATE TABLE `agent_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`process_id` text NOT NULL,
	`process_version` text NOT NULL,
	`roles` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_teams_workspace_id_name_unique` ON `agent_teams` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE `agent_team_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`executor_category_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`executor_category_id`) REFERENCES `agent_teams`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_versions_executor_category_id_version_unique` ON `agent_team_versions` (`executor_category_id`,`version`);
--> statement-breakpoint
CREATE TABLE `agent_team_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`executor_category_id` text NOT NULL,
	`executor_category_version_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`intent` text NOT NULL,
	`project_directory` text NOT NULL,
	`mode` text NOT NULL,
	`scope_revision` integer DEFAULT 1 NOT NULL,
	`desired_control_state` text DEFAULT 'none' NOT NULL,
	`lang_graph_thread_id` text NOT NULL,
	`outcome` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`executor_category_id`) REFERENCES `agent_teams`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`executor_category_version_id`) REFERENCES `agent_team_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_runs_lang_graph_thread_id_unique` ON `agent_team_runs` (`lang_graph_thread_id`);
--> statement-breakpoint
CREATE INDEX `agent_team_runs_workspace_created_idx` ON `agent_team_runs` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_team_task_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`task_key` text NOT NULL,
	`attempt_index` integer NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`input_revision` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`result` text,
	`error` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_team_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_task_attempts_run_id_task_key_attempt_index_unique` ON `agent_team_task_attempts` (`run_id`,`task_key`,`attempt_index`);
--> statement-breakpoint
CREATE INDEX `agent_team_task_attempts_run_task_idx` ON `agent_team_task_attempts` (`run_id`,`task_key`);
--> statement-breakpoint
CREATE TABLE `agent_team_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`task_attempt_id` text NOT NULL,
	`key` text NOT NULL,
	`revision` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`upstream_document_keys` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_team_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_attempt_id`) REFERENCES `agent_team_task_attempts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_documents_run_id_key_revision_unique` ON `agent_team_documents` (`run_id`,`key`,`revision`);
--> statement-breakpoint
CREATE INDEX `agent_team_documents_run_idx` ON `agent_team_documents` (`run_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_team_run_events` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`run_id`, `sequence`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_team_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_team_pending_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`task_attempt_id` text NOT NULL,
	`question` text NOT NULL,
	`scope_revision` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`answered_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_team_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_attempt_id`) REFERENCES `agent_team_task_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_team_pending_inputs_run_status_idx` ON `agent_team_pending_inputs` (`run_id`,`status`);
--> statement-breakpoint
CREATE TABLE `agent_team_operations` (
	`key` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`task_attempt_id` text NOT NULL,
	`task_key` text NOT NULL,
	`operation_key` text NOT NULL,
	`tool_name` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`command_id` text,
	`result` text,
	`failure_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_team_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_attempt_id`) REFERENCES `agent_team_task_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `command_executions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_team_operations_run_idx` ON `agent_team_operations` (`run_id`,`task_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_operations_run_id_task_key_operation_key_unique` ON `agent_team_operations` (`run_id`,`task_key`,`operation_key`);
