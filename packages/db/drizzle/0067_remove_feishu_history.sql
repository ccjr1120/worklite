-- Retire the Feishu channel and its historical transport data. Keep the tables so
-- historical schemas remain compatible with shared conversation readers.
DELETE FROM feishu_events;
--> statement-breakpoint
DELETE FROM feishu_deliveries;
--> statement-breakpoint
DELETE FROM feishu_registrations;
--> statement-breakpoint
DELETE FROM external_chats WHERE channel = 'feishu';
--> statement-breakpoint
UPDATE plugins SET feishu_app_id = '', feishu_app_secret = NULL,
  feishu_allowed_user_id = '', feishu_enabled = 0,
  feishu_status = 'disconnected', feishu_last_error = NULL
WHERE id = 'feishu-bot';
