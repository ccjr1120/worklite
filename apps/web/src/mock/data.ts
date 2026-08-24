export const RUN_STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  waiting_for_input: 'Waiting for input',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

// Backend RunStatus mapping used by the UI:
// queued -> Queued
// running -> Running
// succeeded -> Completed
// failed -> Failed
// cancelled -> Cancelled
// timed_out -> Failed
// waiting_for_input is a UI status until the API exposes it.

export type RunUiStatus = keyof typeof RUN_STATUS_LABELS;

export type TeamRole = 'admin' | 'member';

export type Team = {
  id: string;
  slug: string;
  name: string;
  isNew: boolean;
  role: TeamRole;
};

export type Agent = {
  id: string;
  teamSlug: string;
  name: string;
  responsibility: string;
  initials: string;
  model: string;
  skills: string[];
  version: string;
  status: RunUiStatus | 'idle';
  updatedAt: string;
};

export type Workflow = {
  id: string;
  teamSlug: string;
  name: string;
  state: 'draft' | 'published';
  stepCount: number;
  lastRunStatus: RunUiStatus | null;
  lastRunAt: string | null;
  updatedAt: string;
  needsAttention?: boolean;
};

export type WorkflowStep = {
  id: string;
  position: number;
  agentId: string;
  agentName: string;
  agentVersion: string;
  inputSummary: string;
  errorPolicy: 'stop' | 'retry';
  status?: RunUiStatus | 'idle';
};

export type Run = {
  id: string;
  teamSlug: string;
  workflowId: string;
  workflowName: string;
  version: string;
  status: RunUiStatus;
  currentStep: string | null;
  startedAt: string;
  durationSeconds: number | null;
  initiator: string;
};

export type Skill = {
  id: string;
  teamSlug: string;
  name: string;
  source: 'online' | 'archive';
  version: string;
  validation: 'valid' | 'invalid' | 'pending';
  updatedAt: string;
};

export type McpServer = {
  id: string;
  teamSlug: string;
  name: string;
  connection: 'connected' | 'unreachable' | 'auth_failed' | 'unconfigured';
  transport: 'Streamable HTTP';
  allowedTools: number;
  version: string;
  updatedAt: string;
};

export type Artifact = {
  id: string;
  teamSlug: string;
  name: string;
  type: 'json' | 'text' | 'markdown' | 'unsupported';
  workflowName: string;
  runId: string;
  size: string;
  createdAt: string;
  content: string;
};

export type Member = {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  status: 'active' | 'pending' | 'expired';
  lastActive: string | null;
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  resource: string;
  timestamp: string;
  metadata: string;
};

export type ModelProvider = {
  id: string;
  name: string;
  status: 'connected' | 'unconfigured' | 'invalid';
  maskedKey: string;
  models: string[];
};

export const currentUser = {
  id: 'user_me',
  name: 'Alex Chen',
  email: 'alex@acme.test',
};

export const teams: Team[] = [
  { id: 'team_acme', slug: 'acme', name: 'Acme', isNew: false, role: 'admin' },
  { id: 'team_northstar', slug: 'northstar', name: 'Northstar', isNew: true, role: 'admin' },
];

export const agents: Agent[] = [
  {
    id: 'agt_researcher',
    teamSlug: 'acme',
    name: 'Researcher',
    responsibility: 'Gather sources and summarize findings',
    initials: 'RE',
    model: 'claude-sonnet-4',
    skills: ['web-search', 'citations'],
    version: 'v3',
    status: 'completed',
    updatedAt: '2026-08-13 16:40',
  },
  {
    id: 'agt_writer',
    teamSlug: 'acme',
    name: 'Brief writer',
    responsibility: 'Turn research into a concise brief',
    initials: 'BW',
    model: 'gpt-4.1',
    skills: ['style-guide'],
    version: 'v2',
    status: 'idle',
    updatedAt: '2026-08-12 09:18',
  },
  {
    id: 'agt_reviewer',
    teamSlug: 'acme',
    name: 'Reviewer',
    responsibility: 'Check claims, tone, and completeness',
    initials: 'RV',
    model: 'claude-sonnet-4',
    skills: [],
    version: 'v1',
    status: 'failed',
    updatedAt: '2026-08-11 21:04',
  },
];

