CREATE TABLE `workspace_settings_new` (
	`workspace_id` text PRIMARY KEY NOT NULL REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	`appearance` text DEFAULT 'system' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `workspace_settings_new` (`workspace_id`, `appearance`, `updated_at`) SELECT `workspace_id`, `appearance`, `updated_at` FROM `workspace_settings`;--> statement-breakpoint
DROP TABLE `workspace_settings`;--> statement-breakpoint
ALTER TABLE `workspace_settings_new` RENAME TO `workspace_settings`;
