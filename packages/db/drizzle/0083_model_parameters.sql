ALTER TABLE agents ADD COLUMN model_parameters TEXT;
--> statement-breakpoint
ALTER TABLE agent_versions ADD COLUMN model_parameters TEXT;
--> statement-breakpoint
ALTER TABLE chat_bot_configurations ADD COLUMN model_parameters TEXT;
