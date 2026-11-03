ALTER TABLE `workflow_node_runs` ADD COLUMN `rerun_evidence` text;
--> statement-breakpoint
ALTER TABLE `workflow_node_runs` ADD COLUMN `superseded_by_node_run_id` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD COLUMN `superseded_by_node_run_id` text;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD COLUMN `superseded_at` integer;
