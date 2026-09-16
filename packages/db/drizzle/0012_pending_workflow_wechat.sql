CREATE TABLE `wechat_official_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`encrypted_storage_state` text,
	`qr_code` text,
	`qr_expires_at` integer,
	`last_verified_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wechat_official_accounts_workspace_id_display_name_unique` ON `wechat_official_accounts` (`workspace_id`,`display_name`);
--> statement-breakpoint
CREATE TABLE `workflow_pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`qr_code` text,
	`external_operation_id` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_run_id`) REFERENCES `workflow_node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_pending_actions_run_status_idx` ON `workflow_pending_actions` (`run_id`,`status`);
--> statement-breakpoint
CREATE TABLE `wechat_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`run_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'preparing' NOT NULL,
	`title` text NOT NULL,
	`article` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`draft_id` text,
	`published_url` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `wechat_official_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_run_id`) REFERENCES `workflow_node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wechat_publications_idempotency_key_unique` ON `wechat_publications` (`idempotency_key`);
