-- Add soft delete support to agent_teams table
ALTER TABLE agent_teams ADD COLUMN deleted_at INTEGER;