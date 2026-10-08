CREATE TABLE `chat_codex_tasks` (
 `id` text PRIMARY KEY NOT NULL REFERENCES `agent_tool_calls`(`id`) ON DELETE CASCADE,
 `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
 `execution_id` text NOT NULL REFERENCES `agent_executions`(`id`) ON DELETE CASCADE,
 `goal` text NOT NULL, `project_directory` text NOT NULL, `model` text NOT NULL, `snapshot` text NOT NULL,
 `status` text NOT NULL, `authorized_commands` text DEFAULT '[]' NOT NULL, `answers` text DEFAULT '[]' NOT NULL,
 `pending_question` text, `activities` text DEFAULT '[]' NOT NULL, `result` text DEFAULT '' NOT NULL, `error` text,
 `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL, `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_codex_tasks_execution_idx` ON `chat_codex_tasks` (`execution_id`);
--> statement-breakpoint
CREATE TABLE `chat_codex_operations` (
 `key` text PRIMARY KEY NOT NULL, `task_id` text NOT NULL REFERENCES `chat_codex_tasks`(`id`) ON DELETE CASCADE,
 `task_key` text NOT NULL, `operation_key` text NOT NULL, `tool_name` text NOT NULL, `input_fingerprint` text NOT NULL,
 `status` text NOT NULL, `command_id` text REFERENCES `command_executions`(`id`) ON DELETE SET NULL,
 `result` text, `failure_reason` text,
 `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL, `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_codex_operations_task_idx` ON `chat_codex_operations` (`task_id`);
