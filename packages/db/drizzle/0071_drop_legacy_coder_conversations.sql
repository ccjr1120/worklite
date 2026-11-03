-- Pre-group Coder conversations have no active readers or write path. Remove their
-- data and tables instead of copying obsolete records into a compatibility archive.
DROP TABLE coder_conversation_events;
--> statement-breakpoint
DROP TABLE coder_conversation_messages;
--> statement-breakpoint
DROP TABLE coder_intakes;
--> statement-breakpoint
DROP TABLE coder_conversations;
