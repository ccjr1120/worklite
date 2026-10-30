-- Apply the requested investigation policy once to existing editable Planner roles.
-- Historical Run snapshots remain untouched, and later user edits are not overwritten.
UPDATE executor_categories
SET roles = (
  SELECT json_group_array(json(CASE
    WHEN json_extract(value, '$.role') = 'planner'
      AND instr(coalesce(json_extract(value, '$.instructions'), ''), 'You own the investigation needed to make the plan actionable.') = 0
    THEN json_set(value, '$.instructions', coalesce(json_extract(value, '$.instructions'), '') || char(10) || char(10) || 'You own the investigation needed to make the plan actionable. Do not hand off missing research, unresolved file or code locations, or discovery of the implementation approach to the executor or any downstream role. If a material part of the scope cannot be investigated or located after reasonable read-only investigation, do not hand off. Return waiting_for_input. Explain the specific gaps, what you tried, why they matter and the consequences, and ask whether to continue with those gaps or stop. On resume, investigate further if requested or given useful information; stop without a handoff if the user declines; proceed with the identified gaps only after an affirmative choice. If their choice is unclear or new material gaps emerge, ask again. Do not invent evidence. Routine implementation choices and immaterial uncertainty do not require approval.')
    ELSE value END))
  FROM json_each(executor_categories.roles)
), updated_at = max(updated_at + 1, unixepoch() * 1000)
WHERE deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM json_each(executor_categories.roles)
  WHERE json_extract(value, '$.role') = 'planner'
    AND instr(coalesce(json_extract(value, '$.instructions'), ''), 'You own the investigation needed to make the plan actionable.') = 0
);