export const workflows: Workflow[] = [
  {
    id: 'wf_daily_brief',
    teamSlug: 'acme',
    name: 'Daily research brief',
    state: 'published',
    stepCount: 3,
    lastRunStatus: 'running',
    lastRunAt: '2026-08-14 08:12',
    updatedAt: '2026-08-13 18:02',
  },
  {
    id: 'wf_incident',
    teamSlug: 'acme',
    name: 'Incident summary',
    state: 'draft',
    stepCount: 2,
    lastRunStatus: 'failed',
    lastRunAt: '2026-08-12 14:33',
    updatedAt: '2026-08-14 07:51',
    needsAttention: true,
  },
  {
    id: 'wf_onboarding_notes',
    teamSlug: 'acme',
    name: 'Customer onboarding notes',
    state: 'published',
    stepCount: 2,
    lastRunStatus: 'completed',
    lastRunAt: '2026-08-10 11:20',
    updatedAt: '2026-08-10 11:44',
  },
];

export const workflowSteps: Record<string, WorkflowStep[]> = {
  wf_daily_brief: [
    {
      id: 'step_1',
      position: 1,
      agentId: 'agt_researcher',
      agentName: 'Researcher',
      agentVersion: 'v3',
      inputSummary: 'topic → query',
      errorPolicy: 'retry',
      status: 'completed',
    },
    {
      id: 'step_2',
      position: 2,
      agentId: 'agt_writer',
      agentName: 'Brief writer',
      agentVersion: 'v2',
      inputSummary: 'findings → brief',
      errorPolicy: 'stop',
      status: 'running',
    },
    {
      id: 'step_3',
      position: 3,
      agentId: 'agt_reviewer',
      agentName: 'Reviewer',
      agentVersion: 'v1',
      inputSummary: 'brief → review',
      errorPolicy: 'stop',
      status: 'queued',
    },
  ],
  wf_incident: [
    {
      id: 'step_inc_1',
      position: 1,
      agentId: 'agt_researcher',
      agentName: 'Researcher',
      agentVersion: 'v3',
      inputSummary: 'incident → timeline',
      errorPolicy: 'retry',
    },
    {
      id: 'step_inc_2',
      position: 2,
      agentId: 'agt_writer',
      agentName: 'Brief writer',
      agentVersion: 'v2',
      inputSummary: 'timeline → summary',
      errorPolicy: 'stop',
    },
  ],
};

export const runs: Run[] = [
  {
    id: 'run_1042',
    teamSlug: 'acme',
    workflowId: 'wf_daily_brief',
    workflowName: 'Daily research brief',
    version: 'v8',
    status: 'running',
    currentStep: 'Brief writer',
    startedAt: '2026-08-14 08:12',
    durationSeconds: 258,
    initiator: 'Alex Chen',
  },
  {
    id: 'run_1041',
    teamSlug: 'acme',
    workflowId: 'wf_incident',
    workflowName: 'Incident summary',
    version: 'draft',
    status: 'failed',
    currentStep: 'Brief writer',
    startedAt: '2026-08-12 14:33',
    durationSeconds: 62,
    initiator: 'Sam Ortiz',
  },
  {
    id: 'run_1038',
    teamSlug: 'acme',
    workflowId: 'wf_onboarding_notes',
    workflowName: 'Customer onboarding notes',
    version: 'v2',
    status: 'completed',
    currentStep: null,
    startedAt: '2026-08-10 11:20',
    durationSeconds: 47,
    initiator: 'Alex Chen',
  },
  {
    id: 'run_1036',
    teamSlug: 'acme',
    workflowId: 'wf_daily_brief',
    workflowName: 'Daily research brief',
    version: 'v7',
    status: 'queued',
    currentStep: null,
    startedAt: '2026-08-10 07:00',
    durationSeconds: null,
    initiator: 'Scheduler',
  },
];

export const skills: Skill[] = [
  {
    id: 'sk_web_search',
    teamSlug: 'acme',
    name: 'web-search',
    source: 'archive',
    version: 'v4',
    validation: 'valid',
    updatedAt: '2026-08-09 15:12',
  },
  {
    id: 'sk_style',
    teamSlug: 'acme',
    name: 'style-guide',
    source: 'online',
    version: 'draft',
    validation: 'pending',
    updatedAt: '2026-08-14 09:04',
  },
  {
    id: 'sk_citations',
    teamSlug: 'acme',
    name: 'citations',
    source: 'online',
    version: 'v1',
    validation: 'invalid',
    updatedAt: '2026-08-08 10:22',
  },
];

