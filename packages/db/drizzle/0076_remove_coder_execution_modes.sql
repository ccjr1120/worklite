-- Router owns step selection; fixed execution modes are no longer stored.
ALTER TABLE coder_runs DROP COLUMN mode;
--> statement-breakpoint
ALTER TABLE coder_runs DROP COLUMN mode_rationale;
--> statement-breakpoint
ALTER TABLE coder_runs DROP COLUMN mode_decided_at;
--> statement-breakpoint
ALTER TABLE coder_groups DROP COLUMN mode;
