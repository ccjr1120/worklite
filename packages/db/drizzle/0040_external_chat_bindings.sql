CREATE TABLE `external_chats` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `channel` text NOT NULL,
  `external_id` text NOT NULL,
  `user_id` text NOT NULL,
  `execution_id` text,
  `context_token` text,
  `target` text DEFAULT '{"kind":"conversation"}' NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `external_chats` (`id`, `workspace_id`, `channel`, `external_id`, `user_id`, `execution_id`, `target`, `updated_at`)
SELECT `id`, `workspace_id`, 'feishu', `id`, `user_id`, `execution_id`, `target`, `updated_at` FROM `feishu_chats`;
--> statement-breakpoint
CREATE TABLE `chat_submissions_new` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `chat_id` text REFERENCES `external_chats`(`id`) ON DELETE CASCADE,
  `execution_id` text,
  `message` text NOT NULL,
  `target` text NOT NULL,
  `reference` text,
  `output_message_id` text,
  `rendered_card` text,
  `rendered_task_cards` text,
  `delivery_fingerprint` text,
  `settled` integer DEFAULT 0 NOT NULL,
  `reported_at` integer,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `chat_submissions_new` (`id`, `workspace_id`, `chat_id`, `execution_id`, `message`, `target`, `reference`, `output_message_id`, `rendered_card`, `rendered_task_cards`, `delivery_fingerprint`, `settled`, `reported_at`, `error`, `created_at`, `updated_at`)
SELECT `id`, `workspace_id`, `chat_id`, `execution_id`, `message`, `target`, `reference`, `output_message_id`, `rendered_card`, `rendered_task_cards`, `delivery_fingerprint`, `settled`, `reported_at`, `error`, `created_at`, `updated_at` FROM `chat_submissions`;
--> statement-breakpoint
DROP TABLE `chat_submissions`;
--> statement-breakpoint
ALTER TABLE `chat_submissions_new` RENAME TO `chat_submissions`;
--> statement-breakpoint
CREATE INDEX `chat_submissions_execution_idx` ON `chat_submissions` (`execution_id`);
--> statement-breakpoint
CREATE TABLE `feishu_events_new` (
  `id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL REFERENCES `external_chats`(`id`) ON DELETE CASCADE,
  `payload` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `feishu_events_new` (`id`, `chat_id`, `payload`, `status`, `error`, `created_at`)
SELECT `id`, `chat_id`, `payload`, `status`, `error`, `created_at` FROM `feishu_events`;
--> statement-breakpoint
DROP TABLE `feishu_events`;
--> statement-breakpoint
ALTER TABLE `feishu_events_new` RENAME TO `feishu_events`;
--> statement-breakpoint
CREATE INDEX `feishu_events_chat_idx` ON `feishu_events` (`chat_id`);
--> statement-breakpoint
CREATE TABLE `feishu_deliveries_new` (
  `id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL REFERENCES `external_chats`(`id`) ON DELETE CASCADE,
  `message_id` text
);
--> statement-breakpoint
INSERT INTO `feishu_deliveries_new` (`id`, `chat_id`, `message_id`)
SELECT `id`, `chat_id`, `message_id` FROM `feishu_deliveries`;
--> statement-breakpoint
DROP TABLE `feishu_deliveries`;
--> statement-breakpoint
ALTER TABLE `feishu_deliveries_new` RENAME TO `feishu_deliveries`;
--> statement-breakpoint
DROP TABLE `feishu_chats`;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_bot_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_bot_token` text;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_base_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_allowed_user_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_status` text DEFAULT 'disconnected' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_last_error` text;
--> statement-breakpoint
ALTER TABLE `plugins` ADD `wechat_sync_buf` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `wechat_events` (
  `id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL REFERENCES `external_chats`(`id`) ON DELETE CASCADE,
  `payload` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wechat_events_chat_idx` ON `wechat_events` (`chat_id`);
