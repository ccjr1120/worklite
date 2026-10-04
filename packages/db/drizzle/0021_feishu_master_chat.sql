DROP TABLE `plugin_wechat_conversations`;
--> statement-breakpoint
ALTER TABLE `plugins` DROP COLUMN `wechat_base_url`;
--> statement-breakpoint
ALTER TABLE `plugins` DROP COLUMN `wechat_token`;
--> statement-breakpoint
ALTER TABLE `plugins` DROP COLUMN `wechat_bot_id`;
--> statement-breakpoint
ALTER TABLE `plugins` DROP COLUMN `wechat_status`;
--> statement-breakpoint
ALTER TABLE `plugins` DROP COLUMN `wechat_qr_code`;
--> statement-breakpoint
ALTER TABLE `plugins` DROP COLUMN `wechat_qr_key`;
--> statement-breakpoint
ALTER TABLE `plugins` DROP COLUMN `wechat_cursor`;
--> statement-breakpoint
ALTER TABLE `plugins` DROP COLUMN `wechat_last_error`;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `feishu_app_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `feishu_app_secret` text;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `feishu_allowed_user_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `feishu_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `feishu_status` text DEFAULT 'disconnected' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `feishu_last_error` text;
--> statement-breakpoint
CREATE TABLE `feishu_chats` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL,
  `execution_id` text,
  `target` text DEFAULT '{"kind":"conversation"}' NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_submissions` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `chat_id` text REFERENCES `feishu_chats`(`id`) ON DELETE CASCADE,
  `execution_id` text,
  `message` text NOT NULL,
  `target` text NOT NULL,
  `reference` text,
  `output_message_id` text,
  `rendered_card` text,
  `delivery_fingerprint` text,
  `settled` integer DEFAULT 0 NOT NULL,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feishu_events` (
  `id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL REFERENCES `feishu_chats`(`id`) ON DELETE CASCADE,
  `payload` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feishu_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL REFERENCES `feishu_chats`(`id`) ON DELETE CASCADE,
  `message_id` text
);
