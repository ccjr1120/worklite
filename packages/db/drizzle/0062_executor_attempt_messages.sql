-- A resumed task may ask several questions before its one completion or handoff.
DROP INDEX IF EXISTS `agent_team_group_messages_task_attempt_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `executor_group_messages_attempt_completion_idx` ON `executor_group_messages` (`task_attempt_id`) WHERE `kind` IN ('text', 'handoff');
