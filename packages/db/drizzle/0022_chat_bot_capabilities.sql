CREATE TABLE `chat_bot_configurations` (
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `revision` integer NOT NULL,
  `extension_prompt` text NOT NULL DEFAULT '',
  `provider_id` text,
  `model` text NOT NULL,
  `skill_ids` text NOT NULL,
  `mcp_server_ids` text NOT NULL,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (`workspace_id`, `revision`)
);
--> statement-breakpoint
ALTER TABLE `agent_executions` ADD `capability_snapshot` text;
