-- Preserve channel credentials, connection state and registration receipts before retiring plugins.
CREATE TABLE chat_channels (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  feishu_app_id TEXT NOT NULL DEFAULT '', feishu_app_secret TEXT,
  feishu_allowed_user_id TEXT NOT NULL DEFAULT '', feishu_enabled INTEGER NOT NULL DEFAULT 0,
  feishu_status TEXT NOT NULL DEFAULT 'disconnected', feishu_last_error TEXT,
  wechat_bot_id TEXT NOT NULL DEFAULT '', wechat_bot_token TEXT,
  wechat_base_url TEXT NOT NULL DEFAULT '', wechat_allowed_user_id TEXT NOT NULL DEFAULT '',
  wechat_enabled INTEGER NOT NULL DEFAULT 0, wechat_status TEXT NOT NULL DEFAULT 'disconnected',
  wechat_last_error TEXT, wechat_sync_buf TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
INSERT INTO chat_channels
SELECT CASE id WHEN 'feishu-bot' THEN 'feishu' ELSE 'wechat' END, workspace_id,
  feishu_app_id, feishu_app_secret, feishu_allowed_user_id, feishu_enabled, feishu_status, feishu_last_error,
  wechat_bot_id, wechat_bot_token, wechat_base_url, wechat_allowed_user_id,
  wechat_enabled, wechat_status, wechat_last_error, wechat_sync_buf, updated_at
FROM plugins WHERE id IN ('feishu-bot', 'wechat-bot');
--> statement-breakpoint
CREATE TABLE feishu_registrations_channels (
  channel_id TEXT PRIMARY KEY NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, device_code TEXT, verification_url TEXT, expires_at INTEGER,
  interval_seconds INTEGER NOT NULL DEFAULT 5, next_poll_at INTEGER, error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
INSERT INTO feishu_registrations_channels
SELECT 'feishu', id, status, device_code, verification_url, expires_at,
  interval_seconds, next_poll_at, error, created_at, updated_at
FROM feishu_registrations WHERE plugin_id = 'feishu-bot';
--> statement-breakpoint
DROP TABLE feishu_registrations;
--> statement-breakpoint
ALTER TABLE feishu_registrations_channels RENAME TO feishu_registrations;
--> statement-breakpoint
DROP TABLE plugins;
--> statement-breakpoint
-- Preserve the retired Agent's conversations as history; it is no longer executable or seeded.
UPDATE agent_executions
SET status = 'failed', pending_question = NULL,
  error = 'Codex CLI Chat has been removed. Start a new execution with a Codex Agent.',
  updated_at = unixepoch() * 1000
WHERE agent_id = 'agt_codex_cli_chat' AND status IN ('running', 'waiting_for_input');
