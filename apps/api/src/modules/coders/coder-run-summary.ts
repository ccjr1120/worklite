import type { AgentTeamRunCurrentView, AgentTeamTaskAttemptView } from '@worklite/contracts';
import type { StoredAgentTeamVersionSnapshot } from '@worklite/db';
import { normalizePublicModelList } from '@worklite/model-gateway';

const IN_FLIGHT_STATUSES: ReadonlySet<AgentTeamTaskAttemptView['status']> = new Set(['running', 'waiting_for_input', 'waiting_for_recovery']);

type AttemptIdentity = { role: string };

// Display name captured by value when the current Router Run was dispatched.
export function capturedCoderName(snapshot: Pick<StoredAgentTeamVersionSnapshot, 'coderName'>): string {
  return snapshot.coderName.trim();
}

export function taskRoleName(snapshot: StoredAgentTeamVersionSnapshot, role: string): string | null {
  return snapshot.roles.find((item) => item.role === role)?.displayName?.trim() || null;
}

// Mirrors the runtime's model resolution for one attempt so the Run view reports the model the
// attempt actually launched with, without storing it again. Project-executor roles with no model
// keep the captured launch model; WorkLite Agent roles fall back to the Coder default.
export function effectiveTaskModel(snapshot: StoredAgentTeamVersionSnapshot, task: AttemptIdentity, teamDefaultModel = ''): string | null {
  const role = snapshot.roles.find((item) => item.role === task.role);
  // The view reports the primary (first) candidate when a fallback list is declared.
  const configured = normalizePublicModelList(role?.publicModelId ?? '')[0];
  if (configured) return configured;
  if (!role?.executor) return teamDefaultModel.trim() || null;
  return snapshot.projectExecutorLaunches[task.role]?.model?.trim() || null;
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
