CREATE TABLE `chat_attachments` (
 `id` text PRIMARY KEY NOT NULL,
 `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
 `file_name` text NOT NULL, `mime_type` text NOT NULL, `size` integer NOT NULL,
 `conversation_id` text, `project_task_id` text,
 `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL, `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_attachments_expires_idx` ON `chat_attachments` (`expires_at`);
