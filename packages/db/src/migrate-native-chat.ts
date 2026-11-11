import type BetterSqlite3 from 'better-sqlite3';
import { packJson, unpackJson } from './packed-json';

const CHAT_AGENT_ID = 'agt_system_helper_chat';

/** Retire Chat engine sessions without replaying tools or changing standalone Agents. */
export function migrateNativeChat(db: BetterSqlite3.Database): void {
  db.transaction(() => {
    db.prepare("UPDATE agents SET runtime = ? WHERE id = ? AND json_extract(runtime, '$.kind') != 'native'").run('{"kind":"native"}', CHAT_AGENT_ID);
    db.prepare("UPDATE chat_bot_configurations SET runtime = ? WHERE json_extract(runtime, '$.kind') != 'native'").run('{"kind":"native"}');
    const rows = db.prepare(`SELECT id, capability_snapshot FROM agent_executions
      WHERE agent_id = ? AND capability_snapshot IS NOT NULL
      AND json_extract(worklite_unpack_json(capability_snapshot), '$.agent.runtime.kind') IN ('claude', 'codex')`).all(CHAT_AGENT_ID) as Array<{ id: string; capability_snapshot: string }>;
    for (const row of rows) {
      const snapshot = unpackJson<{ agent: { runtime: { kind: string } } }>(row.capability_snapshot);
      snapshot.agent.runtime = { kind: 'native' };
      db.prepare('UPDATE agent_executions SET capability_snapshot = ? WHERE id = ?').run(packJson(snapshot), row.id);
      // Engine callbacks cannot be answered after retirement. Keep their records as evidence.
      db.prepare(`UPDATE agent_executions SET status = 'failed', pending_question = NULL,
        error_code = 'restarted', error = 'Chat now uses native. Inspect prior effects and send a new message to continue; no operations were replayed.', updated_at = ?
        WHERE id = ? AND status IN ('running', 'waiting_for_input')`).run(Date.now(), row.id);
      db.prepare(`UPDATE agent_tool_calls SET result_appended = 1,
        status = CASE WHEN status = 'running' THEN 'failed' ELSE status END,
        output = CASE WHEN status = 'running' THEN ? ELSE output END,
        finished_at = coalesce(finished_at, ?) WHERE execution_id = ? AND result_appended = 0`).run(
        JSON.stringify({ failure: { code: 'PLATFORM_EXECUTION_INTERRUPTED', effect: 'unknown', message: 'Chat runtime retired. Inspect prior effects before retrying.' } }), Date.now(), row.id,
      );
    }
    db.prepare(`UPDATE agent_runtime_interactions SET status = 'interrupted', updated_at = ?
      WHERE status = 'pending' AND run_id IN (SELECT r.id FROM agent_runtime_runs r
        JOIN agent_executions e ON e.id = r.session_id WHERE e.agent_id = ?)`).run(Date.now(), CHAT_AGENT_ID);
    db.prepare(`UPDATE agent_runtime_runs SET status = 'interrupted', updated_at = ?
      WHERE status IN ('running', 'waiting_for_input') AND session_id IN (SELECT id FROM agent_executions WHERE agent_id = ?)`).run(Date.now(), CHAT_AGENT_ID);
    db.prepare(`UPDATE agent_runtime_sessions SET status = 'closed', updated_at = ?
      WHERE status != 'closed' AND id IN (SELECT id FROM agent_executions WHERE agent_id = ?)`).run(Date.now(), CHAT_AGENT_ID);
  })();
}
