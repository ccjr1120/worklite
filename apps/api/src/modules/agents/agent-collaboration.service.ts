import { agentFiles } from './agent-file-store';
import { SubAgentInstance } from './sub-agent-instance';
import { delegationOverrides, delegationOverridesSchema, DelegationFailure, TASK_OWNERSHIP_PROMPT, type DelegationOverrides } from './agent-delegation';
import { BuiltinAgentToolsService } from './builtin-agent-tools.service';
import { privateToolCommand } from './agent-private-tools';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ProjectExecutorService } from './project-executor.service';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AgentRunView } from '@worklite/contracts';
import type { Request } from 'express';
import { normalizeAgentModelMessages, agentCapabilityResults, artifacts, auditLogs, agentExecutions, agentMcpServers, agentPendingActions, agents, agentSkills, agentToolCalls, skillFiles, skills, type Database } from '@worklite/db';
import type { GatewayAgentMessage, GatewayToolDefinition } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { resolveWorkflowNodeCapability, readWorkflowOutputPath } from '@worklite/workflow-engine';
import { AgentCapabilitiesService, assertRequiredSkillScriptCalls, assertWorkflowAgentOutputContract, type SkillScriptCallRecord, workflowAgentFailure } from './agent-capabilities.service';
import { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';

const invocationSchema = { type: 'object', additionalProperties: false, required: ['agentId', 'task'], properties: { agentId: { type: 'string' }, task: { description: 'The complete task and relevant context, or {$result: resultRef, path?: "$.field"}.' } } };
export const CHAT_AGENT_TOOLS: GatewayToolDefinition[] = [
  { name: 'control_agent_instance', description: 'Pause or resume one existing engine-backed sub-Agent instance inside an active lead execution. Read the lead history to identify the exact child runId; never guess or start replacement work. Other instances continue. Pause requires a saved engine session; resume continues that same session. Controls last only for the owning execution lifetime, not across API restarts.', inputSchema: { type: 'object', additionalProperties: false, required: ['agentId', 'executionId', 'runId', 'action'], properties: { agentId: { type: 'string', description: 'Owning top-level Agent id.' }, executionId: { type: 'string' }, runId: { type: 'string', description: 'Exact child invocation id from the lead history.' }, action: { type: 'string', enum: ['pause', 'resume'] } } } },
  { name: 'inspect_agents', description: 'List the user-facing Agents and their responsibilities. Only top-level Agents are listed and counted. Sub-Agents are private implementation details of their owning Agent; do not enumerate them or classify Agents as built-in or Teams.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'run_agent', description: 'Delegate the original user request and explicit constraints; the selected Agent decides how to fulfill the goal. Do not add extra research requirements or deliverables. Start or continue actual work, never a status/explanation query or stop request. mode=new starts an independent task with only necessary context. mode=continue appends new requirements to the exact same task; supply executionId and continuationReason. Same Agent, same project or an instance mention alone does not imply continuation. Read saved records to answer progress/failure questions; use cancellation APIs to stop. Cancelled tasks require an explicit user request to resume and resumeCancelled=true. Running or pending-input tasks must be controlled or answered, not relaunched. Inspect failed/uncertain external effects before retrying. A launch receipt is not completion; results are reported automatically.', inputSchema: { ...invocationSchema, required: ['agentId', 'task', 'mode'], properties: { ...invocationSchema.properties, mode: { type: 'string', enum: ['new', 'continue'] }, continuationReason: { type: 'string', description: 'For continue: identify the same task and the new requirement or supplied information. Do not use for status queries or unrelated goals.' }, resumeCancelled: { type: 'boolean', description: 'True only when the user explicitly asks to resume a cancelled task.' }, executionId: { type: 'string', description: 'Exact existing task for mode=continue only.' }, projectDirectory: { type: 'string', description: 'Absolute existing project directory; resolve names with search_local_projects.' } } } },
];
const subInvocationSchema = { ...invocationSchema, properties: { ...invocationSchema.properties, runId: { type: 'string', description: 'Continue this exact completed or failed directly owned invocation with its saved context. Never replace it with a new instance.' }, overrides: delegationOverridesSchema, background: { type: 'boolean', description: 'Return the instance runId immediately so you can pause/resume it; collect its result with wait_sub_agent.' } } };
const RESULT_TOOLS: GatewayToolDefinition[] = [
  { name: 'read_result', description: 'Read a saved result, including failed specialist raw output and tool evidence. Use path to focus on a field. For large values use offset and maxChars to read serialized text in pages. References are scoped to this task.', inputSchema: { type: 'object', additionalProperties: false, required: ['resultRef'], properties: { resultRef: { type: 'string' }, path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 12000 } } } },
  { name: 'store_result', description: 'Save your own work or a repaired specialist result for subsequent tools. This only stores data; it does not publish, execute or verify its factual accuracy.', inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: {} } } },
];
const instanceSchema = { type: 'object', additionalProperties: false, required: ['runId'], properties: { runId: { type: 'string', description: 'Exact instance runId returned by a background sub-Agent launch.' } } };
const SUB_AGENT_TOOLS: GatewayToolDefinition[] = [
  ...(['pause', 'resume', 'wait'] as const).map((action) => ({ name: `${action}_sub_agent`, description: action === 'pause' ? 'Pause one directly owned engine sub-Agent instance after its session is saved. Other instances continue. Existing file changes remain.' : action === 'resume' ? 'Resume a paused instance using its saved engine session and original runId. Inspect interrupted external effects before retrying.' : 'Wait for one directly owned instance and receive its result. Paused instances wait until resumed.', inputSchema: instanceSchema })),
  { name: 'use_sub_agent_tool', description: 'Take over a directly assigned specialist’s tools yourself without launching its model. Omit toolName to inspect its assigned Skills, executable scripts and tool schemas; then supply an exact toolName and arguments. This does not grant unassigned tools or change saved templates.', inputSchema: { type: 'object', additionalProperties: false, required: ['agentId'], properties: { agentId: { type: 'string' }, toolName: { type: 'string' }, input: {}, skillId: { type: 'string' }, scriptPath: { type: 'string' }, arguments: { type: 'array', items: { type: 'string' } } } } },
  { name: 'run_sub_agent', description: 'Ask one assigned sub-Agent to perform a task with explicit context. Choose the specialist and next task from current evidence. For questions about previous work, answer from existing results first; if needed, pass its runId to ask the original specialist using saved context.', inputSchema: subInvocationSchema },
  { name: 'run_sub_agents', description: 'Run independent assigned sub-Agent tasks concurrently and receive each result. Use a separate call when a task depends on an earlier result.', inputSchema: { type: 'object', additionalProperties: false, required: ['tasks'], properties: { tasks: { type: 'array', minItems: 1, maxItems: 4, items: subInvocationSchema } } } },
];
const CAPABILITY_TOOL: GatewayToolDefinition = { name: 'use_capability', description: 'Call one configured capability with its declared input ports. A WeChat publish capability also accepts independent article operations in input: {operation:"list"}; {operation:"inspect"|"verify",runId,draftId}; {operation:"render_image",runId,draftId,key,html,width?,height?}; {operation:"revise",runId,draftId,requestKey,title?,imageReplacements?:{imageKey:artifactId}}; {operation:"publish",mode:"draft"|"publish",runId?,draftId?,article?,metadata?,images?,coverImage?,imageReplacements?}. List identifies saved articles; inspect reads their text and images; publish can reuse a recorded article and replace selected images. Only call the operations needed for the user task. Supply {$result: resultRef, path?: "$.field"} anywhere in input to pass a previous result without copying large images or text. To resume a user action, supply resumeCallId from the prior result with the same capabilityId; do not create a fresh publication.', inputSchema: { type: 'object', additionalProperties: false, required: ['capabilityId'], properties: { capabilityId: { type: 'string' }, input: {}, resumeCallId: { type: 'string' } } } };

