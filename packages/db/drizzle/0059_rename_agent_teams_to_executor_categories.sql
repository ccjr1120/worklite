-- Rename all agent_team* tables and columns to executor_category* / executor_* equivalents
-- This migration preserves all existing data while renaming the schema

-- Rename main tables
ALTER TABLE agent_teams RENAME TO executor_categories;
ALTER TABLE agent_team_repositories RENAME TO executor_category_repositories;
ALTER TABLE agent_team_groups RENAME TO executor_groups;
ALTER TABLE agent_team_group_repositories RENAME TO executor_group_repositories;
ALTER TABLE agent_team_group_messages RENAME TO executor_group_messages;
ALTER TABLE agent_team_group_events RENAME TO executor_group_events;
ALTER TABLE agent_team_memories RENAME TO executor_category_memories;
ALTER TABLE agent_team_conversations RENAME TO executor_conversations;
ALTER TABLE agent_team_intakes RENAME TO executor_intakes;
ALTER TABLE agent_team_conversation_messages RENAME TO executor_conversation_messages;
ALTER TABLE agent_team_conversation_events RENAME TO executor_conversation_events;
ALTER TABLE agent_team_versions RENAME TO executor_category_versions;
ALTER TABLE agent_team_runs RENAME TO executor_runs;
ALTER TABLE agent_team_task_attempts RENAME TO executor_task_attempts;
ALTER TABLE agent_team_documents RENAME TO executor_documents;
ALTER TABLE agent_team_run_events RENAME TO executor_run_events;
ALTER TABLE agent_team_pending_inputs RENAME TO executor_pending_inputs;
ALTER TABLE agent_team_operations RENAME TO executor_operations;

-- Rename columns in executor_categories (was agent_teams)
-- No column renames needed in this table - the primary key structure is unchanged

-- Rename columns in executor_category_repositories (was agent_team_repositories)
ALTER TABLE executor_category_repositories RENAME COLUMN team_id TO executor_category_id;

-- Rename columns in executor_groups (was agent_team_groups)
ALTER TABLE executor_groups RENAME COLUMN team_id TO executor_category_id;

-- Rename index for executor_groups
DROP INDEX agent_team_groups_workspace_updated_idx;
CREATE INDEX executor_groups_workspace_updated_idx ON executor_groups(workspace_id, updated_at);

-- Rename columns in executor_group_repositories (was agent_team_group_repositories)
ALTER TABLE executor_group_repositories RENAME COLUMN team_repository_id TO executor_category_repository_id;

-- Rename index for executor_group_repositories
DROP INDEX agent_team_group_repositories_group_idx;
CREATE INDEX executor_group_repositories_group_idx ON executor_group_repositories(group_id);

-- Rename columns in executor_group_messages (was agent_team_group_messages)
-- Rename index for executor_group_messages
DROP INDEX agent_team_group_messages_run_idx;
CREATE INDEX executor_group_messages_run_idx ON executor_group_messages(run_id);

-- Rename columns in executor_category_memories (was agent_team_memories)
ALTER TABLE executor_category_memories RENAME COLUMN team_id TO executor_category_id;
ALTER TABLE executor_category_memories RENAME COLUMN repository_id TO executor_category_repository_id;

-- Rename index for executor_category_memories
DROP INDEX agent_team_memories_scope_idx;
CREATE INDEX executor_category_memories_scope_idx ON executor_category_memories(executor_category_id, executor_category_repository_id, role, updated_at);

DROP INDEX agent_team_memories_upsert_idx;
CREATE UNIQUE INDEX executor_category_memories_upsert_idx ON executor_category_memories(executor_category_id, executor_category_repository_id, upsert_key);

DROP INDEX agent_team_memories_source_run_idx;
CREATE INDEX executor_category_memories_source_run_idx ON executor_category_memories(source_run_id);

-- Rename columns in executor_conversations (was agent_team_conversations)
ALTER TABLE executor_conversations RENAME COLUMN team_id TO executor_category_id;

-- Rename columns in executor_intakes (was agent_team_intakes)
-- No team_id columns need renaming, already references conversation_id

-- Rename index for executor_intakes
DROP INDEX agent_team_intakes_conversation_status_idx;
CREATE INDEX executor_intakes_conversation_status_idx ON executor_intakes(conversation_id, status);

-- Rename columns in executor_conversation_messages (was agent_team_conversation_messages)
-- Rename index for executor_conversation_messages
DROP INDEX agent_team_conversation_messages_run_idx;
CREATE INDEX executor_conversation_messages_run_idx ON executor_conversation_messages(run_id);

-- Rename columns in executor_category_versions (was agent_team_versions)
ALTER TABLE executor_category_versions RENAME COLUMN team_id TO executor_category_id;

-- Rename columns in executor_runs (was agent_team_runs)
ALTER TABLE executor_runs RENAME COLUMN team_id TO executor_category_id;
ALTER TABLE executor_runs RENAME COLUMN team_version_id TO executor_category_version_id;

-- Rename index for executor_runs
DROP INDEX agent_team_runs_workspace_created_idx;
CREATE INDEX executor_runs_workspace_created_idx ON executor_runs(workspace_id, created_at);

-- Rename columns in executor_task_attempts (was agent_team_task_attempts)
-- Rename index for executor_task_attempts
DROP INDEX agent_team_task_attempts_run_task_idx;
CREATE INDEX executor_task_attempts_run_task_idx ON executor_task_attempts(run_id, task_key);

-- Rename columns in executor_documents (was agent_team_documents)
-- No further column renames needed

-- Update string values in dispatch_task related columns and audit logs
UPDATE executor_runs
SET intent = REPLACE(intent, 'agent_team_', 'executor_category_')
WHERE intent LIKE '%agent_team_%';

-- Update target.kind from 'team' to 'executor_category' in audit logs and event payloads
-- This handles JSON string values that may reference old surface names
UPDATE executor_runs
SET outcome = json_set(outcome, '$.target.kind', 'executor_category')
WHERE json_extract(outcome, '$.target.kind') = 'team';

UPDATE executor_group_events
SET payload = json_replace(payload, '$.surface', 'executor_category')
WHERE json_extract(payload, '$.surface') = 'team';

UPDATE executor_run_events
SET payload = json_replace(payload, '$.surface', 'executor_category')
WHERE json_extract(payload, '$.surface') = 'team';

-- Update gateway attribution surface values in chat configurations
UPDATE executor_runs
SET outcome = json_replace(outcome, '$.surface', 'executor_category_project_task')
WHERE json_extract(outcome, '$.surface') = 'team_project_task';

UPDATE executor_runs
SET outcome = json_replace(outcome, '$.surface', 'executor_category')
WHERE json_extract(outcome, '$.surface') = 'team';
