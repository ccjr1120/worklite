ALTER TABLE `chat_codex_tasks` ADD `reported_at` integer;
--> statement-breakpoint
UPDATE `chat_codex_tasks` SET `reported_at` = `updated_at`;
