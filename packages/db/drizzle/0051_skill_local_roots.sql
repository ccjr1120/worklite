ALTER TABLE `skills` ADD COLUMN `root` text DEFAULT 'agents' NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD COLUMN `directory` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD COLUMN `validation_reason` text;
--> statement-breakpoint
CREATE TABLE `skill_id_aliases` (
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	`old_skill_id` text NOT NULL,
	`current_skill_id` text NOT NULL,
	`skill_name` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `old_skill_id`)
);
