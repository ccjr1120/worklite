DELETE FROM `agent_execution_events`
WHERE `rowid` IN (
  SELECT `event`.`rowid`
  FROM `agent_execution_events` `event`
  JOIN (
    SELECT `execution_id`, max(`sequence`) AS `sequence`
    FROM `agent_execution_events`
    WHERE json_extract(`data`, '$.kind') = 'snapshot'
    GROUP BY `execution_id`
  ) `latest` ON `latest`.`execution_id` = `event`.`execution_id`
  WHERE `event`.`sequence` < `latest`.`sequence`
    AND json_extract(`event`.`data`, '$.kind') = 'snapshot'
);
