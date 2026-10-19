ALTER TABLE `chat_memories` ADD `category` text DEFAULT 'other' NOT NULL;
--> statement-breakpoint
-- Classify the operator's existing memories: standing rules stay always-injected, the project index becomes on-demand.
UPDATE `chat_memories` SET `category` = 'rule' WHERE `id` LIKE 'mem_90e07fe0%' OR `id` LIKE 'mem_1f9756c6%' OR `id` LIKE 'mem_00fe67ea%' OR `id` LIKE 'mem_c83a161c%';
--> statement-breakpoint
UPDATE `chat_memories` SET `category` = 'project' WHERE `id` LIKE 'mem_2f119b66%';
