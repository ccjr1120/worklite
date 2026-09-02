CREATE TABLE IF NOT EXISTS `diagnostic_logs` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `trace_id` text NOT NULL,
  `provider_id` text,
  `operation` text NOT NULL,
  `stage` text NOT NULL,
  `level` text NOT NULL,
  `status` text NOT NULL,
  `message` text NOT NULL,
  `duration_ms` integer,
  `metadata` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `diagnostic_logs_trace_id_idx` ON `diagnostic_logs` (`trace_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `diagnostic_logs_created_at_idx` ON `diagnostic_logs` (`created_at`);
