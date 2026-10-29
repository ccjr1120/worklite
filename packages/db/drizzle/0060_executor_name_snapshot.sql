-- Executor names become editable: uniqueness is case-insensitive and ignores soft-deleted executors.
DROP INDEX IF EXISTS `agent_teams_workspace_id_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `executor_categories_workspace_active_name_unique` ON `executor_categories` (`workspace_id`, lower(`name`)) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
-- Freeze the executor name of every historical Run version by value, so a later rename only affects new Runs.
UPDATE `executor_category_versions` SET `snapshot` = json_set(`snapshot`, '$.executorName', (SELECT `name` FROM `executor_categories` WHERE `executor_categories`.`id` = `executor_category_versions`.`executor_category_id`)) WHERE json_extract(`snapshot`, '$.executorName') IS NULL;
