CREATE TABLE `workspace_credentials` (
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `credential_key` text NOT NULL,
  `encrypted_value` text NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY(`workspace_id`, `credential_key`)
);
