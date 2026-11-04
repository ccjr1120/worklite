ALTER TABLE agents ADD COLUMN runtime TEXT NOT NULL DEFAULT '{"kind":"native"}';
--> statement-breakpoint
ALTER TABLE agent_versions ADD COLUMN runtime TEXT NOT NULL DEFAULT '{"kind":"native"}';
--> statement-breakpoint
CREATE TABLE agent_runtime_sessions (
  id TEXT PRIMARY KEY NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runtime TEXT NOT NULL, external_session_id TEXT, launch TEXT NOT NULL,
  resource_directory TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE TABLE agent_runtime_runs (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES agent_runtime_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL, error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX agent_runtime_runs_session_idx ON agent_runtime_runs(session_id);
--> statement-breakpoint
CREATE TABLE agent_runtime_interactions (
  id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES agent_runtime_runs(id) ON DELETE CASCADE,
  question TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'question', status TEXT NOT NULL, answer TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE TABLE agent_runtime_events (
  id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES agent_runtime_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL, data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), UNIQUE(run_id, sequence)
);
