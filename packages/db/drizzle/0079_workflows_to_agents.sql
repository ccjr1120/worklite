ALTER TABLE agents ADD COLUMN collaboration TEXT;
--> statement-breakpoint
CREATE TABLE agent_pending_actions (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 execution_id TEXT NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE, tool_call_id TEXT NOT NULL,
 type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', title TEXT NOT NULL, description TEXT NOT NULL,
 qr_code TEXT, external_operation_id TEXT, expires_at INTEGER,
 created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX agent_pending_actions_execution_status_idx ON agent_pending_actions(execution_id, status);
--> statement-breakpoint
CREATE TABLE agent_publications (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL REFERENCES wechat_official_accounts(id) ON DELETE RESTRICT,
 execution_id TEXT NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE, tool_call_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'preparing',
 title TEXT NOT NULL, article TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', draft_id TEXT, published_url TEXT, last_error TEXT,
 created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
ALTER TABLE scheduled_agent_tasks ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE agent_capability_results (id TEXT PRIMARY KEY NOT NULL, execution_id TEXT NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE, value TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE retired_workflow_artifact_files (object_key TEXT PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TABLE agent_draft_revisions (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 publication_id TEXT NOT NULL REFERENCES agent_publications(id) ON DELETE CASCADE, run_id TEXT NOT NULL,
 draft_id TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, title TEXT, previous_title TEXT NOT NULL,
 image_replacements TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'applying', last_error TEXT,
 detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX agent_draft_revisions_publication_status_idx ON agent_draft_revisions(publication_id, status);
--> statement-breakpoint
ALTER TABLE agent_executions ADD COLUMN project_directory TEXT;
