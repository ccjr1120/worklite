import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AgentTeamOperationRecoveryDecision, AgentTeamRole } from '@worklite/contracts';
import {
  createModelGateway,
  type GatewayCorrelation,
  type GatewayToolResultOutput,
  type WorkflowAgentRound,
  type WorkflowAgentToolCall,
  type WorkflowAgentToolResult,
} from '@worklite/model-gateway';
import type { Database } from '@worklite/db';
import type { AgentMcpRuntime } from '../teams/team-resources.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { BuiltinAgentToolsService, selectBuiltinToolNames } from './builtin-agent-tools.service';
import type { CommandReservation } from '../commands/commands.service';
import { McpRuntimeService, type McpRuntimeTool } from './mcp-runtime.service';
import { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import { CODEX_CLI_PLUGIN_ID, PluginsService } from '../plugins/plugins.service';
import { CodexAppServerService, type CodexBackendActivity } from './codex-app-server.service';

type AgentInvocationSkill = {
  id: string;
  name: string;
  instructions?: string;
  files: Array<{ path: string; content: string }>;
};

type AgentInvocationSkillActivity = {
  skillId: string;
  skillName: string;
  scriptPath: string;
  arguments: string[];
  commandExecutionId: string;
  exitCode: number | null;
  status: 'succeeded' | 'failed';
};

type AgentInvocationMcpActivity = {
  serverId: string;
  toolName: string;
  input: unknown;
  result: string;
  status: 'succeeded' | 'failed';
};

type AgentInvocationBuiltinActivity = {
  toolName: string;
  input: unknown;
  commandExecutionId: string;
  exitCode: number | null;
  status: 'succeeded' | 'failed';
};

export type AgentInvocationOperationRecord = {
  key: string;
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
  status: 'reserved' | 'completed' | 'uncertain' | 'failed';
  commandId?: string;
  result?: unknown;
  failureReason?: string;
  recoveryDecision?: AgentTeamOperationRecoveryDecision;
};

export type AgentInvocationOperationJournal = {
  findOperation(operationKey: string): Promise<AgentInvocationOperationRecord | undefined>;
  findReplayOperation(taskKey: string, replayOperationKey: string): Promise<AgentInvocationOperationRecord | undefined>;
  reserveOperation(
    request: {
      taskKey: string;
      operationKey: string;
      toolName: string;
      inputFingerprint: string;
      pendingResult?: unknown;
    },
    commandId?: string,
    transaction?: Database,
  ): AgentInvocationOperationRecord;
  completeOperation(operationKey: string, result: unknown, commandId?: string): Promise<AgentInvocationOperationRecord>;
  markOperationUncertain(operationKey: string, reason: string): Promise<AgentInvocationOperationRecord>;
  failOperation(operationKey: string, reason: string): Promise<AgentInvocationOperationRecord>;
  attachReplayCommand(operationKey: string, commandId: string, transaction?: Database): AgentInvocationOperationRecord;
};

type IsolatedAgentInvocationRequest = {
  workspaceId: string;
  publicModelId: string;
  codexServerCommandArguments?: readonly string[];
  systemPrompt: string;
  context: unknown;
  skills: readonly AgentInvocationSkill[];
  mcpRuntimes: readonly AgentMcpRuntime[];
  builtinToolNames?: readonly string[];
  role?: AgentTeamRole;
  projectDirectory?: string;
  authorizedCommands?: readonly string[];
  processReferencePaths?: readonly string[];
  readProcessReference?: (path: string) => Promise<string>;
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onBackendEvent?: (activity: CodexBackendActivity) => void | Promise<void>;
  onModelRound?: (round: WorkflowAgentRound) => void | Promise<void>;
  onSkillScript?: (activity: AgentInvocationSkillActivity) => void | Promise<void>;
  onMcpCall?: (activity: AgentInvocationMcpActivity) => void | Promise<void>;
  onBuiltinTool?: (activity: AgentInvocationBuiltinActivity) => void | Promise<void>;
  jsonOutput?: boolean;
  correlation?: GatewayCorrelation;
  limits?: { maxToolCalls?: number; maxToolRounds?: number; maxToolResultChars?: number };
  operation?: {
    taskKey: string;
    journal: AgentInvocationOperationJournal;
  };
};

export class AgentInvocationRecoveryRequiredError extends Error {
  constructor(
    readonly reason: string,
    readonly operationKey: string,
    readonly commandId?: string,
  ) {
    super(reason);
    this.name = 'AgentInvocationRecoveryRequiredError';
  }
}

type PersistedToolResult = {
  call: WorkflowAgentToolCall;
  output: GatewayToolResultOutput;
  commandId?: string;
};

type ToolEffectResult = {
  output: GatewayToolResultOutput;
  commandId?: string;
  cancelled?: boolean;
};

const MAX_TOOL_ROUNDS = 20;

@Injectable()
export class IsolatedAgentInvocationService {
  constructor(
    private readonly resources: WorkspaceResourcesService,
    private readonly skillScripts: SkillScriptRunnerService,
    private readonly mcpRuntime: McpRuntimeService,
    private readonly builtinTools: BuiltinAgentToolsService,
    private readonly plugins: PluginsService,
    private readonly codexAppServer: CodexAppServerService,
  ) {}

  async captureDeveloperExecution(): Promise<{ kind: 'codex_app_server'; commandArguments: string[] }> {
    return { kind: 'codex_app_server', commandArguments: await this.plugins.commandArguments(CODEX_CLI_PLUGIN_ID) };
  }

  async execute(request: IsolatedAgentInvocationRequest): Promise<string> {
    const assignedSkills = request.skills.map((skill) => ({
      ...skill,
      instructions: skill.instructions ?? skill.files.find((file) => file.path === 'SKILL.md')?.content ?? '',
    }));
    const availableSkillScripts = request.role && request.projectDirectory
      ? []
      : assignedSkills.flatMap((skill) => skill.files
        .filter((file) => file.path.startsWith('scripts/') && file.content.startsWith('#!'))
        .map((file) => ({ skillId: skill.id, skillName: skill.name, path: file.path })));
    const skillInstructions = assignedSkills
      .map((skill) => `## ${skill.name}\n${skill.instructions.trim()}`)
      .filter((value) => value.trim())
      .join('\n\n');
    const scriptList = availableSkillScripts.map((script) => `- Skill ${script.skillName} (${script.skillId}): ${script.path}`).join('\n');
    const requestedBuiltinToolNames = request.role && request.builtinToolNames
      ? selectBuiltinToolNames(request.role, request.builtinToolNames)
      : request.builtinToolNames ?? [];
    const builtinDefinitions = (request.role
      ? this.builtinTools.toolDefinitions(requestedBuiltinToolNames)
      : this.builtinTools.toolDefinitions(request.builtinToolNames ? requestedBuiltinToolNames : undefined))
      .filter((definition) => request.role || definition.name !== 'process_reference');
    const effectiveSystemPrompt = [
      request.systemPrompt.trim(),
      skillInstructions ? `Assigned Skill instructions:\n\n${skillInstructions}` : '',
      availableSkillScripts.length > 0 ? 'Skill scripts execute immediately without user approval.' : '',
      scriptList ? `Assigned executable Skill scripts:\n${scriptList}\nUse skill_script only with an exact listed Skill id and script path.` : '',
      request.role && request.projectDirectory
        ? [
          'Project execution context:',
          `- Work in ${request.projectDirectory} unless a tool explicitly receives another server-authorized path.`,
          '- Follow the project instructions and any unresolved authorization limits.',
          '- The selected execution mode does not override either constraint.',
          '- Execute bash only with a command exactly listed in authorizedCommands.',
        ].join('\n')
        : '',
      request.role && request.processReferencePaths?.length
        ? `Pinned process reference paths available through process_reference:\n${request.processReferencePaths.join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n');

    const mcpTools = await this.mcpRuntime.discover(request.mcpRuntimes, request.signal);
    const runtime = await this.resources.publicModelRuntime(request.workspaceId, request.publicModelId);
    const contextText = typeof request.context === 'string' ? request.context : JSON.stringify(request.context);
    if (request.codexServerCommandArguments) {
      if (request.role !== 'developer' || !request.operation || !request.projectDirectory) {
        throw new BadRequestException('Codex App Server is available only for journaled Team developer tasks.');
      }
      if (runtime.protocol !== 'openai/responses' && runtime.protocol !== 'codex/responses') {
        throw new BadRequestException('The Team developer model must use an openai/responses or codex/responses Provider for Codex App Server.');
      }
      return this.codexAppServer.execute({
        commandArguments: request.codexServerCommandArguments,
        publicModelId: request.publicModelId,
        systemPrompt: effectiveSystemPrompt,
        input: contextText?.trim() ? contextText : 'No input was provided.',
        tools: [...builtinDefinitions, ...mcpTools],
        signal: request.signal,
        correlation: request.correlation,
        onTextDelta: request.onTextDelta,
        onEvent: request.onBackendEvent,
        executeTool: (call, signal) => this.executeTool({ ...request, signal }, assignedSkills, mcpTools, new Set(builtinDefinitions.map((definition) => definition.name)), call),
      });
    }
    const maxRounds = Math.min(request.limits?.maxToolRounds ?? MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS);
    const result = await createModelGateway().runWorkflowAgent({
      provider: runtime.provider,
      model: runtime.model,
      systemPrompt: effectiveSystemPrompt,
      initialUserContent: contextText?.trim() ? contextText : 'No input was provided.',
      jsonOutput: request.jsonOutput,
      correlation: request.correlation,
      skillScripts: availableSkillScripts,
      builtinTools: builtinDefinitions,
      mcpTools,
      maxToolRounds: maxRounds,
      maxToolCalls: request.limits?.maxToolCalls,
      abortSignal: request.signal,
      onTextDelta: request.onTextDelta,
      onModelRound: request.onModelRound,
      executeTool: async (call) => this.executeTool(request, assignedSkills, mcpTools, new Set(builtinDefinitions.map((definition) => definition.name)), call),
    });
    const output = result.text.trim();
    if (!output) throw new Error('The isolated Agent invocation returned an empty response.');
    return output;
  }

  private async executeTool(
    request: IsolatedAgentInvocationRequest,
    assignedSkills: readonly AgentInvocationSkill[],
    mcpTools: readonly McpRuntimeTool[],
    selectedBuiltinToolNames: ReadonlySet<string>,
    call: WorkflowAgentToolCall,
  ): Promise<WorkflowAgentToolResult> {
    request.signal.throwIfAborted();
    this.validateProcessReference(request, call);
    this.validateTeamToolAuthorization(request, call);
    const freshCodexRead = request.codexServerCommandArguments && ['read', 'glob', 'grep'].includes(call.toolName);
    if (!request.operation || freshCodexRead) {
      return (await this.runToolEffect(request, assignedSkills, mcpTools, selectedBuiltinToolNames, call)).output;
    }

    const semanticInput = call.toolName === 'skill_script'
      ? { skillId: call.skillId, scriptPath: call.scriptPath, arguments: call.arguments }
      : { input: call.input };
    const inputFingerprint = stableInputFingerprint({ toolName: call.toolName, ...semanticInput });
    const taskKey = request.operation.taskKey;
    const baseOperationKey = `${call.toolName}:${inputFingerprint}`;
    const existing = await request.operation.journal.findOperation(`${taskKey}:${baseOperationKey}`);
    let dispatchOperationKey = baseOperationKey;
    let replayOperation = false;

    if (existing) {
      assertOperationMatches(existing, taskKey, baseOperationKey, call.toolName, inputFingerprint);
      if (isCompletedToolResult(existing, call)) return existing.result.output;

      let target = existing;
      while (target.recoveryDecision?.type === 'replay') {
        const replayKey = target.recoveryDecision.replayOperationKey;
        const replay = await request.operation.journal.findReplayOperation(taskKey, replayKey);
        if (!replay) {
          dispatchOperationKey = replayKey;
          replayOperation = true;
          break;
        }
        assertOperationMatches(replay, taskKey, replayKey, call.toolName, inputFingerprint);
        if (isCompletedToolResult(replay, call)) return replay.result.output;
        target = replay;
      }

      if (!replayOperation) {
        if (target.status === 'failed') {
          throw new Error(`Operation ${target.key} has already failed.`);
        }
        throw new AgentInvocationRecoveryRequiredError(
          `Operation ${target.key} requires a recovery decision before it can continue.`,
          target.key,
          target.commandId,
        );
      }
    }

    const journalRequest = {
      taskKey,
      operationKey: dispatchOperationKey,
      toolName: call.toolName,
      inputFingerprint,
      pendingResult: { call },
    };
    const dispatchKey = `${taskKey}:${dispatchOperationKey}`;
    const commandBackedTool = call.toolName === 'skill_script' ||
      (isBuiltinTool(call.toolName) && call.toolName !== 'process_reference');
    let operationReserved = false;
    let effectDispatched = false;
    const reserveCommand: CommandReservation | undefined = commandBackedTool
      ? (transaction, commandId) => {
        if (replayOperation) {
          request.operation!.journal.attachReplayCommand(dispatchKey, commandId, transaction);
        } else {
          request.operation!.journal.reserveOperation(journalRequest, commandId, transaction);
        }
        operationReserved = true;
        effectDispatched = true;
      }
      : undefined;

    let effect: ToolEffectResult;
    try {
      if (commandBackedTool) {
        if (!replayOperation) {
          effect = await this.runToolEffect(request, assignedSkills, mcpTools, selectedBuiltinToolNames, call, reserveCommand);
        } else {
          await request.operation.journal.reserveOperation(journalRequest);
          operationReserved = true;
          effect = await this.runToolEffect(
            request,
            assignedSkills,
            mcpTools,
            selectedBuiltinToolNames,
            call,
            reserveCommand,
          );
        }
        effectDispatched = true;
      } else {
        await request.operation.journal.reserveOperation(journalRequest);
        operationReserved = true;
        effectDispatched = true;
        effect = await this.runToolEffect(
          request,
          assignedSkills,
          mcpTools,
          selectedBuiltinToolNames,
          call,
          replayOperation ? reserveCommand : undefined,
        );
      }
      if (effect.cancelled) throw new Error(`Tool ${call.toolName} was cancelled.`);
      const persisted: PersistedToolResult = { call, output: effect.output, ...(effect.commandId ? { commandId: effect.commandId } : {}) };
      await request.operation.journal.completeOperation(dispatchKey, persisted, effect.commandId);
      return effect.output;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The tool effect has an unknown state.';
      if (effectDispatched) {
        const uncertain = await request.operation.journal.markOperationUncertain(dispatchKey, reason);
        throw new AgentInvocationRecoveryRequiredError(
          `Operation ${dispatchKey} requires a recovery decision before it can continue.`,
          dispatchKey,
          uncertain.commandId,
        );
      }
      if (operationReserved) {
        await request.operation.journal.failOperation(dispatchKey, reason);
      }
      throw error;
    }
  }

  private async runToolEffect(
    request: IsolatedAgentInvocationRequest,
    assignedSkills: readonly AgentInvocationSkill[],
    mcpTools: readonly McpRuntimeTool[],
    selectedBuiltinToolNames: ReadonlySet<string>,
    call: WorkflowAgentToolCall,
    reserveCommand?: CommandReservation,
  ): Promise<ToolEffectResult> {
    if (call.toolName === 'process_reference') {
      const value = await request.readProcessReference!(requiredString(
        (call.input as { path?: unknown } | null)?.path,
        'path',
      ));
      return { output: { type: 'text', value: boundedToolResult(value, request.limits?.maxToolResultChars) } };
    }

    if (call.toolName === 'skill_script') {
      if (request.role && request.projectDirectory) {
        throw new BadRequestException('Executable Skill scripts are unavailable for Agent Team invocations.');
      }
      const skill = assignedSkills.find((item) => item.id === call.skillId);
      const script = skill?.files.find((file) => file.path === call.scriptPath && file.path.startsWith('scripts/') && file.content.startsWith('#!'));
      if (!skill || !script) throw new BadRequestException('The isolated Agent requested an unavailable Skill script.');
      const started = await this.skillScripts.start(skill.files, script.path, call.arguments ?? [], {
        cwd: request.projectDirectory,
        ...(reserveCommand ? { reserveCommand } : {}),
      });
      const cancel = () => { void this.skillScripts.cancel(started.id).catch(() => undefined); };
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) cancel();
      try {
        const completed = await this.skillScripts.wait(started.id);
        request.signal.throwIfAborted();
        const succeeded = completed.execution.status === 'succeeded';
        const fullValue = completed.output || (succeeded ? 'Skill script completed without output.' : `Skill script failed with exit code ${completed.execution.exitCode ?? 'unknown'}.`);
        const value = boundedToolResult(fullValue, request.limits?.maxToolResultChars);
        await request.onSkillScript?.({
          skillId: skill.id,
          skillName: skill.name,
          scriptPath: script.path,
          arguments: call.arguments ?? [],
          commandExecutionId: started.id,
          exitCode: completed.execution.exitCode ?? null,
          status: succeeded ? 'succeeded' : 'failed',
        });
        return {
          output: { type: succeeded ? 'text' : 'error-text', value },
          commandId: started.id,
          cancelled: completed.execution.status === 'cancelled',
        };
      } finally {
        request.signal.removeEventListener('abort', cancel);
      }
    }

    if (isBuiltinTool(call.toolName)) {
      if (!selectedBuiltinToolNames.has(call.toolName)) throw new BadRequestException('The isolated Agent requested an unavailable built-in tool.');
      const started = await this.builtinTools.start(call.toolName, call.input, {
        cwd: request.projectDirectory,
        ...(reserveCommand ? { reserveCommand } : {}),
      });
      const cancel = () => { void this.builtinTools.cancel(started.id).catch(() => undefined); };
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) cancel();
      try {
        const completed = await this.builtinTools.wait(started.id);
        request.signal.throwIfAborted();
        const succeeded = completed.execution.status === 'succeeded';
        await request.onBuiltinTool?.({
          toolName: call.toolName,
          input: call.input,
          commandExecutionId: started.id,
          exitCode: completed.execution.exitCode ?? null,
          status: succeeded ? 'succeeded' : 'failed',
        });
        return {
          output: { type: succeeded ? 'text' : 'error-text', value: boundedToolResult(completed.output, request.limits?.maxToolResultChars) },
          commandId: started.id,
          cancelled: completed.execution.status === 'cancelled',
        };
      } finally {
        request.signal.removeEventListener('abort', cancel);
      }
    }

    const mcpTool = mcpTools?.find((tool) => tool.name === call.toolName);
    const mcpRuntime = mcpTool ? request.mcpRuntimes.find((item) => item.id === mcpTool.serverId) : undefined;
    if (!mcpTool || !mcpRuntime) throw new BadRequestException('The isolated Agent requested an unavailable MCP tool.');
    let value: string;
    try {
      value = await this.mcpRuntime.call(mcpRuntime, mcpTool.remoteName, call.input, request.signal);
    } catch (error) {
      await request.onMcpCall?.({
        serverId: mcpRuntime.id,
        toolName: mcpTool.remoteName,
        input: call.input,
        result: error instanceof Error ? error.message : 'The MCP tool call failed.',
        status: 'failed',
      });
      throw error;
    }
    await request.onMcpCall?.({
      serverId: mcpRuntime.id,
      toolName: mcpTool.remoteName,
      input: call.input,
      result: value,
      status: 'succeeded',
    });
    return { output: { type: 'text', value: boundedToolResult(value, request.limits?.maxToolResultChars) } };
  }

  private validateTeamToolAuthorization(
    request: IsolatedAgentInvocationRequest,
    call: WorkflowAgentToolCall,
  ): void {
    if (!request.role || !request.projectDirectory || call.toolName !== 'bash') return;
    const command = requiredString((call.input as { command?: unknown } | null)?.command, 'command');
    if (!request.authorizedCommands?.includes(command)) {
      throw new BadRequestException('The exact shell command is not authorized for this Agent Team run.');
    }
  }

  private validateProcessReference(
    request: IsolatedAgentInvocationRequest,
    call: WorkflowAgentToolCall,
  ): void {
    if (call.toolName !== 'process_reference') return;
    if (!request.role || !request.projectDirectory) {
      throw new BadRequestException('Process references are unavailable for this Agent invocation.');
    }
    const referencePath = requiredString((call.input as { path?: unknown } | null)?.path, 'path');
    if (!request.processReferencePaths?.includes(referencePath) || !request.readProcessReference) {
      throw new BadRequestException('The requested process reference is unavailable.');
    }
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
  return value.trim();
}

function isBuiltinTool(name: string): boolean {
  return name === 'bash' || name === 'read' || name === 'write' || name === 'glob' || name === 'grep';
}

function boundedToolResult(value: string, maxChars: number | undefined): string {
  return maxChars && value.length > maxChars
    ? `${value.slice(0, maxChars)}\n[Tool output truncated; use available evidence and report gaps.]`
    : value;
}

function isPersistedToolResult(value: unknown, call: WorkflowAgentToolCall): value is PersistedToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedToolResult>;
  return candidate.call?.toolName === call.toolName &&
    !!candidate.output &&
    (candidate.output.type === 'text' || candidate.output.type === 'error-text') &&
    typeof candidate.output.value === 'string';
}

function assertOperationMatches(
  record: AgentInvocationOperationRecord,
  taskKey: string,
  operationKey: string,
  toolName: string,
  inputFingerprint: string,
): void {
  if (
    record.taskKey !== taskKey ||
    record.operationKey !== operationKey ||
    record.toolName !== toolName ||
    record.inputFingerprint !== inputFingerprint
  ) {
    throw new Error(`Operation ${taskKey}:${operationKey} was persisted for different input.`);
  }
}

function isCompletedToolResult(
  record: AgentInvocationOperationRecord,
  call: WorkflowAgentToolCall,
): record is AgentInvocationOperationRecord & { result: PersistedToolResult } {
  return record.status === 'completed' && isPersistedToolResult(record.result, call);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function stableInputFingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