export const mcpServers: McpServer[] = [
  {
    id: 'mcp_docs',
    teamSlug: 'acme',
    name: 'Internal docs',
    connection: 'connected',
    transport: 'Streamable HTTP',
    allowedTools: 6,
    version: 'v2',
    updatedAt: '2026-08-11 13:40',
  },
  {
    id: 'mcp_crm',
    teamSlug: 'acme',
    name: 'CRM lookup',
    connection: 'auth_failed',
    transport: 'Streamable HTTP',
    allowedTools: 3,
    version: 'v1',
    updatedAt: '2026-08-13 19:08',
  },
];

export const artifacts: Artifact[] = [
  {
    id: 'art_brief_1042',
    teamSlug: 'acme',
    name: 'daily-brief.md',
    type: 'markdown',
    workflowName: 'Daily research brief',
    runId: 'run_1042',
    size: '12 KB',
    createdAt: '2026-08-14 08:16',
    content: '# Daily research brief\n\n- Market movement remains concentrated in two suppliers.\n- Open questions: pricing window and contract renewal.',
  },
  {
    id: 'art_timeline',
    teamSlug: 'acme',
    name: 'incident-timeline.json',
    type: 'json',
    workflowName: 'Incident summary',
    runId: 'run_1041',
    size: '4 KB',
    createdAt: '2026-08-12 14:34',
    content: '{\n  "startedAt": "14:02",\n  "impact": "partial",\n  "cause": "timeout talking to CRM lookup"\n}',
  },
];

export const members: Member[] = [
  { id: 'mem_1', name: 'Alex Chen', email: 'alex@acme.test', role: 'admin', status: 'active', lastActive: '2026-08-14T06:24:00Z' },
  { id: 'mem_2', name: 'Sam Ortiz', email: 'sam@acme.test', role: 'member', status: 'active', lastActive: '2026-08-14T04:24:00Z' },
  { id: 'mem_3', name: 'Jordan Lee', email: 'jordan@acme.test', role: 'member', status: 'pending', lastActive: null },
];

export const auditEvents: AuditEvent[] = [
  {
    id: 'aud_1',
    actor: 'Alex Chen',
    action: 'Published workflow',
    resource: 'Daily research brief v8',
    timestamp: '2026-08-13 18:02:14',
    metadata: '{ "workflowId": "wf_daily_brief", "version": "v8" }',
  },
  {
    id: 'aud_2',
    actor: 'Sam Ortiz',
    action: 'Invited member',
    resource: 'jordan@acme.test',
    timestamp: '2026-08-13 12:11:03',
    metadata: '{ "role": "member" }',
  },
  {
    id: 'aud_3',
    actor: 'Alex Chen',
    action: 'Updated model provider',
    resource: 'Anthropic',
    timestamp: '2026-08-12 09:44:51',
    metadata: '{ "credential": "[redacted]" }',
  },
];

export const modelProviders: ModelProvider[] = [
  {
    id: 'prov_anthropic',
    name: 'Anthropic',
    status: 'connected',
    maskedKey: 'sk-ant-••••4242',
    models: ['claude-sonnet-4', 'claude-opus-4'],
  },
  {
    id: 'prov_openai',
    name: 'OpenAI',
    status: 'connected',
    maskedKey: 'sk-••••9188',
    models: ['gpt-4.1', 'gpt-4.1-mini'],
  },
];

export const invitations = {
  valid: {
    token: 'join-acme',
    teamName: 'Acme',
    email: 'alex@acme.test',
    status: 'valid' as const,
  },
  expired: {
    token: 'expired-token',
    teamName: 'Northstar',
    email: 'guest@example.com',
    status: 'expired' as const,
  },
};

export const activity = [
  { id: 'act_1', text: 'Daily research brief started running', time: '8:12' },
  { id: 'act_2', text: 'Incident summary failed on Brief writer', time: 'Yesterday' },
  { id: 'act_3', text: 'Alex published Daily research brief v8', time: 'Yesterday' },
];

export const usageRows = [
  { model: 'claude-sonnet-4', tokens: 1284220, runs: 48, cost: 38.12 },
  { model: 'gpt-4.1', tokens: 642110, runs: 21, cost: 19.4 },
  { model: 'gpt-4.1-mini', tokens: 88004, runs: 9, cost: 1.12 },
];

export function teamBySlug(slug: string) {
  return teams.find((team) => team.slug === slug);
}

export function filterByTeam<T extends { teamSlug: string }>(items: T[], slug: string) {
  return items.filter((item) => item.teamSlug === slug);
}
