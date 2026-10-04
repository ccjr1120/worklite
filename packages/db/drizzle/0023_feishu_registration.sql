CREATE TABLE `feishu_registrations` (
  `plugin_id` text PRIMARY KEY NOT NULL REFERENCES `plugins`(`id`) ON DELETE CASCADE,
  `id` text NOT NULL UNIQUE,
  `status` text NOT NULL,
  `device_code` text,
  `verification_url` text,
  `expires_at` integer,
  `interval_seconds` integer DEFAULT 5 NOT NULL,
  `next_poll_at` integer,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
