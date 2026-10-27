ALTER TABLE `artifacts` RENAME COLUMN `type` TO `format`;
--> statement-breakpoint
ALTER TABLE `artifacts` RENAME COLUMN `image_role` TO `placement`;
--> statement-breakpoint
UPDATE `artifacts` SET `placement` = 'inline' WHERE `format` = 'image' AND `placement` IS NULL;
