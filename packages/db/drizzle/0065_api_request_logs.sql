CREATE TABLE `api_request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`route` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`response_bytes` integer,
	`streaming` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_request_logs_created_idx` ON `api_request_logs` (`created_at`);
--> statement-breakpoint
CREATE INDEX `api_request_logs_route_created_idx` ON `api_request_logs` (`route`, `created_at`);
--> statement-breakpoint
CREATE INDEX `api_request_logs_duration_idx` ON `api_request_logs` (`duration_ms`);
--> statement-breakpoint
CREATE INDEX `feishu_events_chat_created_idx` ON `feishu_events` (`chat_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `feishu_events_chat_event_idx` ON `feishu_events` (`chat_id`, `id`);
--> statement-breakpoint
CREATE INDEX `wechat_events_chat_created_idx` ON `wechat_events` (`chat_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `wechat_events_chat_event_idx` ON `wechat_events` (`chat_id`, `id`);