type InvocationState = { messages?: GatewayAgentMessage[]; resumeId?: string };

type AgentSnapshot = { agent: typeof agents.$inferSelect; skills: Array<{ id: string; name: string; instructions: string; files: Array<{ path: string; content: string }> }>; serverIds: string[] };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function required(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${name} is required.`); return value; }

@Injectable()
export class AgentCollaborationService {
  private readonly instances = new Map<string, SubAgentInstance>();

  async controlInstance(workspaceId: string, executionId: string, runId: string, action: 'pause' | 'resume', parentRunId?: string) {
    const instance = this.instance(workspaceId, executionId, runId, parentRunId);
    if (action === 'pause') await instance.pause();
    else instance.resume();
    return { runId, agentId: instance.agentId, status: instance.status };
  }

  private instance(workspaceId: string, executionId: string, runId: string, parentRunId?: string) {
    const instance = this.instances.get(runId);
    if (!instance || instance.workspaceId !== workspaceId || instance.executionId !== executionId || (parentRunId !== undefined && instance.parentRunId !== parentRunId)) throw new NotFoundException('Active sub-Agent instance not found.');
    return instance;
  }

  private readonly activeCapabilities = new Set<string>();
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly resources: WorkspaceResourcesService, private readonly invocations: IsolatedAgentInvocationService, private readonly capabilities: AgentCapabilitiesService, private readonly executors?: ProjectExecutorService, private readonly builtinTools?: BuiltinAgentToolsService) {}

  list(workspaceId: string) {
    const catalog = agentFiles(this.db);
    catalog?.refresh(workspaceId);
    const rows = this.db.select().from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.kind, 'custom'))).all();
    const privateIds = new Set(rows.flatMap((agent) => agent.collaboration?.subAgentIds ?? []));
    return rows.filter((agent) => catalog ? catalog.get(agent.id)?.parentId === null : !privateIds.has(agent.id)).map((agent) => ({ id: agent.id, name: agent.name, responsibility: agent.responsibility }));
  }

  async run(workspaceId: string, executionId: string, agentId: string, task: unknown, signal: AbortSignal, onTextDelta?: (delta: string) => void | Promise<void>, projectDirectory?: string, rootToolCallId?: string, preferredRootRunId?: string): Promise<string> {
    const owner = this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspaceId))).get();
    if (!owner) throw new NotFoundException('Agent execution not found.');
    const cleaned = normalizeAgentModelMessages(owner.modelMessages);
    if (JSON.stringify(cleaned) !== JSON.stringify(owner.modelMessages)) {
      signal.throwIfAborted();
      const resultRef = `acr_${randomUUID()}`;
      const messages = [{ role: 'user' as const, content: `Original history before recovery repair: resultRef ${resultRef}. Use read_result only when needed.` }, ...cleaned];
      this.db.transaction((tx) => {
        tx.insert(agentCapabilityResults).values({ id: resultRef, executionId, value: { kind: 'conversation-history', messages: owner.modelMessages } }).run();
        tx.update(agentExecutions).set({ modelMessages: messages }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
      });
      owner.modelMessages = messages;
    }
    const catalog = agentFiles(this.db);
    catalog?.refresh(workspaceId);
    // Freeze the complete reachable directory before invoking any model or tool.
    const directory = new Map<string, AgentSnapshot>();
    const capture = (id: string, ancestors: string[]) => {
      if (ancestors.includes(id)) throw new BadRequestException('Sub-Agent assignments contain a cycle.');
      if (directory.has(id)) return;
      const agent = this.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId), eq(agents.kind, 'custom'))).get();
      if (!agent || (catalog && !catalog.get(id))) throw new BadRequestException('The selected Agent must be available in this workspace.');
      if (agent.runtime.kind !== 'native' && ((agent.collaboration?.subAgentIds.length ?? 0) > 0 || (agent.collaboration?.capabilities.length ?? 0) > 0 || (agent.collaboration?.privateTools?.length ?? 0) > 0)) throw new BadRequestException('Use a native lead Agent to coordinate engine-backed sub-Agents.');
      const assigned = this.db.select({ id: skills.id, name: skills.name, instructions: skills.instructions, validation: skills.validation }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(and(eq(agentSkills.agentId, id), eq(skills.workspaceId, workspaceId))).all();
      if (!catalog && assigned.some((skill) => skill.validation !== 'valid')) throw new BadRequestException('An assigned Skill is invalid.');
      const fileEntry = catalog?.get(id);
      directory.set(id, fileEntry ? { agent, skills: fileEntry.skills, serverIds: fileEntry.serverIds } : { agent, skills: assigned.map((skill) => ({ ...skill, files: this.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, skill.id)).all() })), serverIds: this.db.select({ id: agentMcpServers.mcpServerId }).from(agentMcpServers).where(eq(agentMcpServers.agentId, id)).all().map((row) => row.id) });
      for (const child of agent.collaboration?.subAgentIds ?? []) capture(child, [...ancestors, id]);
    };
    this.db.transaction(() => {
      capture(agentId, []);
      if (!this.list(workspaceId).some((agent) => agent.id === agentId)) throw new BadRequestException('Select a top-level Agent. Sub-Agents are private to their owning Agent.');
    });
    let remainingCalls = 128;
    const finishReserve = 16;
    const resolve = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolve);
      if (!value || typeof value !== 'object') return value;
      const input = object(value);
      if (typeof input.$result === 'string') {
        const row = this.db.select().from(agentCapabilityResults).where(and(eq(agentCapabilityResults.id, input.$result), eq(agentCapabilityResults.executionId, executionId))).get();
        if (!row) throw new BadRequestException('Result reference is unavailable in this execution.');
        if (input.path === undefined) return row.value;
        const found = readWorkflowOutputPath(row.value, required(input.path, 'path'));
        if (!found.exists) throw new BadRequestException('The result path does not exist.');
        return found.value;
      }
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, resolve(item)]));
    };
    // Audit records retain the actual invocation tree independently of later Agent edits.
    const invoke = async (id: string, context: unknown, ancestors: string[], parentRunId: string | null = null, overrides: DelegationOverrides = {}, invocationSignal: AbortSignal = signal, instanceRunId?: string, continuationRunId?: string): Promise<unknown> => {
      const lastUser = [...owner.displayMessages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const mention = /\[@[^\]\n]+\]\(\/agents\/([^?/)]+)\?runId=(air_[A-Za-z0-9-]+)\)/.exec(lastUser);
      const requestedRunId = parentRunId === null ? preferredRootRunId ?? (mention && decodeURIComponent(mention[1]!) === id ? mention[2] : undefined) : undefined;
      const previousId = continuationRunId ?? (parentRunId === null ? preferredRootRunId : undefined);
      const previous = previousId ? this.db.select().from(auditLogs).where(and(eq(auditLogs.id, previousId), eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.resource, executionId), eq(auditLogs.action, 'agent.invocation'))).get() : undefined;
      const savedRun = previous?.metadata as AgentRunView | undefined;
      if (continuationRunId && !savedRun) throw new BadRequestException('The original sub-Agent invocation is unavailable.');
      if (savedRun && (savedRun.agentId !== id || savedRun.parentRunId !== parentRunId)) throw new BadRequestException('Only the owning Agent can continue this exact invocation.');
      if (continuationRunId && !['completed', 'failed', 'cancelled'].includes(savedRun!.status)) throw new BadRequestException('The sub-Agent invocation must settle before a follow-up.');
      const runId = savedRun?.id ?? instanceRunId ?? (requestedRunId && !this.db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.id, requestedRunId)).get() ? requestedRunId : `air_${randomUUID()}`);
      const stateId = `${runId}:state`;
      const savedState = this.db.select().from(auditLogs).where(and(eq(auditLogs.id, stateId), eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.resource, executionId), eq(auditLogs.action, 'agent.invocation_state'))).get();
      const state = (savedState?.metadata ?? {}) as InvocationState;
      if (continuationRunId) {
        if (directory.get(id)!.agent.runtime.kind === 'native') {
          if (!state.messages?.length) throw new BadRequestException('The original model context was not saved; do not silently start replacement research.');
          state.messages = [...state.messages, { role: 'user', content: JSON.stringify(resolve(context)) }];
        } else if (!state.resumeId) throw new BadRequestException('The original engine session was not saved; do not silently start replacement research.');
      }
      const saveState = () => this.db.insert(auditLogs).values({ id: stateId, workspaceId, action: 'agent.invocation_state', resource: executionId, metadata: state }).onConflictDoUpdate({ target: auditLogs.id, set: { metadata: state } }).run();
      const run: AgentRunView = { id: runId, executionId, agentId: id, agentName: directory.get(id)?.agent.name ?? id, parentRunId,
        runtime: savedRun?.runtime ?? directory.get(id)!.agent.runtime.kind,
        ...(savedRun?.commandExecutionId ? { commandExecutionId: savedRun.commandExecutionId } : {}),
        task: savedRun?.task ?? invocationTask(context), currentActivity: { phase: 'model' }, status: 'running', usage: savedRun?.usage ?? null, output: '', error: null, createdAt: savedRun?.createdAt ?? new Date().toISOString(), finishedAt: null };
      if (parentRunId === null && rootToolCallId) {
        const call = this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, rootToolCallId), eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.workspaceId, workspaceId))).get();
        if (call) this.db.update(agentToolCalls).set({ input: { ...object(call.input), __agentInvocationId: runId } }).where(eq(agentToolCalls.id, call.id)).run();
      }
      const persist = () => this.db.update(auditLogs).set({ metadata: { ...run, overrides } }).where(eq(auditLogs.id, runId)).run();
      if (previous) persist();
      else this.db.insert(auditLogs).values({ id: runId, workspaceId, action: 'agent.invocation', resource: executionId, metadata: { ...run, overrides } }).run();
      try {
        const execute = (attemptSignal: AbortSignal) => perform(id, context, ancestors, runId, overrides, (usage, cumulative = false, commandExecutionId) => {
          if (!usage) {
            if (commandExecutionId && run.commandExecutionId !== commandExecutionId) { run.commandExecutionId = commandExecutionId; persist(); }
            return;
          }
          if (commandExecutionId) run.commandExecutionId = commandExecutionId;
          run.usage = cumulative || !run.usage ? {
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
            ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
          } : {
            inputTokens: sumUsage(run.usage.inputTokens, usage.inputTokens),
            outputTokens: sumUsage(run.usage.outputTokens, usage.outputTokens),
            totalTokens: sumUsage(run.usage.totalTokens, usage.totalTokens),
            ...(run.usage.cacheReadTokens !== undefined || usage.cacheReadTokens !== undefined ? { cacheReadTokens: sumUsage(run.usage.cacheReadTokens ?? null, usage.cacheReadTokens ?? null) } : {}),
            ...(run.usage.cacheCreationTokens !== undefined || usage.cacheCreationTokens !== undefined ? { cacheCreationTokens: sumUsage(run.usage.cacheCreationTokens ?? null, usage.cacheCreationTokens ?? null) } : {}),
          };
          persist();
        }, attemptSignal, state, saveState, (activity, output) => {
          run.currentActivity = activity;
          if (output !== undefined) run.output = output;
          persist();
        });
        let result: unknown;
        if (parentRunId && directory.get(id)!.agent.runtime.kind !== 'native') {
          // Defer execution until the instance has been registered for session callbacks.
          const instance = new SubAgentInstance(workspaceId, executionId, parentRunId, id, runId, invocationSignal, async (attemptSignal) => { await Promise.resolve(); return execute(attemptSignal); }, (status) => { run.status = status; run.currentActivity = status === 'paused' ? null : { phase: 'model' }; persist(); });
          this.instances.set(runId, instance);
          result = await instance.done;
        } else result = await execute(invocationSignal);
        if (parentRunId) {
          const content = typeof result === 'string' ? result : JSON.stringify(result);
          const artifactId = `art_${randomUUID()}`;
          const article = object(result).article;
          const body = typeof article === 'string' ? article : content;
          this.db.transaction((tx) => {
            tx.insert(artifacts).values({ id: artifactId, workspaceId, name: run.agentName, format: typeof article === 'string' ? 'markdown' : typeof result === 'string' ? 'text' : 'json', content: body, size: `${Buffer.byteLength(body, 'utf8')} B` }).run();
            tx.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'agent.artifact', resource: executionId, metadata: { invocationId: runId, artifactId } }).run();
          });
        }
        if (!parentRunId) await Promise.allSettled([...this.instances.values()].filter((instance) => instance.executionId === executionId && instance.workspaceId === workspaceId).map((instance) => instance.done));
        run.status = 'completed';
        run.output = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
        return result;
      } catch (error) {
        run.status = signal.aborted ? 'cancelled' : 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        if (error instanceof DelegationFailure) run.output = error.details.rawOutput;
        throw error;
      } finally { run.currentActivity = null; run.finishedAt = new Date().toISOString(); persist(); }
    };
    const perform = async (id: string, context: unknown, ancestors: string[], runId: string, overrides: DelegationOverrides, onUsage: (usage: AgentRunView['usage'], cumulative?: boolean, commandExecutionId?: string) => void, parentSignal: AbortSignal, state: InvocationState, saveState: () => unknown, report: (activity: AgentRunView['currentActivity'], output?: string) => void): Promise<unknown> => {
      const signal = overrides.timeoutMs ? AbortSignal.any([parentSignal, AbortSignal.timeout(overrides.timeoutMs)]) : parentSignal;
      signal.throwIfAborted();
      if (remainingCalls <= (ancestors.length ? finishReserve : 0) || ancestors.length >= 8 || ancestors.includes(id)) throw new BadRequestException('Agent collaboration limit reached.');
      remainingCalls -= 1;
      const snapshot = directory.get(id);
      if (!snapshot) throw new BadRequestException('This sub-Agent was not assigned to the task.');
      const { agent } = snapshot;
      const selectAssigned = <T,>(selection: readonly T[] | undefined, assigned: readonly T[]): T[] => {
        if (selection?.some((value) => !assigned.includes(value))) throw new BadRequestException('Invocation overrides may only select assigned tools and Skills.');
        return [...(selection ?? assigned)];
      };
      const selectedSkills = selectAssigned(overrides.skillIds, snapshot.skills.map((skill) => skill.id));
      const invocationSkills = snapshot.skills.filter((skill) => selectedSkills.includes(skill.id));
      const serverIds = selectAssigned(overrides.mcpServerIds, snapshot.serverIds);
      const builtinToolNames = selectAssigned(overrides.builtinToolNames, agent.collaboration?.builtinToolNames ?? []);
      const requiredSkillIds = overrides.requiredSkillIds === undefined ? agent.collaboration?.requiredSkillIds ?? [] : selectAssigned(overrides.requiredSkillIds, selectedSkills);
      const config = { ...agent.collaboration, ...(overrides.outputFormat !== undefined ? { outputFormat: overrides.outputFormat } : {}), ...(overrides.outputContract !== undefined ? { outputContract: overrides.outputContract } : {}), ...(overrides.allowEmptyOutputKeys !== undefined ? { allowEmptyOutputKeys: overrides.allowEmptyOutputKeys } : {}), limits: { ...agent.collaboration?.limits, ...overrides.limits } };
      const instructions = overrides.instructions ?? agent.systemPrompt;
      if (config.outputFormat === 'text') { config.outputContract = []; config.allowEmptyOutputKeys = []; }
      let models = config?.publicModels ?? [];
      if (agent.providerId) {
        const runtime = await this.resources.providerRuntime({} as Request, 'personal', agent.providerId, agent.model);
        models = [`${runtime.provider.gatewayProviderName}/${runtime.model}`];
      }
      if (overrides.model) {
        if (!models.includes(overrides.model)) throw new BadRequestException('The requested model is not assigned to this specialist.');
        models = [overrides.model];
      }
      const requestedDirectory = projectDirectory || owner.projectDirectory || (agent.runtime.kind !== 'native' ? agent.runtime.projectDirectory : undefined);
      let workingDirectory: string | undefined;
      if (requestedDirectory) {
        if (!isAbsolute(requestedDirectory)) throw new BadRequestException('An absolute projectDirectory is required.');
        workingDirectory = await realpath(requestedDirectory).catch(() => undefined);
        if (!workingDirectory || !(await stat(workingDirectory)).isDirectory()) throw new BadRequestException('projectDirectory must be an existing directory.');
      }
      const validateOutput = (text: string): unknown => {
        try {
          if (config.outputFormat !== 'json') return text;
          const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n|\n?```$/g, ''));
          assertWorkflowAgentOutputContract(value, config.outputContract, config.allowEmptyOutputKeys);
          return value;
        } catch (error) {
          let partialResult: unknown;
          try { partialResult = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n|\n?```$/g, '')); } catch { /* Preserve unparseable text below. */ }
          throw new DelegationFailure({ kind: 'output_contract', rawOutput: text, partialResult, skillCalls: [], toolCalls: [] }, error);
        }
      };
      if (agent.runtime.kind !== 'native') {
        if (!workingDirectory) throw new BadRequestException(`An existing projectDirectory is required for Agent ${agent.name}.`);
        if (!this.executors) throw new BadRequestException('The execution engine is unavailable.');
        const model = models[0] || agent.model || null;
        const launch = await this.executors.captureLaunch(agent.runtime.kind, model);
        const instance = this.instances.get(runId);
        const result = await this.executors.execute({ owner: 'agent', workspaceId, model, launch,
          runtimeSession: { resumeId: instance?.resumeId ?? state.resumeId, onSession: async (sessionId: string) => { state.resumeId = sessionId; saveState(); if (instance) instance.resumeId = sessionId; } }, projectDirectory: workingDirectory, systemPrompt: [instructions, TASK_OWNERSHIP_PROMPT, `Effective output requirements: ${JSON.stringify({ outputFormat: config.outputFormat ?? 'text', outputContract: config.outputContract ?? [] })}`].join('\n\n'), input: instance?.resumeId ? 'Continue the interrupted task from the saved session. Inspect the current files and tool evidence before retrying any interrupted action; do not repeat uncertain external effects.' : JSON.stringify(resolve(context)), skills: invocationSkills, mcpServers: await this.resources.workflowMcpRuntimes(workspaceId, serverIds), signal, correlation: { surface: 'agent', agentRunId: runId, agentExecutionId: executionId }, approvalPolicy: agent.runtime.approvalPolicy ?? 'auto', onTextDelta: ancestors.length === 0 ? onTextDelta : undefined,
          // Bind the command as soon as Codex starts, including failures before any
          // usage arrives. Later cumulative snapshots replace this invocation's usage.
          onEvent: (event) => { if (event.usage || event.commandExecutionId) onUsage(event.usage ?? null, true, event.commandExecutionId); } });
        signal.throwIfAborted();
        return validateOutput(result);
      }
      if (builtinToolNames.length > 0 && !workingDirectory) throw new BadRequestException(`An existing projectDirectory is required for Agent ${agent.name}.`);
      if (!models.length) throw new BadRequestException(`Configure a model for Agent ${agent.name}.`);
      const children = config?.subAgentIds ?? [];
      const capabilityList = config?.capabilities ?? [];
      const skillCalls: SkillScriptCallRecord[] = [];
      const requiredSkills = catalog ? requiredSkillIds : await this.resources.resolveSkillIds(workspaceId, requiredSkillIds);
      const privateTools = config?.privateTools ?? [];
      const tools = [...RESULT_TOOLS, ...privateTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), ...(children.length ? SUB_AGENT_TOOLS : []), ...(capabilityList.length ? [CAPABILITY_TOOL] : [])];
      if (requiredSkills.some((skillId) => !invocationSkills.some((skill) => skill.id === skillId))) throw new BadRequestException('A required Skill is not assigned to this Agent.');
      let text: string;
      let rawOutput = '';
      let checkpoint: GatewayAgentMessage[] = [];
      const toolActivities: unknown[] = [];
      const evidence = () => [...toolActivities, ... this.db.select().from(agentToolCalls).where(eq(agentToolCalls.executionId, executionId)).all().filter((call) => object(call.input).__agentRunId === runId).map((call) => ({ callId: call.id, toolName: call.mcpToolName, status: call.status, output: call.output, commandExecutionId: call.commandExecutionId }))];
      let lastOutputAt = 0;
      const thinking = () => report({ phase: 'model' });
      try { text = await this.invocations.execute({
        onContextCheckpoint: async (checkpoint) => {
          signal.throwIfAborted();
          const resultRef = `acr_${randomUUID()}`;
          this.db.insert(agentCapabilityResults).values({ id: resultRef, executionId, value: { kind: 'task-checkpoint', runId, ...checkpoint } }).run();
          return resultRef;
        },
        initialMessages: ancestors.length === 0 && owner.agentId === id && owner.modelMessages.length ? owner.modelMessages as GatewayAgentMessage[] : state.messages,
        onMessages: (messages) => {
          signal.throwIfAborted();
          checkpoint = messages;
          state.messages = messages;
          saveState();
          if (ancestors.length === 0 && owner.agentId === id) this.db.update(agentExecutions).set({ modelMessages: messages as typeof owner.modelMessages, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
        },
        beforeToolCall: (call) => {
          if (remainingCalls <= (ancestors.length ? finishReserve : 0)) return 'Shared task budget reserve reached. Do not start more work. Return existing results and missing evidence to the lead, who can take over and finish delivery.';
          remainingCalls -= 1;
          report({ phase: 'tool', toolName: call.toolName });
          return undefined;
        },
        workspaceId, publicModelId: models, context: workingDirectory ? { task: resolve(context), projectDirectory: workingDirectory } : resolve(context), skills: invocationSkills,
        mcpRuntimes: await this.resources.workflowMcpRuntimes(workspaceId, serverIds), builtinToolNames, projectDirectory: workingDirectory, signal,
        systemPrompt: [instructions, TASK_OWNERSHIP_PROMPT, `Effective output requirements: ${JSON.stringify({ outputFormat: config.outputFormat ?? 'text', outputContract: config.outputContract ?? [], allowEmptyOutputKeys: config.allowEmptyOutputKeys ?? [], requiredSkillIds: requiredSkills })}. These are the authoritative requirements for this invocation.`, privateTools.length ? 'Private tools belong only to this Agent. Capability tools accept {input: <capability arguments>, resumeCallId?: <previous callId>}; command tools receive their arguments as base64 JSON in WORKLITE_TOOL_INPUT_BASE64. Use actual tool results as evidence.' : '', children.length ? `Assigned sub-Agents: ${JSON.stringify(children.map((child) => ({ id: child, name: directory.get(child)!.agent.name, responsibility: directory.get(child)!.agent.responsibility, instructions: directory.get(child)!.agent.systemPrompt, outputFormat: directory.get(child)!.agent.collaboration?.outputFormat ?? 'text', outputContract: directory.get(child)!.agent.collaboration?.outputContract ?? [], allowEmptyOutputKeys: directory.get(child)!.agent.collaboration?.allowEmptyOutputKeys ?? [], requiredSkillIds: directory.get(child)!.agent.collaboration?.requiredSkillIds ?? [], models: directory.get(child)!.agent.collaboration?.publicModels ?? [], limits: directory.get(child)!.agent.collaboration?.limits, skills: directory.get(child)!.skills.map((skill) => ({ id: skill.id, name: skill.name })), mcpServerIds: directory.get(child)!.serverIds, builtinToolNames: directory.get(child)!.agent.collaboration?.builtinToolNames ?? [] })))}` : '', capabilityList.length ? `Available capabilities (input ports describe the tool input; saved config is applied automatically; WeChat publishing capabilities also accept input.operation list, inspect, render_image, revise, verify or publish with runId/draftId and operation-specific fields, independently of any pipeline): ${JSON.stringify(capabilityList.map((item) => ({ ...item, inputPorts: resolveWorkflowNodeCapability(item.type, item.typeVersion)?.inputs })))}` : '', 'Select each next action from actual results. A waiting_for_input result is not success: tell the user what is required, keep its callId, and resume that exact operation after the user completes it. Do not repeat a failed or uncertain publication automatically.'].filter(Boolean).join('\n\n'),
        managedTools: tools, jsonOutput: config?.outputFormat === 'json', limits: { maxToolRounds: ancestors.length ? 20 : 40, maxToolCalls: ancestors.length ? 32 : 64, ...config.limits, budgetReminderAtRound: Math.max(1, Math.floor((config.limits.maxToolRounds ?? (ancestors.length ? 20 : 40)) * 0.7)) }, correlation: { surface: 'agent', agentRunId: runId, agentExecutionId: executionId },
        onTextDelta: async (delta) => {
          rawOutput += delta;
          if (Date.now() - lastOutputAt >= 1000) { report({ phase: 'model' }, rawOutput); lastOutputAt = Date.now(); }
          if (ancestors.length === 0) await onTextDelta?.(delta);
        },
        onModelRound: (round) => { thinking(); if (round.usage) onUsage(round.usage); },
        onSkillScript: (call) => { skillCalls.push(call); thinking(); },
        onMcpCall: (activity) => { toolActivities.push(activity); thinking(); },
        onBuiltinTool: (activity) => { toolActivities.push(activity); thinking(); },
        executeManagedTool: async (call) => {
          signal.throwIfAborted();
          report({ phase: 'tool', toolName: call.toolName });
          const privateTool = privateTools.find((item) => item.name === call.toolName);
          const privateHandler = privateTool?.handler;
          const originalInput = object(call.input);
          const input = privateHandler?.kind === 'capability'
            ? { capabilityId: privateHandler.capabilityId, input: originalInput.input, resumeCallId: originalInput.resumeCallId }
            : originalInput;
          const callId = `atc_${randomUUID()}`;
          this.db.insert(agentToolCalls).values({ id: callId, executionId, workspaceId, agentId: owner.agentId, toolCallId: callId, toolName: 'builtin', mcpToolName: call.toolName, input: { ...input, __agentRunId: runId, __toolAgentId: id }, workingDirectory: '', status: 'running', resultAppended: true }).run();
          try {
            let output: unknown;
            if (call.toolName === 'read_result') {
              output = resolve({ $result: required(input.resultRef, 'resultRef'), ...(input.path !== undefined ? { path: input.path } : {}) });
              if (input.offset !== undefined || input.maxChars !== undefined) {
                const offset = input.offset ?? 0;
                const maxChars = input.maxChars ?? 12000;
                if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 12000) throw new BadRequestException('Invalid result page.');
                const text = typeof output === 'string' ? output : JSON.stringify(output);
                output = { text: text.slice(offset, offset + maxChars), totalChars: text.length, nextOffset: offset + maxChars < text.length ? offset + maxChars : null };
              }
            } else if (call.toolName === 'store_result') {
              if (!Object.hasOwn(input, 'value')) throw new BadRequestException('value is required.');
              output = resolve(input.value);
            } else if (call.toolName === 'use_sub_agent_tool') {
              const childId = required(input.agentId, 'agentId');
              if (!children.includes(childId)) throw new BadRequestException('This sub-Agent is not assigned to its parent.');
              const child = directory.get(childId)!;
              const childDirectory = workingDirectory ?? (child.agent.runtime.kind !== 'native' ? child.agent.runtime.projectDirectory : undefined);
              const childTools = child.agent.collaboration?.builtinToolNames ?? [];
              if (childTools.length && !childDirectory) throw new BadRequestException('An existing projectDirectory is required for specialist built-in tools.');
              if (input.arguments !== undefined && (!Array.isArray(input.arguments) || !input.arguments.every((value) => typeof value === 'string'))) throw new BadRequestException('arguments must be a string array.');
              output = await this.invocations.executeAssignedTool({
                workspaceId, publicModelId: [], systemPrompt: '', context: null, skills: child.skills,
                mcpRuntimes: await this.resources.workflowMcpRuntimes(workspaceId, child.serverIds),
                builtinToolNames: childTools, projectDirectory: childDirectory, signal,
                onSkillScript: (activity) => {
                  skillCalls.push(activity);
                  this.db.update(agentToolCalls).set({ commandExecutionId: activity.commandExecutionId, exitCode: activity.exitCode }).where(eq(agentToolCalls.id, callId)).run();
                },
                onBuiltinTool: (activity) => { this.db.update(agentToolCalls).set({ commandExecutionId: activity.commandExecutionId, exitCode: activity.exitCode }).where(eq(agentToolCalls.id, callId)).run(); },
              }, input.toolName === undefined ? undefined : { toolCallId: callId, toolName: required(input.toolName, 'toolName'), input: resolve(input.input), skillId: input.skillId as string | undefined, scriptPath: input.scriptPath as string | undefined, arguments: input.arguments as string[] | undefined });
            } else if (privateHandler?.kind === 'command') {
              if (!this.builtinTools) throw new BadRequestException('Private command tools are unavailable.');
              const command = await this.builtinTools.start('bash', { command: privateToolCommand(privateHandler.command, resolve(input)) }, { cwd: privateHandler.workingDirectory });
              this.db.update(agentToolCalls).set({ commandExecutionId: command.id, workingDirectory: privateHandler.workingDirectory }).where(eq(agentToolCalls.id, callId)).run();
              const cancel = () => { void this.builtinTools!.cancel(command.id).catch(() => {}); };
              signal.addEventListener('abort', cancel, { once: true });
              try {
                if (signal.aborted) cancel();
                const completed = await this.builtinTools.wait(command.id);
                signal.throwIfAborted();
                this.db.update(agentToolCalls).set({ exitCode: completed.execution.exitCode }).where(eq(agentToolCalls.id, callId)).run();
                if (completed.execution.exitCode !== 0) throw new Error(`Private tool exited with code ${completed.execution.exitCode}: ${completed.output}`);
                output = completed.output;
              } finally { signal.removeEventListener('abort', cancel); }
            } else if (call.toolName === 'pause_sub_agent' || call.toolName === 'resume_sub_agent') {
              output = await this.controlInstance(workspaceId, executionId, required(input.runId, 'runId'), call.toolName === 'pause_sub_agent' ? 'pause' : 'resume', runId);
            } else if (call.toolName === 'wait_sub_agent') {
              const instance = this.instance(workspaceId, executionId, required(input.runId, 'runId'), runId);
              output = { runId: instance.runId, agentId: instance.agentId, status: 'completed', result: await instance.done };
            } else if (call.toolName === 'run_sub_agent' || call.toolName === 'run_sub_agents') {
              const tasks = call.toolName === 'run_sub_agent' ? [input] : input.tasks;
              if (!Array.isArray(tasks) || !tasks.length || tasks.length > 4) throw new BadRequestException('Provide one to four sub-Agent tasks.');
              const values = await Promise.all(tasks.map(async (item: unknown) => {
                const request = object(item);
                const child = typeof request.agentId === 'string' ? request.agentId : '';
                try {
                  required(child, 'agentId');
                  if (!children.includes(child)) throw new BadRequestException('This sub-Agent is not assigned to its parent.');
                  if (request.background !== undefined && typeof request.background !== 'boolean') throw new BadRequestException('background must be a boolean.');
                  const followUpRunId = request.runId === undefined ? undefined : required(request.runId, 'runId');
                  const childRunId = followUpRunId ?? `air_${randomUUID()}`;
                  const previousInstance = this.instances.get(childRunId);
                  const work = invoke(child, request.task, [...ancestors, id], runId, delegationOverrides(request.overrides), signal, childRunId, followUpRunId);
                  if (request.background === true) {
                    // Controllable background instances require a resumable execution engine.
                    void work.catch(() => {});
                    if (directory.get(child)!.agent.runtime.kind === 'native') return { agentId: child, runId: childRunId, status: 'completed', result: await work };
                    if (this.instances.get(childRunId) === previousInstance) await work;
                    return { agentId: child, runId: childRunId, status: 'running', background: true };
                  }
                  return { agentId: child, runId: childRunId, status: 'completed', result: await work }; }
                catch (error) { if (signal.aborted) throw error; return { agentId: child, status: 'failed', error: error instanceof Error ? error.message : 'Sub-Agent failed.', ...(error instanceof DelegationFailure ? error.details : { kind: 'execution' }), recovery: 'Reuse available output and evidence; repair, adjust this invocation or take over. Do not repeat uncertain external operations.' };  }
              }));
              output = call.toolName === 'run_sub_agent' ? values[0] : values;
            } else if (call.toolName === 'use_capability' || privateHandler?.kind === 'capability') {
              const capability = capabilityList.find((item) => item.id === input.capabilityId);
              if (!capability) throw new BadRequestException('This capability is not assigned to the Agent.');
              let operationId = callId;
              let args = resolve(input.input);
              if (input.resumeCallId !== undefined) {
                const previous = this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, required(input.resumeCallId, 'resumeCallId')), eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.mcpToolName, call.toolName), eq(agentToolCalls.status, 'completed'))).get();
                if (!previous || object(previous.input).capabilityId !== capability.id || (privateTool && object(previous.input).__toolAgentId !== id)) throw new BadRequestException('The capability operation cannot be resumed.');
                const action = this.db.select().from(agentPendingActions).where(and(eq(agentPendingActions.runId, executionId), eq(agentPendingActions.nodeRunId, previous.id))).get();
                if (!action || action.status === 'cancelled') throw new BadRequestException('This capability has no resumable user action.');
                operationId = previous.id;
                args = resolve(object(previous.input).input);
              }
              const operationKey = `${executionId}:${operationId}`;
              if (this.activeCapabilities.has(operationKey)) throw new BadRequestException('This capability operation is already running.');
              this.activeCapabilities.add(operationKey);
              try { output = await this.capabilities.execute(workspaceId, executionId, operationId, capability, args, signal); }
              finally { this.activeCapabilities.delete(operationKey); }
              if (object(output).status === 'waiting_for_input') {
                const action = object(object(output).pendingAction);
                this.db.insert(agentPendingActions).values({ id: String(action.id), workspaceId, runId: executionId, nodeRunId: operationId, type: action.type as 'wechat_login' | 'wechat_publish_confirmation', title: String(action.title), description: String(action.description), qrCode: action.qrCode as string | null, expiresAt: action.expiresAt as Date | null, externalOperationId: action.externalOperationId as string | undefined }).onConflictDoUpdate({ target: agentPendingActions.id, set: { status: 'pending', updatedAt: new Date() } }).run();
                // QR display is user initiated; the normal tool result contains no QR image.
                output = { status: 'waiting_for_input', callId: operationId, actionId: action.id, title: action.title, description: action.description };
              }
            } else throw new BadRequestException('Unavailable Agent tool.');
            signal.throwIfAborted();
            const resultRef = `acr_${randomUUID()}`;
            const safe = JSON.stringify({ ...(object(output).status === 'failed' ? { status: 'failed' } : {}), callId, resultRef, result: preview(output), budget: { remainingCalls, finishReserve, delegationAvailable: remainingCalls > finishReserve } });
            this.db.transaction((tx) => {
              tx.insert(agentCapabilityResults).values({ id: resultRef, executionId, value: output ?? null }).run();
              tx.update(agentToolCalls).set({ status: 'completed', output: safe, finishedAt: new Date() }).where(eq(agentToolCalls.id, callId)).run();
            });
            return safe;
          } catch (error) {
            this.db.update(agentToolCalls).set({ status: signal.aborted ? 'cancelled' : 'failed', output: error instanceof Error ? error.message : 'Agent tool failed.', finishedAt: new Date() }).where(eq(agentToolCalls.id, callId)).run();
            if (signal.aborted) throw error;
            return JSON.stringify({ status: 'failed', callId, error: error instanceof Error ? error.message : 'Agent tool failed.' });
          } finally { thinking(); }
        },
      }); } catch (error) {
        if (parentSignal.aborted) throw error;
        const output = typeof object(error).output === 'string' ? object(error).output as string : rawOutput;
        throw new DelegationFailure({ kind: 'execution', rawOutput: output, partialResult: { messages: checkpoint }, skillCalls, toolCalls: evidence() }, workflowAgentFailure(error));
      }
      signal.throwIfAborted();
      try {
        assertRequiredSkillScriptCalls(requiredSkills, skillCalls);
        return validateOutput(text);
      } catch (error) {
        if (error instanceof DelegationFailure) throw new DelegationFailure({ ...error.details, skillCalls, toolCalls: evidence() }, error);
        throw new DelegationFailure({ kind: 'execution', rawOutput: text, skillCalls, toolCalls: evidence() }, error);
      }
    };
    const lifetime = new AbortController();
    const executionSignal = AbortSignal.any([signal, lifetime.signal]);
    try {
      const result = await invoke(agentId, task, [], null, {}, executionSignal);
      // A launch receipt cannot finish a task while its background specialists are active.
      await Promise.allSettled([...this.instances.values()].filter((instance) => instance.executionId === executionId && instance.workspaceId === workspaceId).map((instance) => instance.done));
      return typeof result === 'string' ? result : JSON.stringify(result);
    } finally {
      lifetime.abort(new Error('Owning Agent execution ended.'));
      const owned = [...this.instances.values()].filter((instance) => instance.executionId === executionId && instance.workspaceId === workspaceId);
      await Promise.allSettled(owned.map((instance) => instance.done));
      for (const instance of owned) this.instances.delete(instance.runId);
    }
  }
}

function preview(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 12000) return `${value.slice(0, 12000)}… [Use read_result with path, offset and maxChars for the complete value.]`;
  if (Array.isArray(value)) return value.map(preview);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'b64Json' || key === 'qrCode' ? '[stored in resultRef]' : preview(item)]));
}

function sumUsage(a: number | null, b: number | null): number | null { return a === null || b === null ? null : a + b; }

function invocationTask(context: unknown): string {
  if (typeof context === 'string') return context;
  const value = object(context);
  if (Array.isArray(value.conversation)) {
    const message = [...value.conversation].reverse().find((item) => object(item).role === 'user');
    if (typeof object(message).content === 'string') return object(message).content as string;
  }
  return JSON.stringify(context) ?? '';
}
