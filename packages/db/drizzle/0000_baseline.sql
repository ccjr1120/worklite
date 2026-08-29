CREATE TABLE IF NOT EXISTS `agent_execution_events` (
	`execution_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`execution_id`, `sequence`),
	FOREIGN KEY (`execution_id`) REFERENCES `agent_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`phase` text DEFAULT 'model' NOT NULL,
	`error_code` text,
	`model_messages` text DEFAULT '[]' NOT NULL,
	`display_messages` text DEFAULT '[]' NOT NULL,
	`plan` text DEFAULT '[]' NOT NULL,
	`pending_question` text,
	`context_dropped` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_mcp_servers` (
	`agent_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `mcp_server_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_skills` (
	`agent_id` text NOT NULL,
	`skill_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `skill_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_sub_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`title` text NOT NULL,
	`unread` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `agent_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_sub_sessions_execution_id_unique` ON `agent_sub_sessions` (`execution_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_sub_sessions_workspace_updated_idx` ON `agent_sub_sessions` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`working_directory` text NOT NULL,
	`skill_id` text,
	`skill_name` text,
	`script_path` text,
	`mcp_server_id` text,
	`mcp_tool_name` text,
	`arguments` text DEFAULT '[]' NOT NULL,
	`input` text,
	`package_files` text DEFAULT '[]' NOT NULL,
	`command_execution_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`result` text,
	`exit_code` integer,
	`result_appended` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`execution_id`) REFERENCES `agent_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_execution_id`) REFERENCES `command_executions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`responsibility` text NOT NULL,
	`system_prompt` text NOT NULL,
	`provider_id` text,
	`model` text NOT NULL,
	`skill_ids` text DEFAULT '[]' NOT NULL,
	`mcp_server_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_versions_agent_id_version_unique` ON `agent_versions` (`agent_id`,`version`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`name` text NOT NULL,
	`responsibility` text NOT NULL,
	`model` text NOT NULL,
	`provider_id` text,
	`system_prompt` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text,
	`run_id` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` text DEFAULT '0 B' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`object_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`resource` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `command_execution_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `command_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `command_execution_events_command_sequence_idx` ON `command_execution_events` (`command_id`,`sequence`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `command_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`pid` integer,
	`exit_code` integer,
	`signal` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`endpoint` text DEFAULT '' NOT NULL,
	`connection` text DEFAULT 'unconfigured' NOT NULL,
	`transport` text DEFAULT 'Streamable HTTP' NOT NULL,
	`allowed_tools` integer DEFAULT 0 NOT NULL,
	`version` text DEFAULT 'v1' NOT NULL,
	`auth_secret` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `model_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'openai-compatible' NOT NULL,
	`base_url` text,
	`organization` text,
	`project` text,
	`status` text DEFAULT 'unconfigured' NOT NULL,
	`masked_key` text DEFAULT '' NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`api_key` text,
	`headers` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `scheduled_agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`label` text NOT NULL,
	`prompt` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`next_run_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`active_execution_id` text,
	`last_run_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_status` text,
	`unread` integer DEFAULT false NOT NULL,
	`running` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scheduled_agent_tasks_workspace_next_run_idx` ON `scheduled_agent_tasks` (`workspace_id`,`next_run_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skill_files` (
	`skill_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`skill_id`, `path`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`version` text DEFAULT 'draft' NOT NULL,
	`validation` text DEFAULT 'pending' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`current_revision_id` text,
	`definition` text DEFAULT '{"schemaVersion":1,"input":{},"defaults":{"errorPolicy":"stop"},"nodes":[]}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workflow_drafts_workflow_id_unique` ON `workflow_drafts` (`workflow_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_edit_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`parent_revision_id` text,
	`source` text NOT NULL,
	`source_instruction` text,
	`operations` text DEFAULT '[]' NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `workflow_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_node_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`node_id` text NOT NULL,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`type_version` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`input` text,
	`output` text,
	`artifact_ids` text DEFAULT '[]' NOT NULL,
	`error` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_run_events` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`run_id`, `sequence`),
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_version_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`input` text NOT NULL,
	`result` text,
	`current_node_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`workflow_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`nodes` text DEFAULT '[]' NOT NULL,
	`definition` text,
	`source_revision_id` text,
	`published_at` integer,
	`published_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`appearance` text DEFAULT 'system' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspaces_slug_unique` ON `workspaces` (`slug`);
