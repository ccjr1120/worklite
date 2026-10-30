-- Rename the executor (Executor Category) resource to Coder: tables, columns, indexes,
-- the two built-in ids and the persisted JSON that code reads back. Execution engine
-- fields (role `executor`: 'claude'/'codex', projectExecutorLaunches) and the role ids
-- `executor` and `executor-manager` keep their names. Logs and event history are untouched.

-- The migrator runs pending migrations in one transaction; deferring foreign keys lets the
-- built-in ids change on parent and child rows before the check at commit.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint

ALTER TABLE executor_categories RENAME TO coders;
--> statement-breakpoint
ALTER TABLE executor_category_repositories RENAME TO coder_repositories;
--> statement-breakpoint
ALTER TABLE executor_groups RENAME TO coder_groups;
--> statement-breakpoint
ALTER TABLE executor_group_repositories RENAME TO coder_group_repositories;
--> statement-breakpoint
ALTER TABLE executor_group_messages RENAME TO coder_group_messages;
--> statement-breakpoint
ALTER TABLE executor_group_events RENAME TO coder_group_events;
--> statement-breakpoint
ALTER TABLE executor_category_memories RENAME TO coder_memories;
--> statement-breakpoint
ALTER TABLE executor_conversations RENAME TO coder_conversations;
--> statement-breakpoint
ALTER TABLE executor_intakes RENAME TO coder_intakes;
--> statement-breakpoint
ALTER TABLE executor_conversation_messages RENAME TO coder_conversation_messages;
--> statement-breakpoint
ALTER TABLE executor_conversation_events RENAME TO coder_conversation_events;
--> statement-breakpoint
ALTER TABLE executor_category_versions RENAME TO coder_versions;
--> statement-breakpoint
ALTER TABLE executor_runs RENAME TO coder_runs;
--> statement-breakpoint
ALTER TABLE executor_task_attempts RENAME TO coder_task_attempts;
--> statement-breakpoint
ALTER TABLE executor_documents RENAME TO coder_documents;
--> statement-breakpoint
ALTER TABLE executor_run_events RENAME TO coder_run_events;
--> statement-breakpoint
ALTER TABLE executor_pending_inputs RENAME TO coder_pending_inputs;
--> statement-breakpoint
ALTER TABLE executor_operations RENAME TO coder_operations;
--> statement-breakpoint

ALTER TABLE coder_repositories RENAME COLUMN executor_category_id TO coder_id;
--> statement-breakpoint
ALTER TABLE coder_groups RENAME COLUMN executor_category_id TO coder_id;
--> statement-breakpoint
ALTER TABLE coder_group_repositories RENAME COLUMN executor_category_repository_id TO coder_repository_id;
--> statement-breakpoint
ALTER TABLE coder_memories RENAME COLUMN executor_category_id TO coder_id;
--> statement-breakpoint
ALTER TABLE coder_memories RENAME COLUMN executor_category_repository_id TO coder_repository_id;
--> statement-breakpoint
ALTER TABLE coder_conversations RENAME COLUMN executor_category_id TO coder_id;
--> statement-breakpoint
ALTER TABLE coder_versions RENAME COLUMN executor_category_id TO coder_id;
--> statement-breakpoint
ALTER TABLE coder_runs RENAME COLUMN executor_category_id TO coder_id;
--> statement-breakpoint
ALTER TABLE coder_runs RENAME COLUMN executor_category_version_id TO coder_version_id;
--> statement-breakpoint

