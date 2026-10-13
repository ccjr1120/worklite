ALTER TABLE `agent_teams` ADD `max_concurrent_runs` integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_team_runs` ADD `worktree_base_path` text;
--> statement-breakpoint
ALTER TABLE `agent_team_runs` ADD `run_branch` text;
