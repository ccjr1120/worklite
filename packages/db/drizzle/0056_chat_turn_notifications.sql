ALTER TABLE `chat_bot_configurations` ADD COLUMN `turn_notifications_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_bot_configurations` ADD COLUMN `turn_notification_sound` text DEFAULT 'Glass' NOT NULL;
