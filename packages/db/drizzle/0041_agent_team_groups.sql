ALTER TABLE `agent_teams` ADD `working_practice` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `agent_team_groups` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `team_id` text NOT NULL REFERENCES `agent_teams`(`id`) ON DELETE CASCADE,
  `title` text DEFAULT '' NOT NULL,
  `mode` text DEFAULT 'implement_and_validate' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_team_groups_workspace_updated_idx` ON `agent_team_groups` (`workspace_id`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `agent_team_repositories` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `team_id` text NOT NULL REFERENCES `agent_teams`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `directory` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_repositories_team_directory_idx` ON `agent_team_repositories` (`team_id`, `directory`);
--> statement-breakpoint
CREATE TABLE `agent_team_group_repositories` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `group_id` text NOT NULL REFERENCES `agent_team_groups`(`id`) ON DELETE CASCADE,
  `team_repository_id` text NOT NULL REFERENCES `agent_team_repositories`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `directory` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_group_repositories_group_directory_idx` ON `agent_team_group_repositories` (`group_id`, `directory`);
--> statement-breakpoint
CREATE INDEX `agent_team_group_repositories_group_idx` ON `agent_team_group_repositories` (`group_id`);
--> statement-breakpoint
CREATE TABLE `agent_team_group_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `group_id` text NOT NULL REFERENCES `agent_team_groups`(`id`) ON DELETE CASCADE,
  `sequence` integer NOT NULL,
  `sender` text NOT NULL,
  `sender_role` text,
  `recipient_role` text,
  `kind` text DEFAULT 'text' NOT NULL,
  `body` text NOT NULL,
  `run_id` text REFERENCES `agent_team_runs`(`id`) ON DELETE SET NULL,
  `task_attempt_id` text REFERENCES `agent_team_task_attempts`(`id`) ON DELETE SET NULL,
  `repository_ids` text DEFAULT '[]' NOT NULL,
  `file_references` text DEFAULT '[]' NOT NULL,
  `submission_id` text,
  `delivery_status` text DEFAULT 'delivered' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_group_messages_group_sequence_idx` ON `agent_team_group_messages` (`group_id`, `sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_group_messages_group_submission_idx` ON `agent_team_group_messages` (`group_id`, `submission_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_team_group_messages_task_attempt_idx` ON `agent_team_group_messages` (`task_attempt_id`);
--> statement-breakpoint
CREATE INDEX `agent_team_group_messages_run_idx` ON `agent_team_group_messages` (`run_id`);
--> statement-breakpoint
CREATE TABLE `agent_team_group_events` (
  `group_id` text NOT NULL REFERENCES `agent_team_groups`(`id`) ON DELETE CASCADE,
  `sequence` integer NOT NULL,
  `type` text NOT NULL,
  `payload` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY (`group_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `agent_team_memories` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `team_id` text NOT NULL REFERENCES `agent_teams`(`id`) ON DELETE CASCADE,
  `repository_id` text REFERENCES `agent_team_repositories`(`id`) ON DELETE CASCADE,
  `role` text,
  `content` text NOT NULL,
  `source_message_id` text REFERENCES `agent_team_group_messages`(`id`) ON DELETE SET NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_team_memories_scope_idx` ON `agent_team_memories` (`team_id`, `repository_id`, `role`, `updated_at`);
--> statement-breakpoint
ALTER TABLE `agent_team_runs` ADD `group_id` text REFERENCES `agent_team_groups`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `agent_team_runs` ADD `group_message_id` text REFERENCES `agent_team_group_messages`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `agent_team_runs` ADD `target_role` text;
--> statement-breakpoint
ALTER TABLE `agent_team_runs` ADD `repository_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_team_runs` ADD `group_context` text;
