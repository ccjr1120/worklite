ALTER TABLE `artifacts` ADD COLUMN `image_key` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD COLUMN `image_position` integer;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD COLUMN `image_role` text;
