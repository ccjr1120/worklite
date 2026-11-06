CREATE TABLE `agent_file_catalog_migrations` (
  `workspace_id` text PRIMARY KEY NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `root` text NOT NULL,
  `migrated_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