-- Indexes: drop old names (including ones inherited from agent_team_*) and recreate them
-- with the definitions the schema declares.
DROP INDEX IF EXISTS executor_categories_workspace_active_name_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX coders_workspace_active_name_unique ON coders (workspace_id, lower(name)) WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_repositories_team_directory_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_repositories_coder_id_directory_unique ON coder_repositories (coder_id, directory);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_groups_workspace_updated_idx;
--> statement-breakpoint
CREATE INDEX coder_groups_workspace_updated_idx ON coder_groups (workspace_id, updated_at);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_group_repositories_group_directory_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_group_repositories_group_directory_idx ON coder_group_repositories (group_id, directory);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_group_repositories_group_idx;
--> statement-breakpoint
CREATE INDEX coder_group_repositories_group_idx ON coder_group_repositories (group_id);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_group_messages_group_sequence_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_group_messages_group_sequence_idx ON coder_group_messages (group_id, sequence);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_group_messages_group_submission_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_group_messages_group_submission_idx ON coder_group_messages (group_id, submission_id);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_group_messages_run_idx;
--> statement-breakpoint
CREATE INDEX coder_group_messages_run_idx ON coder_group_messages (run_id);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_group_messages_attempt_completion_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_group_messages_attempt_completion_idx ON coder_group_messages (task_attempt_id) WHERE kind IN ('text', 'handoff');
--> statement-breakpoint
DROP INDEX IF EXISTS executor_category_memories_scope_idx;
--> statement-breakpoint
CREATE INDEX coder_memories_scope_idx ON coder_memories (coder_id, coder_repository_id, role, updated_at);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_category_memories_upsert_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_memories_upsert_idx ON coder_memories (coder_id, coder_repository_id, upsert_key);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_category_memories_source_run_idx;
--> statement-breakpoint
CREATE INDEX coder_memories_source_run_idx ON coder_memories (source_run_id);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_conversations_workspace_id_team_id_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_conversations_workspace_id_coder_id_unique ON coder_conversations (workspace_id, coder_id);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_intakes_conversation_id_submission_id_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_intakes_conversation_id_submission_id_unique ON coder_intakes (conversation_id, submission_id);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_intakes_conversation_status_idx;
--> statement-breakpoint
CREATE INDEX coder_intakes_conversation_status_idx ON coder_intakes (conversation_id, status);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_conversation_messages_run_idx;
--> statement-breakpoint
CREATE INDEX coder_conversation_messages_run_idx ON coder_conversation_messages (run_id);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_versions_team_id_version_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_versions_coder_id_version_unique ON coder_versions (coder_id, version);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_runs_lang_graph_thread_id_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_runs_lang_graph_thread_id_unique ON coder_runs (lang_graph_thread_id);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_runs_workspace_created_idx;
--> statement-breakpoint
CREATE INDEX coder_runs_workspace_created_idx ON coder_runs (workspace_id, created_at);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_task_attempts_run_id_task_key_attempt_index_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_task_attempts_run_id_task_key_attempt_index_unique ON coder_task_attempts (run_id, task_key, attempt_index);
--> statement-breakpoint
DROP INDEX IF EXISTS executor_task_attempts_run_task_idx;
--> statement-breakpoint
CREATE INDEX coder_task_attempts_run_task_idx ON coder_task_attempts (run_id, task_key);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_documents_run_id_key_revision_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_documents_run_id_key_revision_unique ON coder_documents (run_id, key, revision);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_documents_run_idx;
--> statement-breakpoint
CREATE INDEX coder_documents_run_idx ON coder_documents (run_id, created_at);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_pending_inputs_run_status_idx;
--> statement-breakpoint
CREATE INDEX coder_pending_inputs_run_status_idx ON coder_pending_inputs (run_id, status);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_operations_run_idx;
--> statement-breakpoint
CREATE INDEX coder_operations_run_idx ON coder_operations (run_id, task_key);
--> statement-breakpoint
DROP INDEX IF EXISTS agent_team_operations_run_id_task_key_operation_key_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX coder_operations_run_id_task_key_operation_key_unique ON coder_operations (run_id, task_key, operation_key);
--> statement-breakpoint

-- Built-in ids. Children first is not required because foreign keys are deferred.
UPDATE coders SET id = 'quick_coder' WHERE id = 'agent_team_direct';
--> statement-breakpoint
UPDATE coders SET id = 'company_coder' WHERE id = 'agent_team_bmad_tea';
--> statement-breakpoint
UPDATE coder_repositories SET coder_id = CASE coder_id WHEN 'agent_team_direct' THEN 'quick_coder' ELSE 'company_coder' END WHERE coder_id IN ('agent_team_direct', 'agent_team_bmad_tea');
--> statement-breakpoint
UPDATE coder_groups SET coder_id = CASE coder_id WHEN 'agent_team_direct' THEN 'quick_coder' ELSE 'company_coder' END WHERE coder_id IN ('agent_team_direct', 'agent_team_bmad_tea');
--> statement-breakpoint
UPDATE coder_memories SET coder_id = CASE coder_id WHEN 'agent_team_direct' THEN 'quick_coder' ELSE 'company_coder' END WHERE coder_id IN ('agent_team_direct', 'agent_team_bmad_tea');
--> statement-breakpoint
UPDATE coder_conversations SET coder_id = CASE coder_id WHEN 'agent_team_direct' THEN 'quick_coder' ELSE 'company_coder' END WHERE coder_id IN ('agent_team_direct', 'agent_team_bmad_tea');
--> statement-breakpoint
UPDATE coder_versions SET coder_id = CASE coder_id WHEN 'agent_team_direct' THEN 'quick_coder' ELSE 'company_coder' END WHERE coder_id IN ('agent_team_direct', 'agent_team_bmad_tea');
--> statement-breakpoint
UPDATE coder_runs SET coder_id = CASE coder_id WHEN 'agent_team_direct' THEN 'quick_coder' ELSE 'company_coder' END WHERE coder_id IN ('agent_team_direct', 'agent_team_bmad_tea');
--> statement-breakpoint

-- Captured display name key in version snapshots.
UPDATE coder_versions SET snapshot = json_remove(json_set(snapshot, '$.coderName', json_extract(snapshot, '$.executorName')), '$.executorName')
  WHERE json_type(snapshot, '$.executorName') IS NOT NULL;
--> statement-breakpoint

-- Chat submission bindings: target and reference carry the Coder kind and id. Legacy
-- 'team' rows were already unread before this rename and stay as they are.
UPDATE chat_submissions SET target = json_remove(json_set(target, '$.kind', 'coder', '$.coderId',
    CASE json_extract(target, '$.executorCategoryId')
      WHEN 'agent_team_direct' THEN 'quick_coder' WHEN 'agent_team_bmad_tea' THEN 'company_coder'
      ELSE json_extract(target, '$.executorCategoryId') END),
    '$.executorCategoryId')
  WHERE json_valid(target) AND json_extract(target, '$.kind') = 'executor_category';
--> statement-breakpoint
UPDATE chat_submissions SET reference = json_remove(json_set(reference, '$.kind', 'coder', '$.coderId',
    CASE json_extract(reference, '$.executorCategoryId')
      WHEN 'agent_team_direct' THEN 'quick_coder' WHEN 'agent_team_bmad_tea' THEN 'company_coder'
      ELSE json_extract(reference, '$.executorCategoryId') END),
    '$.executorCategoryId')
  WHERE json_valid(reference) AND json_extract(reference, '$.kind') = 'executor_category';
