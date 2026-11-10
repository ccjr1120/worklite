import type BetterSqlite3 from 'better-sqlite3';
import { getTableColumns, is, SQL, sql } from 'drizzle-orm';
import {
  agentExecutions,
  chatProjectTasks,
  type StoredAgentModelMessage,
  type StoredAgentDisplayMessage,
} from './schema';

/** Incremental writes are ordinary SQLite triggers, within the parent statement. */
export function installStoredArrayStorage(client: BetterSqlite3.Database): void {
  client.exec(
    `CREATE TABLE IF NOT EXISTS stored_json_items(owner_id TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id,kind,position)) WITHOUT ROWID`,
  );
  for (const [table, column, kind] of [
    ['agent_executions', 'model_messages', 'model'],
    ['agent_executions', 'display_messages', 'display'],
    ['chat_codex_tasks', 'activities', 'activity'],
  ]) {
    if (!client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    client.exec(arrayTriggerSql(table, column, kind));
  }
}
export function arrayTriggerSql(table: string, column: string, kind: string): string {
  return `
    DROP TRIGGER IF EXISTS ${kind}_array_append_seed;
    DROP TRIGGER IF EXISTS ${kind}_array_store;
    CREATE TRIGGER ${kind}_array_append_seed BEFORE UPDATE OF ${column} ON ${table}
    WHEN (json_type(NEW.${column}, '$.$append')='array' OR json_type(NEW.${column}, '$.$patch')='array') AND OLD.${column}<>'[]'
    BEGIN
      DELETE FROM stored_json_items WHERE owner_id=OLD.id AND kind='${kind}';
      INSERT INTO stored_json_items(owner_id,kind,position,value) SELECT OLD.id,'${kind}',CAST(key AS INTEGER),value FROM json_each(OLD.${column});
    END;
    CREATE TRIGGER ${kind}_array_store AFTER UPDATE OF ${column} ON ${table}
    WHEN json_type(NEW.${column})='object'
    BEGIN
      DELETE FROM stored_json_items WHERE owner_id=NEW.id AND kind='${kind}' AND json_type(NEW.${column}, '$.$replace')='array' AND position>=json_array_length(NEW.${column},'$.$replace');
      DELETE FROM stored_json_items WHERE owner_id=NEW.id AND kind='${kind}' AND json_type(NEW.${column}, '$.$patch')='array' AND position>=json_extract(NEW.${column},'$.$length');
      INSERT INTO stored_json_items(owner_id,kind,position,value)
        SELECT NEW.id,'${kind}',json_extract(value,'$.position'),json_extract(value,'$.value') FROM json_each(NEW.${column},'$.$patch') WHERE true
        ON CONFLICT(owner_id,kind,position) DO UPDATE SET value=excluded.value;
      INSERT INTO stored_json_items(owner_id,kind,position,value)
        SELECT NEW.id,'${kind}',CAST(key AS INTEGER),value FROM json_each(NEW.${column},'$.$replace') WHERE true
        ON CONFLICT(owner_id,kind,position) DO UPDATE SET value=excluded.value WHERE stored_json_items.value<>excluded.value;
      INSERT INTO stored_json_items(owner_id,kind,position,value)
        SELECT NEW.id,'${kind}',base.position+CAST(j.key AS INTEGER),j.value
        FROM (SELECT coalesce(max(position),-1)+1 AS position FROM stored_json_items WHERE owner_id=NEW.id AND kind='${kind}') base,
          json_each(NEW.${column},'$.$append') j;
      UPDATE ${table} SET ${column}='[]' WHERE id=NEW.id;
    END;`;
}

export function storedArray<T>(
  owner: typeof agentExecutions.id | typeof chatProjectTasks.id,
  legacy:
    | typeof agentExecutions.modelMessages
    | typeof agentExecutions.displayMessages
    | typeof chatProjectTasks.activities,
  kind: 'model' | 'display' | 'activity',
) {
  return sql<string>`case when ${legacy} <> '[]' then ${legacy} else coalesce((select json_group_array(json(value)) from (select value from stored_json_items where owner_id = ${owner} and kind = ${kind} order by position)), '[]') end`.mapWith(
    (value): T[] => JSON.parse(value),
  );
}
export const modelMessagesColumn = storedArray<StoredAgentModelMessage>(
  agentExecutions.id,
  agentExecutions.modelMessages,
  'model',
);
export const displayMessagesColumn = storedArray<StoredAgentDisplayMessage>(
  agentExecutions.id,
  agentExecutions.displayMessages,
  'display',
);
export const agentExecutionColumns = {
  ...getTableColumns(agentExecutions),
  modelMessages: modelMessagesColumn,
  displayMessages: displayMessagesColumn,
};
export const projectTaskColumns = {
  ...getTableColumns(chatProjectTasks),
  activities: storedArray<Record<string, unknown>>(
    chatProjectTasks.id,
    chatProjectTasks.activities,
    'activity',
  ),
};

export function executionUpdates<
  T extends {
    [K in keyof typeof agentExecutions.$inferInsert]?:
      | (typeof agentExecutions.$inferInsert)[K]
      | SQL;
  },
>(_id: string, changes: T) {
  const values = { ...changes };
  if ('modelMessages' in changes && !is(changes.modelMessages, SQL))
    Object.assign(values, {
      modelMessages: sql`${JSON.stringify({ $replace: changes.modelMessages })}`,
    });
  if ('displayMessages' in changes && !is(changes.displayMessages, SQL))
    Object.assign(values, {
      displayMessages: sql`${JSON.stringify({ $replace: changes.displayMessages })}`,
    });
  return values as Omit<T, 'modelMessages' | 'displayMessages'> & {
    modelMessages?: ReturnType<typeof sql>;
    displayMessages?: ReturnType<typeof sql>;
  };
}
export function activityValue(_id: string, values: unknown[]) {
  return sql`${JSON.stringify({ $replace: values })}`;
}

export function appendExecutionMessages(
  _id: string,
  _kind: 'model' | 'display',
  values: unknown[],
) {
  return sql`${JSON.stringify({ $append: values })}`;
}
export function appendActivityValues(_id: string, values: unknown[]) {
  return sql`${JSON.stringify({ $append: values })}`;
}

/** Snapshot strings catch in-place SDK mutations too; only changed positions enter SQL. */
export function encodeMessageState(messages: readonly unknown[]): string[] {
  return messages.map((message) => JSON.stringify(message));
}
export function patchExecutionMessages(previous: readonly string[], messages: readonly unknown[]) {
  const encoded = encodeMessageState(messages);
  const patch = encoded.flatMap((value, position) =>
    previous[position] === value ? [] : [{ position, value }],
  );
  return {
    encoded,
    changed: patch.length > 0 || previous.length !== encoded.length,
    value: sql`${JSON.stringify({ $patch: patch, $length: encoded.length })}`,
  };
}
