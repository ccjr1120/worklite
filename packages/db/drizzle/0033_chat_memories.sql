CREATE TABLE `chat_memories` (
 `id` text PRIMARY KEY NOT NULL,
 `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
 `content` text NOT NULL,
 `source_conversation_id` text,
 `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL, `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_memories_workspace_updated_idx` ON `chat_memories` (`workspace_id`, `updated_at`);
