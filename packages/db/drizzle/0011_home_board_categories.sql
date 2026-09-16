CREATE TABLE `home_board_categories` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE cascade,
  `name` text NOT NULL,
  `position` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `home_board_categories_workspace_name_unique` ON `home_board_categories` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE INDEX `home_board_categories_workspace_position_idx` ON `home_board_categories` (`workspace_id`,`position`);
--> statement-breakpoint
CREATE TABLE `home_board_assignments` (
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE cascade,
  `workflow_id` text NOT NULL REFERENCES `workflows`(`id`) ON DELETE cascade,
  `category_id` text NOT NULL REFERENCES `home_board_categories`(`id`) ON DELETE cascade,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY(`workspace_id`, `workflow_id`)
);
--> statement-breakpoint
CREATE INDEX `home_board_assignments_category_idx` ON `home_board_assignments` (`category_id`);
