ALTER TABLE `chat_codex_tasks` ADD `worktree_path` text;
--> statement-breakpoint
ALTER TABLE `chat_codex_tasks` ADD `worktree_branch` text;
--> statement-breakpoint
ALTER TABLE `chat_codex_tasks` ADD `base_branch` text;
--> statement-breakpoint
ALTER TABLE `chat_codex_tasks` ADD `base_commit` text;
--> statement-breakpoint
ALTER TABLE `chat_codex_tasks` ADD `merge_status` text DEFAULT 'not_attempted' NOT NULL;
--> statement-breakpoint
ALTER TABLE `chat_codex_tasks` ADD `merge_error` text;
--> statement-breakpoint
ALTER TABLE `chat_submissions` ADD `rendered_task_cards` text;
--> statement-breakpoint
CREATE TABLE `chat_project_task_subscriptions` (
 `id` text PRIMARY KEY NOT NULL,
 `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
 `task_id` text NOT NULL REFERENCES `chat_codex_tasks`(`id`) ON DELETE CASCADE,
 `subscriber_execution_id` text NOT NULL REFERENCES `agent_executions`(`id`) ON DELETE CASCADE,
 `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_project_task_subscriptions_unique` ON `chat_project_task_subscriptions` (`task_id`, `subscriber_execution_id`);
