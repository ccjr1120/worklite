CREATE TABLE `wechat_draft_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	`publication_id` text NOT NULL REFERENCES `wechat_publications`(`id`) ON UPDATE no action ON DELETE cascade,
	`run_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`request_key` text NOT NULL,
	`title` text,
	`previous_title` text NOT NULL,
	`image_replacements` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'applying' NOT NULL,
	`last_error` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wechat_draft_revisions_request_key_unique` ON `wechat_draft_revisions` (`request_key`);
--> statement-breakpoint
CREATE INDEX `wechat_draft_revisions_publication_status_idx` ON `wechat_draft_revisions` (`publication_id`, `status`);
