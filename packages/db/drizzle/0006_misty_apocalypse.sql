ALTER TABLE `model_providers` ADD `protocol` text DEFAULT 'openai/chat' NOT NULL;--> statement-breakpoint
UPDATE `model_providers` SET `protocol` = CASE `kind` WHEN 'deepseek' THEN 'deepseek/chat' ELSE 'openai/chat' END;--> statement-breakpoint
UPDATE `model_providers` SET `base_url` = 'https://api.deepseek.com/v1' WHERE `kind` = 'deepseek' AND `base_url` IS NULL;--> statement-breakpoint
ALTER TABLE `model_providers` DROP COLUMN `kind`;--> statement-breakpoint
ALTER TABLE `model_providers` DROP COLUMN `organization`;--> statement-breakpoint
ALTER TABLE `model_providers` DROP COLUMN `project`;
