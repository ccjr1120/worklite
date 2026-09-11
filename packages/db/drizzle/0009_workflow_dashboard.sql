CREATE TABLE `workflow_schedules` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE cascade,
  `workflow_id` text NOT NULL REFERENCES `workflows`(`id`) ON DELETE cascade,
  `workflow_version_id` text NOT NULL REFERENCES `workflow_versions`(`id`) ON DELETE restrict,
  `interval_seconds` integer NOT NULL,
  `enabled` integer DEFAULT true NOT NULL,
  `running` integer DEFAULT false NOT NULL,
  `next_run_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `last_run_at` integer,
  `last_run_id` text,
  `last_status` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_schedules_workflow_id_unique` ON `workflow_schedules` (`workflow_id`);
--> statement-breakpoint
CREATE INDEX `workflow_schedules_due_idx` ON `workflow_schedules` (`workspace_id`,`enabled`,`next_run_at`);
--> statement-breakpoint
CREATE TABLE `dashboard_datasets` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE cascade,
  `workflow_id` text NOT NULL REFERENCES `workflows`(`id`) ON DELETE cascade,
  `presentation` text DEFAULT 'kanban' NOT NULL,
  `payload` text,
  `last_run_id` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_datasets_workspace_id_unique` ON `dashboard_datasets` (`workspace_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_datasets_workflow_id_unique` ON `dashboard_datasets` (`workflow_id`);
