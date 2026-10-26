ALTER TABLE `chat_bot_configurations` ADD COLUMN `executor_context` text DEFAULT '' NOT NULL;
UPDATE `chat_bot_configurations` SET `executor_context` = `extension_prompt`;
