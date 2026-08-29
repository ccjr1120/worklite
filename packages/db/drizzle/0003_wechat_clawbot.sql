ALTER TABLE `plugins` ADD `wechat_base_url` text DEFAULT 'https://ilinkai.weixin.qq.com' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_token` text;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_bot_id` text;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_status` text DEFAULT 'disconnected' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_qr_code` text;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_qr_key` text;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_cursor` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_last_error` text;
--> statement-breakpoint
CREATE TABLE `plugin_wechat_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`context_token` text,
	`execution_id` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_wechat_conversations_plugin_user_unique` ON `plugin_wechat_conversations` (`plugin_id`,`user_id`);
