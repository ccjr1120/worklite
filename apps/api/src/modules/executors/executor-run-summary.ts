import type { AgentTeamRunCurrentView, AgentTeamTaskAttemptView } from '@worklite/contracts';
import type { StoredAgentTeamVersionSnapshot } from '@worklite/db';
import { normalizePublicModelList } from '@worklite/model-gateway';

const RESERVED_DEVELOPER_ID = 'developer';
const IN_FLIGHT_STATUSES: ReadonlySet<AgentTeamTaskAttemptView['status']> = new Set(['running', 'waiting_for_input', 'waiting_for_recovery']);

type AttemptIdentity = { role: string; developerId: string | null };

// Display name of the executor that ran a Run: the name captured by value at dispatch
// (in the bound executor version), falling back to the executor's current name only when
// that version predates name capture and was not backfilled.
export function capturedExecutorName(snapshot: Pick<StoredAgentTeamVersionSnapshot, 'executorName'>, currentName: string): string {
  return snapshot.executorName?.trim() || currentName;
}

export function taskRoleName(snapshot: StoredAgentTeamVersionSnapshot, role: string): string | null {
  return snapshot.roles.find((item) => item.role === role)?.displayName?.trim() || null;
}

// Mirrors the runtime's model resolution for one attempt so the Run view reports the model the
// attempt actually launched with, without storing it again. Project-executor roles with no model
// keep the captured launch model; WorkLite Agent roles fall back to the executor default.
export function effectiveTaskModel(snapshot: StoredAgentTeamVersionSnapshot, task: AttemptIdentity, teamDefaultModel = ''): string | null {
  const role = snapshot.roles.find((item) => item.role === task.role);
  const developerId = task.developerId ?? RESERVED_DEVELOPER_ID;
  const instance = role?.developerInstances?.find((candidate) => candidate.developerId === developerId);
  // The view reports the primary (first) candidate when a fallback list is declared.
  const configured = normalizePublicModelList((instance ?? role)?.publicModelId ?? '')[0];
  if (configured) return configured;
  const orchestrationVersion = snapshot.orchestrationVersion ?? 1;
  const executorBacked = task.role === 'developer' || (orchestrationVersion >= 7 && Boolean(role?.executor));
  if (!executorBacked) return teamDefaultModel.trim() || null;
  const launch = (orchestrationVersion >= 7 ? snapshot.projectExecutorLaunches?.[task.role] : undefined)
    ?? snapshot.developerExecutions?.[developerId]
    ?? snapshot.developerExecutions?.[RESERVED_DEVELOPER_ID]
    ?? snapshot.developerExecution;
  return launch && 'executor' in launch ? launch.model?.trim() || null : null;
}

export function deriveRunCurrent(tasks: readonly AgentTeamTaskAttemptView[]): AgentTeamRunCurrentView | null {
  const inFlight = tasks.filter((task) => IN_FLIGHT_STATUSES.has(task.status));
  if (!inFlight.length) return null;
  const startedAt = (task: AgentTeamTaskAttemptView) => Date.parse(task.startedAt ?? task.createdAt) || 0;
  const current = inFlight.reduce((latest, task) => startedAt(task) >= startedAt(latest) ? task : latest);
  return {
    taskAttemptId: current.id,
    taskKey: current.taskKey,
    role: current.role,
    roleName: current.roleName,
    model: current.model,
    status: current.status,
    assignmentTitle: current.assignmentTitle,
    progressText: current.progressText,
    startedAt: current.startedAt,
    activeCount: inFlight.length,
    activeRoleCount: new Set(inFlight.map((task) => task.role)).size,
  };
}
