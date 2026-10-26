ALTER TABLE `artifacts` ADD COLUMN `mime_type` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD COLUMN `width` integer;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD COLUMN `height` integer;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD COLUMN `size_bytes` integer;
