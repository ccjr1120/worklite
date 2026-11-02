import { assertRuntimeAdmission } from '../../infrastructure/runtime-upgrade-state';
import { Lexer } from 'marked';
import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { ArtifactView, CreateRunRequest, RunProgressEvent, RunView, WorkflowNodeActivityDetail, WorkflowNodeActivityEventPayload, WorkflowNodeActivityView, WorkflowNodeRunView, WorkflowPendingActionView } from '@worklite/contracts';
import {
  artifacts,
  workflowNodeRuns,
  workflowPendingActions,
  workflowRunEvents,
  workflowRuns,
  workflowVersions,
  workflows,
  type Database,
  type StoredWorkflowDefinition,
  type StoredWorkflowEdge,
  type StoredWorkflowExecutionState,
  type StoredWorkflowNode,
} from '@worklite/db';
import { commitWorkflowInvocation, composeWorkflowArticle, createWorkflowSchedulerState, executeWorkflowMap, NodeTypeRegistry, readWorkflowOutputPath, resolveWorkflowNodeCapability, takeNextWorkflowInvocation, workflowRunResult, type NodeExecutionContext, type NodeExecutionRequest, type PendingNodeExecutionResult, type WorkflowSchedulerState } from '@worklite/workflow-engine';
import { AgentJsonOutputError, type GatewayCorrelation } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentExecutionsService } from '../agents/agent-executions.service';
import { WechatOfficialAccountService } from '../plugins/wechat-official-account.service';
import { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import { renderCanvasSticker, validateCanvasStickerConfig } from './canvas-sticker';
import { renderCanvasScript, validateCanvasRenderCode, validateCanvasRenderConfig } from './canvas-render';
import { ArtifactStorageService } from '../artifacts/artifact-storage.service';

type RunListener = (event: RunProgressEvent) => void;
type PreparedArtifactItem = { id: string; name: string; format: 'text' | 'markdown' | 'json' | 'image' };
type PreparedArtifactNode = {
  records: Array<typeof artifacts.$inferInsert>;
  items: PreparedArtifactItem[];
  storageKeys: string[];
  output: unknown;
};

// Streaming deltas are merged before persistence: one row per flush instead of one
// row per token, which previously made every Agent run hold the database write lock
// almost continuously. Replay concatenates the same text either way.
const DELTA_FLUSH_MS = 250;
const DELTA_FLUSH_CHARS = 64 * 1024;

type DeltaBuffer = { nodeId: string; nodeRunId: string; text: string; timer: NodeJS.Timeout };

class RunCancelledError extends Error {
  constructor() {
    super('Workflow run cancelled.');
    this.name = 'RunCancelledError';
  }
}

type RunAcceptance = { runId: string; accept: (transaction: Parameters<Parameters<Database['transaction']>[0]>[0]) => void };

@Injectable()
export class RunsService {
  private readonly registry = new NodeTypeRegistry();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly listeners = new Set<RunListener>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly deltaBuffers = new Map<string, DeltaBuffer>();
  private readonly pendingCompletions = new Set<string>();
  private completionFlush: Promise<void> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    @Inject(forwardRef(() => AgentExecutionsService)) private readonly agentExecutions: AgentExecutionsService,
    private readonly wechatOfficialAccount: WechatOfficialAccountService,
    private readonly gateway: PortkeyGatewayService,
    private readonly artifactStorage: ArtifactStorageService,
  ) {
    const capability = (id: string, version = '1') => {
      const value = resolveWorkflowNodeCapability(id, version);
      if (!value) throw new Error(`Workflow node capability is unavailable: ${id}@${version}`);
      return value;
    };
    this.registry.register({
      ...capability('worklite/input'),
      execute: async ({ context }) => ({ output: context.variables.workflowInput }),
    });
    this.registry.register({
      ...capability('worklite/timer'),
      execute: async ({ input }) => ({ output: { trigger: 'timer', value: input ?? null } }),
    });
    this.registry.register({
      ...capability('worklite/branch'),
      execute: async ({ input }) => {
        const values = asRecord(input);
        if (!values || !Object.prototype.hasOwnProperty.call(values, 'value')) throw new Error('Choice Branch node requires a JSON value input.');
        return { output: values.value };
      },
    });
    this.registry.register({
      ...capability('worklite/dashboard'),
      execute: async ({ input }) => ({ output: (input as { data?: unknown } | null | undefined)?.data ?? null }),
    });
    this.registry.register({
      ...capability('worklite/artifact'),
      execute: async ({ input }) => ({ output: (input as { data?: unknown } | null | undefined)?.data ?? null }),
    });
    this.registry.register({
      ...capability('worklite/artifact-query'),
      execute: async ({ input, config, context }) => {
        const settings = asRecord(config);
        const name = settings?.name as string;
        const titleField = settings?.titleField as string;
        const descriptionFields = settings?.descriptionFields as string[];
        const rows = await this.db.select({ id: artifacts.id, content: artifacts.content, createdAt: artifacts.createdAt })
          .from(artifacts)
          .where(and(eq(artifacts.workspaceId, context.workspaceId), eq(artifacts.name, name), eq(artifacts.format, 'json')))
          .orderBy(desc(artifacts.createdAt), desc(artifacts.id));
        const candidates: Array<{ artifactId: string; title: string; description: string; createdAt: string | null }> = [];
        for (const row of rows) {
          let record: Record<string, unknown> | null;
          try {
            record = asRecord(JSON.parse(row.content));
          } catch {
            continue;
          }
          const titleValue = record?.[titleField];
          const title = typeof titleValue === 'string' ? titleValue.trim() : '';
          const description = descriptionFields.map((field) => {
            const value = record?.[field];
            return typeof value === 'string' ? value.trim() : '';
          }).filter(Boolean).join(' ');
          if (title && description) candidates.push({ artifactId: row.id, title, description, createdAt: row.createdAt?.toISOString() ?? null });
        }
        return { output: { request: asRecord(input)?.request, candidates } };
      },
    });
    this.registry.register({
      ...capability('worklite/agent'),
      execute: async (request) => {
        const config = asRecord(request.config);
        const inputs = asRecord(request.input);
        const configModel = modelOrList(config?.model);
        if (!config || !configModel || typeof config.systemPrompt !== 'string') throw new Error('Agent node requires a model and system prompt.');
        if (!Array.isArray(config.skillIds) || config.skillIds.some((id) => typeof id !== 'string')) throw new Error('Agent node requires valid Skill identifiers.');
        if (!Array.isArray(config.mcpServerIds) || config.mcpServerIds.some((id) => typeof id !== 'string')) throw new Error('Agent node requires valid MCP server identifiers.');
        if (config.requiredSkillIds !== undefined && (!Array.isArray(config.requiredSkillIds) || config.requiredSkillIds.some((id) => typeof id !== 'string' || !id.trim()))) throw new Error('Agent node requiredSkillIds must be Skill identifiers.');
        const context = inputs && Object.prototype.hasOwnProperty.call(inputs, 'context') ? inputs.context : request.context.variables.workflowInput;
        // Draft Skill ids may be retired aliases; the script activity reports the
        // canonical id, so the requirement is canonicalized the same way.
        const requiredSkillIds = Array.isArray(config.requiredSkillIds) && config.requiredSkillIds.length > 0
          ? await this.agentExecutions.resolveWorkflowSkillIds(request.context.workspaceId, config.requiredSkillIds as string[])
          : [];
        const skillScriptCalls: SkillScriptCallRecord[] = [];
        let response: string;
        try {
          response = await this.agentExecutions.executeWorkflowAgent(
            request.context.workspaceId,
            configModel,
            context,
            config.systemPrompt,
            config.skillIds as string[],
            config.mcpServerIds as string[],
            request.signal,
            (delta) => { void this.publish(request.context.workflowRunId, 'node.delta', { nodeId: request.context.nodeId, nodeRunId: request.context.nodeRunId, delta }); },
            config.outputFormat === 'json',
            (detail) => {
              if (detail.phase === 'skill.script') {
                skillScriptCalls.push({
                  skillId: detail.skillId,
                  skillName: detail.skillName,
                  exitCode: detail.exitCode,
                  status: detail.status,
                  ...(detail.failureReason ? { failureReason: detail.failureReason } : {}),
                });
              }
              return this.publishActivity(request.context.workflowRunId, request.context.nodeId, request.context.nodeRunId, detail);
            },
            { workflowId: request.context.workflowId, workflowRunId: request.context.workflowRunId, nodeRunId: request.context.nodeRunId },
            { maxToolCalls: config.maxToolCalls as number | undefined, maxToolRounds: config.maxToolRounds as number | undefined, maxToolResultChars: config.maxToolResultChars as number | undefined, maxOutputTokens: config.maxOutputTokens as number | undefined },
          );
        } catch (error) {
          // A failed required channel is the cause; a model that then stops with
          // prose instead of JSON is only its consequence, so report the cause.
          if (request.signal.aborted) throw error;
          assertRequiredSkillScriptCalls(requiredSkillIds, skillScriptCalls);
          throw workflowAgentFailure(error);
        }
        // The model's own report is not evidence: every required Skill must have at
        // least one script call that actually succeeded during this node attempt.
        assertRequiredSkillScriptCalls(requiredSkillIds, skillScriptCalls);
        if (config.outputFormat !== 'json') return { output: response };
        const output = parseWorkflowAgentJson(response);
        assertWorkflowAgentOutputContract(output, config.outputContract, config.allowEmptyOutputKeys);
        if (Array.isArray(config.passthroughKeys)) {
          const source = asRecord(context);
          const target = asRecord(output);
          if (!source || !target) throw new Error('Agent passthrough requires JSON objects.');
          for (const key of config.passthroughKeys as string[]) {
            if (!Object.prototype.hasOwnProperty.call(source, key)) throw new Error(`Agent passthrough input is missing ${key}.`);
            target[key] = source[key];
          }
        }
        return { output };
      },
    });
    this.registry.register({
      ...capability('typesafe/systemone'),
      execute: async (request) => {
        const config = asRecord(request.config);
        const inputs = asRecord(request.input);
        if (!config || typeof config.model !== 'string' || !config.model.trim()) throw new Error('TypeSafe System One node requires a public model id.');
        if (!config.questions || typeof config.questions !== 'object' || Array.isArray(config.questions)) throw new Error('TypeSafe System One node requires a questions object.');
        if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, 'state')) throw new Error('TypeSafe System One node requires a state input.');
        const output = await this.gateway.executeSystemOne({
          model: config.model,
          state: inputs.state,
          questions: config.questions as Record<string, unknown>,
          correlation: workflowCorrelation(request.context),
          signal: request.signal,
        });
        const state = inputs.state;
        const stateOutput = state && typeof state === 'object' && !Array.isArray(state)
          ? state as Record<string, unknown>
          : { state };
        return { output: { ...stateOutput, ...output } };
      },
    });
    this.registry.register({
      ...capability('typesafe/systemone-map'),
      execute: async (request) => {
        const config = asRecord(request.config);
        const inputs = asRecord(request.input);
        if (!config || typeof config.model !== 'string' || !config.model.trim()) throw new Error('TypeSafe System One Map node requires a public model id.');
        if (!config.questions || typeof config.questions !== 'object' || Array.isArray(config.questions)) throw new Error('TypeSafe System One Map node requires a questions object.');
        if (typeof config.itemsPath !== 'string' || !config.itemsPath.trim()) throw new Error('TypeSafe System One Map node requires an items path.');
        if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, 'state')) throw new Error('TypeSafe System One Map node requires a state input.');
        const state = inputs.state;
        const located = readWorkflowOutputPath(state, config.itemsPath);
        if (!located.exists || !Array.isArray(located.value)) throw new Error(`TypeSafe System One Map node requires a JSON array at ${config.itemsPath}.`);
        const items = located.value;
        const context = typeof config.contextPath === 'string' && config.contextPath.trim() ? readWorkflowOutputPath(state, config.contextPath).value ?? null : null;
        const questions = config.questions as Record<string, unknown>;
        const evaluated = new Array<Record<string, unknown>>(items.length);
        const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        let usageReported = false;
        // Iteration stays inside this single invocation, so the scheduler still sees one token and
        // one committed output. A failed element rejects the whole node under its error policy
        // rather than committing a partially evaluated array to a downstream node.
        const concurrency = typeof config.concurrency === 'number' && Number.isInteger(config.concurrency) && config.concurrency > 0 ? config.concurrency : 4;
        let cursor = 0;
        const evaluate = async (): Promise<void> => {
          for (let index = cursor++; index < items.length; index = cursor++) {
            const item = items[index];
            // Each element carries only its own content plus the shared context the author
            // addressed, because surplus state measurably degrades a typed judgement.
            const answer = await this.gateway.executeSystemOne({
              model: (config.model as string).trim(),
              state: { item, context },
              questions,
              correlation: workflowCorrelation(request.context),
              signal: request.signal,
            });
            const record = asRecord(item);
            evaluated[index] = { ...(record ?? { item }), answers: answer.answers };
            if (answer.usage) {
              usageReported = true;
              const inputTokens = answer.usage.input_tokens ?? 0;
              const outputTokens = answer.usage.output_tokens ?? 0;
              usage.input_tokens += inputTokens;
              usage.output_tokens += outputTokens;
              usage.total_tokens += answer.usage.total_tokens ?? inputTokens + outputTokens;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => evaluate()));
        const results = rankSystemOneMapResults(evaluated, config.rank);
        const stateOutput = state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : { state };
        return { output: { ...stateOutput, results, ...(usageReported ? { usage } : {}) } };
      },
    });
    this.registry.register({
      ...capability('worklite/approved-article'),
      execute: async (request) => {
        const input = asRecord(request.input);
        const reviewed = asRecord(input?.context);
        if (reviewed?.approved !== true || reviewed.duplicate !== false || !Array.isArray(reviewed.feedback) || reviewed.feedback.length !== 0 || !Array.isArray(reviewed.open) || reviewed.open.length !== 0) throw new Error('The article was not approved or was marked as a duplicate.');
        const article = reviewed.article;
        if (typeof article !== 'string' || !article.trim()) throw new Error('The approved article is missing.');
        const headings = Lexer.lex(article).filter((token) => token.type === 'heading' && token.depth === 1);
        if (headings.length !== 1 || !/^# [^\n]+/.test(article) || headings[0]?.type !== 'heading' || headings[0].text !== reviewed.title) throw new Error('The approved article needs one matching level-one Markdown title.');
        let fence: { marker: string; length: number } | null = null;
        for (const line of article.split(/\r?\n/)) {
          const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
          if (!match) continue;
          const marker = match[1]![0]!;
          if (!fence) {
            if (marker === '`' && match[2]?.includes('`')) throw new Error('The article has a malformed Markdown code fence.');
            fence = { marker, length: match[1]!.length };
          } else if (marker === fence.marker && match[1]!.length >= fence.length && !match[2]?.trim()) {
            fence = null;
          }
        }
        if (fence) throw new Error('The article has an unclosed Markdown code fence.');
        return { output: article };
      },
    });
    this.registry.register({
      ...capability('worklite/image'),
      execute: async (request) => {
        const config = asRecord(request.config);
        const input = asRecord(request.input);
        if (!config || config.model !== 'codex/gpt-image-2') throw new Error('Image node requires the codex/gpt-image-2 model.');
        let prompt = typeof input?.prompt === 'string' ? input.prompt : '';
        const promptPath = typeof config.promptPath === 'string' && config.promptPath.trim() ? config.promptPath.trim() : '';
        if (!prompt.trim() && promptPath) {
          const source = Object.prototype.hasOwnProperty.call(input ?? {}, 'context') ? input?.context : request.context.variables.workflowInput;
          const located = readWorkflowOutputPath(source, promptPath);
          if (!located.exists || typeof located.value !== 'string') throw new Error(`Image node prompt path "${promptPath}" must resolve to a string.`);
          prompt = located.value;
        }
        if (!prompt.trim()) throw new Error('Image node requires a prompt.');
        if (typeof config.n !== 'number' || !Number.isInteger(config.n) || config.n < 1) throw new Error('Image node image count must be a positive integer.');
        if (config.background !== 'opaque' && config.background !== 'transparent') throw new Error('Image node background is invalid.');
        if (config.quality !== 'low' && config.quality !== 'medium' && config.quality !== 'high') throw new Error('Image node quality is invalid.');
        if (config.size !== '1024x1024' && config.size !== '1536x1024' && config.size !== '1024x1536') throw new Error('Image node size is invalid.');
        const output = await this.gateway.generateImage({
          prompt,
          model: config.model,
          n: config.n,
          background: config.background,
          quality: config.quality,
          size: config.size,
          correlation: workflowCorrelation(request.context),
          signal: request.signal,
        });
        const key = typeof config.key === 'string' && config.key.trim() ? config.key.trim() : undefined;
        return { output: key ? { ...output, key } : output };
      },
    });
    this.registry.register({
      ...capability('worklite/canvas-sticker'),
      execute: async (request) => {
        const config = validateCanvasStickerConfig(request.config);
        const input = asRecord(request.input);
        const text = typeof input?.text === 'string' ? input.text : undefined;
        const png = renderCanvasSticker(config, text);
        return {
          output: {
            type: 'workflow_image',
            model: 'worklite/canvas-sticker',
            mediaType: 'image/png',
            ...(config.key ? { key: config.key } : {}),
            data: [{ b64Json: png.toString('base64') }],
          },
        };
      },
    });
    this.registry.register({
      ...capability('worklite/canvas-render'),
      execute: async (request) => {
        const config = validateCanvasRenderConfig(request.config);
        const input = asRecord(request.input);
        const code = validateCanvasRenderCode(input?.code);
        const rendered = await renderCanvasScript(config, code, request.signal);
        return {
          output: {
            type: 'workflow_image',
            model: 'worklite/canvas-render',
            mediaType: 'image/png',
            width: rendered.width,
            height: rendered.height,
            ...(config.key ? { key: config.key } : {}),
            data: [{ b64Json: rendered.png.toString('base64') }],
          },
        };
      },
    });
    this.registry.register({
      ...capability('worklite/map'),
      execute: async (request) => {
        const input = asRecord(request.input) ?? {};
        const context = Object.prototype.hasOwnProperty.call(input, 'context') ? input.context : request.context.variables.workflowInput;
        const output = await executeWorkflowMap({
          itemsValue: input.items,
          context,
          config: request.config,
          signal: request.signal,
          executeNode: async ({ node, input: nodeInput, config, signal }) => {
            const nodeType = this.registry.resolve(node.type, node.typeVersion);
            const result = await nodeType.execute({
              input: nodeInput,
              config,
              context: { ...request.context, pendingActionId: randomUUID() },
              signal,
            });
            if (result.status === 'waiting_for_input') throw new Error(`Map subgraph node "${node.id}" cannot wait for input.`);
            return result.output;
          },
          onElementError: (error, index, total) => this.publishActivity(
            request.context.workflowRunId,
            request.context.nodeId,
            request.context.nodeRunId,
            { phase: 'map.element', index, total, status: 'skipped', message: error.message },
          ),
        });
        return { output };
      },
    });
    this.registry.register({
      ...capability('worklite/join'),
      execute: async ({ input }) => {
        const values = asRecord(input)?.input;
        return { output: Array.isArray(values) ? values : [] };
      },
    });
    this.registry.register({
      ...capability('worklite/compose-article'),
      execute: async ({ input, config }) => ({ output: composeWorkflowArticle(input, config) }),
    });
    this.registry.register({
      ...capability('wechat-official-account/publish', '1'),
      execute: (request) => this.wechatOfficialAccount.execute(request, '1'),
    });
    this.registry.register({
      ...capability('wechat-official-account/publish', '2'),
      execute: (request) => this.wechatOfficialAccount.execute(request, '2'),
    });
    this.wechatOfficialAccount.subscribe((actionId) => this.queueCompletedAction(actionId));
  }

  async list(request: Request, workspaceSlug: string, options: { workflowId?: string; limit?: number } = {}): Promise<RunView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    // The filters are read-only projections for bounded inspection; an omitted option keeps the full list.
    const conditions = [eq(workflowRuns.workspaceId, team.id)];
    if (options.workflowId) conditions.push(eq(workflowRuns.workflowId, options.workflowId));
    const statement = this.db.select({ run: workflowRuns, workflow: workflows, version: workflowVersions })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .innerJoin(workflowVersions, eq(workflowRuns.workflowVersionId, workflowVersions.id))
      .where(and(...conditions))
      .orderBy(desc(workflowRuns.createdAt));
    const rows = options.limit === undefined ? await statement : await statement.limit(options.limit);
    return Promise.all(rows.map(({ run, workflow, version }) => this.toView(run, workflow, version, workspaceSlug, 'You', false)));
  }

  async get(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select({ run: workflowRuns, workflow: workflows, version: workflowVersions })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .innerJoin(workflowVersions, eq(workflowRuns.workflowVersionId, workflowVersions.id))
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('Run not found');
    return this.toView(row.run, row.workflow, row.version, workspaceSlug, 'You', true);
  }

  async events(request: Request, workspaceSlug: string, runId: string, afterSequence = 0): Promise<RunProgressEvent[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [run] = await this.db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id))).limit(1);
    if (!run) throw new NotFoundException('Run not found');
    const rows = await this.db.select().from(workflowRunEvents).where(and(eq(workflowRunEvents.runId, runId), gt(workflowRunEvents.sequence, afterSequence))).orderBy(asc(workflowRunEvents.sequence));
    return rows.map((row) => ({ runId: row.runId, sequence: row.sequence, type: row.type, payload: sanitizeWorkflowImages(row.payload), occurredAt: row.createdAt.toISOString() }));
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createForVersion(request: Request, workflowVersionId: string, input: CreateRunRequest, acceptance?: RunAcceptance): Promise<{ runId: string }> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const [version] = await this.db.select({ version: workflowVersions, workflow: workflows })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(and(eq(workflowVersions.id, workflowVersionId), eq(workflowVersions.workspaceId, workspace.id), eq(workflowVersions.published, true))).limit(1);
    if (!version) throw new NotFoundException('Published workflow version not found');
    return this.createScheduledRun(version.workflow.workspaceId, version.workflow.id, workflowVersionId, input?.input ?? null, acceptance);
  }

  async createScheduledRun(workspaceId: string, workflowId: string, workflowVersionId: string, input: unknown, acceptance?: RunAcceptance): Promise<{ runId: string }> {
    assertRuntimeAdmission();
    const runId = acceptance?.runId ?? `run_${randomUUID()}`;
    let created = false;
    this.db.transaction((transaction) => {
      created = transaction.insert(workflowRuns).values({ id: runId, workspaceId, workflowId, workflowVersionId, input: sanitizeWorkflowImages(input ?? null), status: 'queued' }).onConflictDoNothing().run().changes > 0;
      acceptance?.accept(transaction);
    });
    if (!created) return { runId };
    await this.publish(runId, 'run.status', { status: 'queued' });
    this.schedule(runId);
    return { runId };
  }

  async cancel(request: Request, workspaceSlug: string, runId: string, deferExternalCleanup = false): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const finishedAt = new Date();
    const [run] = await this.db.update(workflowRuns).set({ status: 'cancelled', currentNodeId: null, finishedAt, updatedAt: finishedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id), sql`${workflowRuns.status} in ('queued', 'running', 'paused', 'waiting_for_input')`)).returning();
    if (!run) return this.get(request, workspaceSlug, runId);
    this.activeRuns.get(runId)?.abort();
    const pendingActions = await this.db.select({ id: workflowPendingActions.id }).from(workflowPendingActions).where(and(eq(workflowPendingActions.runId, runId), eq(workflowPendingActions.status, 'pending')));
    const cancelExternalActions = Promise.all(pendingActions.map(({ id }) => this.wechatOfficialAccount.cancel(id)));
    if (deferExternalCleanup) void cancelExternalActions.catch(() => undefined);
    else await cancelExternalActions;
    await this.db.update(workflowPendingActions).set({ status: 'cancelled', qrCode: null, updatedAt: finishedAt }).where(and(eq(workflowPendingActions.runId, runId), eq(workflowPendingActions.status, 'pending')));
    await this.db.update(workflowNodeRuns).set({ status: 'cancelled', error: 'Workflow run cancelled.', finishedAt }).where(and(eq(workflowNodeRuns.runId, runId), inArray(workflowNodeRuns.status, ['queued', 'running', 'waiting_for_input'])));
    await this.publish(runId, 'run.status', { status: 'cancelled' });
    const [workflow] = await this.db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
    const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, run.workflowVersionId)).limit(1);
    if (!workflow || !version) throw new NotFoundException('Run dependencies not found');
    return this.toView(run, workflow, version, workspaceSlug, 'You', true);
  }

  upgradeQuiescent(): boolean { return this.activeRuns.size === 0; }

  async pause(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const now = new Date();
    const pausedRun = await this.db.transaction((transaction) => {
      const [updatedRun] = transaction.update(workflowRuns)
        .set({ status: 'paused', updatedAt: now })
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id), inArray(workflowRuns.status, ['queued', 'running'])))
        .returning().all();
      if (!updatedRun) return null;
      transaction.update(workflowNodeRuns)
        .set({ status: 'queued' })
        .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.status, 'running')))
        .run();
      return updatedRun;
    });
    if (!pausedRun) return this.get(request, workspaceSlug, runId);
    this.activeRuns.get(runId)?.abort();
    await this.publish(runId, 'run.status', { status: 'paused' });
    const [workflow] = await this.db.select().from(workflows).where(eq(workflows.id, pausedRun.workflowId)).limit(1);
    const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, pausedRun.workflowVersionId)).limit(1);
    if (!workflow || !version) throw new NotFoundException('Run dependencies not found');
    return this.toView(pausedRun, workflow, version, workspaceSlug, 'You', true);
  }

  async resume(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const now = new Date();
    const resumedRun = await this.db.transaction((transaction) => {
      const [currentRun] = transaction.select().from(workflowRuns)
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id)))
        .limit(1).all();
      if (!currentRun || !runResumable(currentRun)) return null;
      const [updatedRun] = transaction.update(workflowRuns)
        .set({
          status: 'queued',
          result: null,
          currentNodeId: currentRun.executionState?.active?.nodeId ?? null,
          finishedAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.workspaceId, team.id),
          eq(workflowRuns.status, currentRun.status),
        ))
        .returning().all();
      if (!updatedRun) return null;
      const activeNodeRunId = updatedRun.executionState?.active?.nodeRunId;
      if (activeNodeRunId) {
        transaction.update(workflowNodeRuns)
          .set({ status: 'queued', error: null, finishedAt: null })
          .where(and(
            eq(workflowNodeRuns.id, activeNodeRunId),
            eq(workflowNodeRuns.runId, runId),
            inArray(workflowNodeRuns.status, ['queued', 'running', 'waiting_for_input', 'cancelled']),
          ))
          .run();
      }
      return updatedRun;
    });
    if (!resumedRun) return this.get(request, workspaceSlug, runId);
    await this.publish(runId, 'run.status', { status: 'queued' });
    this.schedule(runId);
    return this.get(request, workspaceSlug, runId);
  }

  async refreshPendingAction(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [run] = await this.db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id))).limit(1);
    if (!run) throw new NotFoundException('Run not found');
    if (run.status !== 'waiting_for_input') throw new NotFoundException('Run has no pending action.');
    const [action] = await this.db.select().from(workflowPendingActions).where(and(eq(workflowPendingActions.runId, runId), inArray(workflowPendingActions.status, ['pending', 'expired']))).orderBy(desc(workflowPendingActions.createdAt)).limit(1);
    if (!action) throw new NotFoundException('Pending action not found.');
    const refreshed = await this.wechatOfficialAccount.refresh(action.id);
    if (!refreshed.qrCode || !refreshed.expiresAt || !Number.isFinite(refreshed.expiresAt.getTime()) || refreshed.expiresAt.getTime() <= Date.now()) {
      await this.wechatOfficialAccount.cancel(action.id);
      throw new BadRequestException('WeChat did not return a current scannable QR code.');
    }
    const [updatedAction] = await this.db.update(workflowPendingActions).set({ status: 'pending', type: refreshed.type, title: refreshed.title, description: refreshed.description, qrCode: refreshed.qrCode, expiresAt: refreshed.expiresAt, externalOperationId: refreshed.externalOperationId ?? null, updatedAt: new Date() }).where(and(eq(workflowPendingActions.id, action.id), inArray(workflowPendingActions.status, ['pending', 'expired']))).returning();
    if (!updatedAction) {
      await this.wechatOfficialAccount.cancel(action.id);
      return this.get(request, workspaceSlug, runId);
    }
    await this.publish(runId, 'pending_action.updated', { actionId: action.id, status: 'pending', expiresAt: refreshed.expiresAt?.toISOString() ?? null });
    return this.get(request, workspaceSlug, runId);
  }

  async openPendingActionBrowser(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [run] = await this.db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id))).limit(1);
    if (!run) throw new NotFoundException('Run not found');
    if (run.status !== 'waiting_for_input') throw new NotFoundException('Run has no pending action.');
    const [action] = await this.db.select().from(workflowPendingActions).where(and(eq(workflowPendingActions.runId, runId), inArray(workflowPendingActions.status, ['pending', 'expired']))).orderBy(desc(workflowPendingActions.createdAt)).limit(1);
    if (!action) throw new NotFoundException('Pending action not found.');
    if (action.type !== 'wechat_login') throw new BadRequestException('Browser login is only available for WeChat Official Account sign-in.');
    const expiresAt = await this.wechatOfficialAccount.openLoginInBrowser(action.id);
    await this.publish(runId, 'pending_action.updated', { actionId: action.id, status: 'pending', expiresAt: expiresAt.toISOString() });
    return this.get(request, workspaceSlug, runId);
  }

  async retryNode(request: Request, workspaceSlug: string, runId: string, nodeRunId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [run] = await this.db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id))).limit(1);
    if (!run) throw new NotFoundException('Run not found');
    if (retryableNodeRunIdOf(run) !== nodeRunId) throw new BadRequestException('This node run cannot be retried.');
    const now = new Date();
    const retried = await this.db.transaction((transaction) => {
      const [updatedNodeRun] = transaction.update(workflowNodeRuns)
        .set({ status: 'queued', error: null, finishedAt: null, retryCount: sql`${workflowNodeRuns.retryCount} + 1` })
        .where(and(eq(workflowNodeRuns.id, nodeRunId), eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.status, 'failed')))
        .returning().all();
      const [updatedRun] = transaction.update(workflowRuns)
        .set({ status: 'queued', result: null, currentNodeId: updatedNodeRun?.nodeId ?? null, finishedAt: null, updatedAt: now })
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'failed')))
        .returning().all();
      return updatedNodeRun && updatedRun ? updatedNodeRun : null;
    });
    if (!retried) throw new BadRequestException('This node run cannot be retried.');
    await this.publish(runId, 'run.status', { status: 'queued' });
    this.schedule(runId);
    return this.get(request, workspaceSlug, runId);
  }

  private schedule(runId: string): void {
    setTimeout(() => { void this.execute(runId); }, 0);
  }

  private async execute(runId: string): Promise<void> {
    if (this.activeRuns.has(runId)) return;
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);
    try {
      const [pendingRun] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (!pendingRun || (pendingRun.status !== 'queued' && pendingRun.status !== 'waiting_for_input')) return;
      const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, pendingRun.workflowVersionId)).limit(1);
      if (!version) throw new Error('Workflow version not found');
      const definition = version.definition as StoredWorkflowDefinition | null;
      if (!definition || definition.schemaVersion !== 4 || !Array.isArray(definition.edges)) throw new Error('Workflow schema version 4 is required.');
      let state: WorkflowSchedulerState;
      if (pendingRun.executionState) {
        state = structuredClone(pendingRun.executionState) as WorkflowSchedulerState;
      } else {
        const [existingNodeRun] = await this.db.select({ id: workflowNodeRuns.id }).from(workflowNodeRuns).where(eq(workflowNodeRuns.runId, runId)).limit(1);
        if (existingNodeRun) throw new Error('Workflow run scheduler state is unavailable and cannot be reconstructed.');
        state = createWorkflowSchedulerState(definition);
      }
      const [run] = await this.db.update(workflowRuns)
        .set({ status: 'running', executionState: state as StoredWorkflowExecutionState, updatedAt: new Date() })
        .where(and(eq(workflowRuns.id, runId), inArray(workflowRuns.status, ['queued', 'waiting_for_input'])))
        .returning();
      if (!run) return;
      await this.publish(runId, 'run.status', { status: 'running' });

      while (true) {
        await this.assertActive(runId, abortController.signal);
        const active = state.active;
        const invocation = active ?? takeReadyArtifactInvocation(state, definition) ?? takeNextWorkflowInvocation(state);
        if (!invocation) break;
        const node = definition.nodes.find((candidate) => candidate.id === invocation.nodeId);
        if (!node) throw new Error('Workflow scheduler references an unavailable node.');

        const nodeRunId = active?.nodeRunId ?? `nrun_${randomUUID()}`;
        const position = active?.position ?? state.nextPosition + 1;
        let startedAt = new Date();
        if (!active) {
          state.nextPosition = position;
          state.active = { ...invocation, nodeRunId, position };
          await this.db.transaction((transaction) => {
            transaction.insert(workflowNodeRuns).values({ id: nodeRunId, runId, workspaceId: run.workspaceId, nodeId: node.id, position, type: node.type, typeVersion: node.typeVersion, status: 'running', input: sanitizeWorkflowImages(invocation.input), startedAt }).run();
            const [updatedRun] = transaction.update(workflowRuns).set({ currentNodeId: node.id, executionState: state as StoredWorkflowExecutionState, updatedAt: startedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning().all();
            if (!updatedRun) throw new RunCancelledError();
          });
        } else {
          const [existingNodeRun] = await this.db.select().from(workflowNodeRuns).where(eq(workflowNodeRuns.id, nodeRunId)).limit(1);
          if (!existingNodeRun) throw new Error('Workflow scheduler node run is unavailable.');
          startedAt = existingNodeRun.startedAt ?? startedAt;
          await this.db.transaction((transaction) => {
            const [updatedNodeRun] = transaction.update(workflowNodeRuns).set({ status: 'running', input: sanitizeWorkflowImages(invocation.input), error: null, finishedAt: null, startedAt }).where(and(eq(workflowNodeRuns.id, nodeRunId), inArray(workflowNodeRuns.status, ['queued', 'waiting_for_input']))).returning().all();
            const [updatedRun] = transaction.update(workflowRuns).set({ currentNodeId: node.id, executionState: state as StoredWorkflowExecutionState, updatedAt: startedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning().all();
            if (!updatedNodeRun || !updatedRun) throw new RunCancelledError();
          });
        }
        await this.publish(runId, 'node.started', { nodeId: node.id, nodeRunId, position, type: node.type });
        await this.publishActivity(runId, node.id, nodeRunId, {
          phase: 'node.setup',
          type: node.type,
          typeVersion: node.typeVersion,
          errorPolicy: node.errorPolicy,
          config: node.config,
          inputPorts: Object.keys(invocation.input),
        });

        const attempts = node.errorPolicy === 'retry' ? 2 : 1;
        let output: unknown;
        let artifactIds: string[] = [];
        let artifactToPersist: PreparedArtifactNode | null = null;
        let failure: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            await this.assertActive(runId, abortController.signal);
            if (attempt > 0) await this.db.update(workflowNodeRuns).set({ retryCount: sql`${workflowNodeRuns.retryCount} + 1` }).where(eq(workflowNodeRuns.id, nodeRunId));
            await this.publishActivity(runId, node.id, nodeRunId, { phase: 'node.attempt', attempt: attempt + 1, attempts, automaticRetry: attempt > 0 });
            const nodeType = this.registry.resolve(node.type, node.typeVersion);
            const request: NodeExecutionRequest = {
              input: invocation.input,
              config: node.config,
              context: {
                workflowId: run.workflowId,
                workflowRunId: runId,
                workflowVersionId: run.workflowVersionId,
                nodeId: node.id,
                nodeRunId,
                pendingActionId: `pending_${randomUUID()}`,
                workspaceId: run.workspaceId,
                variables: { workflowInput: run.input },
              },
              signal: abortController.signal,
            };
            const result = await nodeType.execute(request);
            if (result.status === 'waiting_for_input') {
              await this.suspendRun(run.workspaceId, runId, nodeRunId, node.id, result);
              return;
            }
            await this.assertActive(runId, abortController.signal);
            artifactToPersist = await this.prepareArtifactNode(run, node, result.output);
            output = artifactToPersist ? artifactToPersist.output : result.output;
            artifactIds = artifactToPersist ? artifactToPersist.items.map((artifact) => artifact.id) : [];
            failure = null;
            break;
          } catch (error) {
            failure = error;
            if (error instanceof RunCancelledError || abortController.signal.aborted) throw new RunCancelledError();
          }
        }
        if (failure) {
          const message = failure instanceof Error ? failure.message : 'Workflow node failed.';
          const [failedNodeRun] = await this.db.update(workflowNodeRuns).set({ status: 'failed', error: message, finishedAt: new Date() }).where(and(eq(workflowNodeRuns.id, nodeRunId), eq(workflowNodeRuns.status, 'running'))).returning();
          if (!failedNodeRun) throw new RunCancelledError();
          await this.publish(runId, 'node.failed', { nodeId: node.id, nodeRunId, error: message });
          throw new Error(message);
        }

        const outgoingEdges = definition.edges.filter((edge) => edge.sourceNodeId === node.id);
        const traversedEdges = commitWorkflowInvocation(definition, state, node.id, output);
        const traversedEdgeIds = new Set(traversedEdges.map((edge) => edge.id));
        if (outgoingEdges.length > 0) {
          await this.publishActivity(runId, node.id, nodeRunId, {
            phase: 'edge.decision',
            terminal: traversedEdges.length === 0,
            decisions: outgoingEdges.map((edge) => ({
              edgeId: edge.id,
              targetNodeId: edge.targetNodeId,
              targetPort: edge.targetPort,
              traversed: traversedEdgeIds.has(edge.id),
              condition: describeWorkflowEdgeCondition(edge.condition),
              traversals: state.edgeTraversals[edge.id] ?? 0,
              maxTraversals: edge.maxTraversals ?? null,
            })),
          });
        }
        delete state.active;
        const finishedAt = new Date();
        try {
          await this.db.transaction((transaction) => {
            if (artifactToPersist?.records.length) transaction.insert(artifacts).values(artifactToPersist.records).run();
            const [updatedNodeRun] = transaction.update(workflowNodeRuns).set({ status: 'succeeded', output: sanitizeWorkflowImages(output), artifactIds, finishedAt }).where(and(eq(workflowNodeRuns.id, nodeRunId), eq(workflowNodeRuns.status, 'running'))).returning().all();
            const [updatedRun] = transaction.update(workflowRuns).set({ executionState: state as StoredWorkflowExecutionState, updatedAt: finishedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning().all();
            if (!updatedNodeRun || !updatedRun) throw new RunCancelledError();
          });
        } catch (error) {
          if (artifactToPersist?.storageKeys.length) await Promise.allSettled(artifactToPersist.storageKeys.map((key) => this.artifactStorage.remove(key)));
          throw error;
        }
        for (const artifact of artifactToPersist?.items ?? []) {
          await this.publish(runId, 'artifact.created', { artifactId: artifact.id, nodeId: node.id, name: artifact.name, format: artifact.format });
        }
        await this.publish(runId, 'node.completed', { nodeId: node.id, nodeRunId, output: sanitizeWorkflowImages(output), artifactIds });
      }

      const result = workflowRunResult(state);
      const sanitizedResult = sanitizeWorkflowImages(result);
      const finishedAt = new Date();
      const [succeededRun] = await this.db.update(workflowRuns).set({ status: 'succeeded', result: sanitizedResult, executionState: state as StoredWorkflowExecutionState, currentNodeId: null, updatedAt: finishedAt, finishedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning();
      if (!succeededRun) return;
      await this.publish(runId, 'run.status', { status: 'succeeded', result: sanitizedResult });
    } catch (error) {
      if (error instanceof RunCancelledError) return;
      const [current] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (current?.status === 'cancelled' || current?.status === 'paused') return;
      const message = error instanceof Error ? error.message : 'Workflow execution failed.';
      const failedAt = new Date();
      const failedRun = await this.db.transaction((transaction) => {
        const [updatedRun] = transaction.update(workflowRuns).set({ status: 'failed', result: { message }, currentNodeId: null, updatedAt: failedAt, finishedAt: failedAt }).where(and(eq(workflowRuns.id, runId), inArray(workflowRuns.status, ['queued', 'running', 'waiting_for_input']))).returning().all();
        if (!updatedRun) return null;
        transaction.update(workflowNodeRuns).set({ status: 'failed', error: message, finishedAt: failedAt }).where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.status, 'running'))).run();
        return updatedRun;
      });
      if (!failedRun) return;
      await this.publish(runId, 'run.status', { status: 'failed', error: message });
    } finally {
      if (this.activeRuns.get(runId) === abortController) {
        this.activeRuns.delete(runId);
        await this.resumeQueuedAfterPause(runId);
      }
    }
  }

  private async resumeQueuedAfterPause(runId: string): Promise<void> {
    const [current] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (current?.status === 'queued') this.schedule(runId);
  }

  private async assertActive(runId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new RunCancelledError();
    const [run] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run || run.status !== 'running') throw new RunCancelledError();
  }

  private async suspendRun(workspaceId: string, runId: string, nodeRunId: string, nodeId: string, result: PendingNodeExecutionResult): Promise<void> {
    const now = new Date();
    const action = result.pendingAction;
    const [currentRun] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    const [currentNodeRun] = await this.db.select({ status: workflowNodeRuns.status }).from(workflowNodeRuns).where(eq(workflowNodeRuns.id, nodeRunId)).limit(1);
    if (currentRun?.status !== 'running' || currentNodeRun?.status !== 'running') {
      await this.wechatOfficialAccount.cancel(action.id);
      this.pendingCompletions.delete(action.id);
      return;
    }
    try {
      await this.db.transaction((transaction) => {
        transaction.insert(workflowPendingActions).values({ id: action.id, workspaceId, runId, nodeRunId, type: action.type, status: 'pending', title: action.title, description: action.description, qrCode: action.qrCode, expiresAt: action.expiresAt, externalOperationId: action.externalOperationId ?? null }).run();
        const [updatedNodeRun] = transaction.update(workflowNodeRuns).set({ status: 'waiting_for_input', error: null }).where(and(eq(workflowNodeRuns.id, nodeRunId), eq(workflowNodeRuns.status, 'running'))).returning().all();
        const [updatedRun] = transaction.update(workflowRuns).set({ status: 'waiting_for_input', currentNodeId: nodeId, updatedAt: now }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning().all();
        if (!updatedNodeRun || !updatedRun) throw new RunCancelledError();
      });
    } catch (error) {
      await this.wechatOfficialAccount.cancel(action.id);
      await this.db.update(workflowPendingActions).set({ status: 'cancelled', qrCode: null, updatedAt: new Date() }).where(and(eq(workflowPendingActions.id, action.id), eq(workflowPendingActions.status, 'pending')));
      this.pendingCompletions.delete(action.id);
      if (error instanceof RunCancelledError) return;
      throw error;
    }
    await this.publish(runId, 'node.waiting', { nodeId, nodeRunId, actionId: action.id, type: action.type });
    await this.publish(runId, 'run.status', { status: 'waiting_for_input', actionId: action.id });
    await this.flushCompletedActions();
  }

  private queueCompletedAction(actionId: string): void {
    if (!actionId.startsWith('pending_')) return;
    this.pendingCompletions.add(actionId);
    if (!this.completionFlush) this.completionFlush = this.flushCompletedActions().finally(() => { this.completionFlush = null; });
  }

  private async flushCompletedActions(): Promise<void> {
    while (this.pendingCompletions.size > 0) {
      const [actionId] = this.pendingCompletions;
      if (!await this.completePendingAction(actionId)) break;
      this.pendingCompletions.delete(actionId);
    }
  }

  private async completePendingAction(actionId: string): Promise<boolean> {
    const [action] = await this.db.select().from(workflowPendingActions).where(eq(workflowPendingActions.id, actionId)).limit(1);
    if (!action) return false;
    if (action.status !== 'pending') return true;
    const now = new Date();
    try {
      await this.db.transaction((transaction) => {
        const [updatedNodeRun] = transaction.update(workflowNodeRuns).set({ status: 'queued' }).where(and(eq(workflowNodeRuns.id, action.nodeRunId), eq(workflowNodeRuns.status, 'waiting_for_input'))).returning().all();
        const [updatedRun] = transaction.update(workflowRuns).set({ status: 'queued', updatedAt: now }).where(and(eq(workflowRuns.id, action.runId), eq(workflowRuns.status, 'waiting_for_input'))).returning().all();
        const [updatedAction] = transaction.update(workflowPendingActions).set({ status: 'completed', qrCode: null, updatedAt: now }).where(and(eq(workflowPendingActions.id, actionId), eq(workflowPendingActions.status, 'pending'))).returning().all();
        if (!updatedNodeRun || !updatedRun || !updatedAction) throw new RunCancelledError();
      });
    } catch (error) {
      if (error instanceof RunCancelledError) return true;
      throw error;
    }
    await this.publish(action.runId, 'pending_action.updated', { actionId, status: 'completed' });
    this.schedule(action.runId);
    return true;
  }

  private async prepareArtifactNode(run: typeof workflowRuns.$inferSelect, node: StoredWorkflowNode, output: unknown): Promise<PreparedArtifactNode | null> {
    if (node.type !== 'worklite/artifact') return null;
    const config = asRecord(node.config);
    if (!config || typeof config.name !== 'string' || !config.name.trim()) throw new Error('Artifact node requires a name.');
    const formatOverride = config.format ?? config.type;
    if (formatOverride !== undefined && formatOverride !== 'text' && formatOverride !== 'markdown' && formatOverride !== 'json' && formatOverride !== 'image') {
      throw new Error('Artifact format override must be text, markdown, json, or image.');
    }
    const name = config.name.trim();
    const images = collectGeneratedWorkflowImages(output);
    const inferredFormat = inferArtifactFormat(output, images.length > 0);
    const format = formatOverride ?? inferredFormat;
    const configuredPlacement = config.placement ?? config.imageRole;
    if (configuredPlacement !== undefined && configuredPlacement !== 'inline' && configuredPlacement !== 'asset') throw new Error('Artifact placement must be inline or asset.');
    if (configuredPlacement !== undefined && format !== 'image') throw new Error('Artifact placement can only be used with the image format.');
    if (format !== 'image') {
      if (images.length > 0) throw new Error('Generated PNG input requires the Artifact format to be image.');
      const content = typeof output === 'string' ? output : JSON.stringify(output ?? '');
      const id = `art_${randomUUID()}`;
      const record: typeof artifacts.$inferInsert = { id, workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, name, format, placement: null, size: `${Buffer.byteLength(content, 'utf8')} B`, content };
      return { records: [record], items: [{ id, name, format }], storageKeys: [], output: { type: 'artifact', artifactId: id, name, format } };
    }

    if (images.length === 0) throw new Error('Artifact format image requires at least one generated PNG image as input.');
    const placement: 'inline' | 'asset' = configuredPlacement === 'asset' ? 'asset' : 'inline';
    let nextImagePosition: number | null = null;
    if (placement === 'inline') {
      const [positionRow] = await this.db.select({ maxPosition: sql<number>`coalesce(max(${artifacts.imagePosition}), 0)` })
        .from(artifacts)
        .where(and(eq(artifacts.runId, run.id), eq(artifacts.format, 'image'), sql`coalesce(${artifacts.placement}, 'inline') = 'inline'`));
      nextImagePosition = Number(positionRow?.maxPosition ?? 0) + 1;
    }
    const records: Array<typeof artifacts.$inferInsert> = [];
    const items: PreparedArtifactItem[] = [];
    const storageKeys: string[] = [];
    try {
      for (const image of images) {
        for (const imageData of image.data) {
          const encoded = imageData.b64Json;
          if (encoded.length > 45_000_000) throw new Error('Artifact PNG input must be no larger than 32 MB.');
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Artifact PNG input contains invalid base64 data.');
          const content = Buffer.from(encoded, 'base64');
          if (content.byteLength === 0 || content.byteLength > 32 * 1024 * 1024 || content.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
            throw new Error('Artifact image format requires valid PNG data no larger than 32 MB.');
          }
          const dimensions = pngDimensions(content);
          const id = `art_${randomUUID()}`;
          const objectKey = await this.artifactStorage.writePng(id, content);
          storageKeys.push(objectKey);
          const itemName = images.length === 1 && image.data.length === 1 ? name : `${name} ${items.length + 1}`;
          const imageKey = image.data.length === 1 && typeof image.key === 'string' && image.key.trim() ? image.key.trim() : null;
          const imagePosition = nextImagePosition === null ? null : nextImagePosition++;
          records.push({
            id,
            workspaceId: run.workspaceId,
            workflowId: run.workflowId,
            runId: run.id,
            name: itemName,
            format: 'image',
            size: `${content.byteLength} B`,
            content: '',
            objectKey,
            mimeType: image.mediaType,
            width: dimensions.width,
            height: dimensions.height,
            sizeBytes: content.byteLength,
            imageKey,
            imagePosition,
            placement,
          });
          items.push({ id, name: itemName, format: 'image' });
        }
      }
    } catch (error) {
      await Promise.allSettled(storageKeys.map((key) => this.artifactStorage.remove(key)));
      throw error;
    }

    const artifactIds = items.map((artifact) => artifact.id);
    return {
      records,
      items,
      storageKeys,
      output: { type: 'artifact', artifactId: artifactIds[0], artifactIds, name, format: 'image', imageCount: artifactIds.length },
    };
  }

  private async toView(run: typeof workflowRuns.$inferSelect, workflow: typeof workflows.$inferSelect, version: typeof workflowVersions.$inferSelect, workspaceSlug: string, initiator: string, details: boolean): Promise<RunView> {
    const end = run.finishedAt?.getTime() ?? (run.status === 'queued' ? null : Date.now());
    const definition = version.definition as StoredWorkflowDefinition | null;
    const hasArtifactNode = Boolean(definition?.nodes.some((node) => node.type === 'worklite/artifact'));
    const view: RunView = { id: run.id, workspaceSlug, workflowId: workflow.id, workflowName: workflow.name, version: `v${version.version}`, status: run.status, currentStep: run.currentNodeId, startedAt: run.createdAt.toISOString(), durationSeconds: end === null ? null : Math.max(0, Math.round((end - run.createdAt.getTime()) / 1000)), initiator, input: sanitizeWorkflowImages(run.input), result: sanitizeWorkflowImages(run.result), hasArtifactNode, resumable: runResumable(run) };
    if (!details) return view;
    const nodeRows = await this.db.select().from(workflowNodeRuns).where(eq(workflowNodeRuns.runId, run.id)).orderBy(asc(workflowNodeRuns.position));
    const artifactRows = await this.db.select().from(artifacts).where(eq(artifacts.runId, run.id)).orderBy(asc(artifacts.createdAt));
    const retryableNodeRunId = retryableNodeRunIdOf(run);
    const eventRows = await this.db.select().from(workflowRunEvents)
      .where(and(eq(workflowRunEvents.runId, run.id), inArray(workflowRunEvents.type, ['node.activity', 'node.delta'])))
      .orderBy(asc(workflowRunEvents.sequence));
    const activityByNodeRun = new Map<string, WorkflowNodeActivityView[]>();
    const streamedByNodeRun = new Map<string, string>();
    for (const row of eventRows) {
      const payload = asRecord(row.payload);
      const nodeRunId = typeof payload?.nodeRunId === 'string' ? payload.nodeRunId : null;
      if (!nodeRunId) continue;
      if (row.type === 'node.delta') {
        const delta = typeof payload?.delta === 'string' ? payload.delta : '';
        if (delta) streamedByNodeRun.set(nodeRunId, (streamedByNodeRun.get(nodeRunId) ?? '') + delta);
        continue;
      }
      const activity = activityByNodeRun.get(nodeRunId) ?? [];
      activity.push({
        nodeId: typeof payload?.nodeId === 'string' ? payload.nodeId : '',
        nodeRunId,
        phase: payload?.phase as WorkflowNodeActivityView['phase'],
        detail: payload?.detail as WorkflowNodeActivityView['detail'],
        sequence: row.sequence,
        occurredAt: row.createdAt.toISOString(),
      });
      activityByNodeRun.set(nodeRunId, activity);
    }
    view.nodeRuns = nodeRows.map((row) => toNodeRunView(row, row.id === retryableNodeRunId, activityByNodeRun.get(row.id) ?? [], streamedByNodeRun.get(row.id) ?? null));
    view.artifacts = artifactRows.map((artifact) => toArtifactView(artifact, workspaceSlug, workflow.name));
    const [pendingAction] = await this.db.select().from(workflowPendingActions).where(and(eq(workflowPendingActions.runId, run.id), inArray(workflowPendingActions.status, ['pending', 'expired']))).orderBy(desc(workflowPendingActions.createdAt)).limit(1);
    view.pendingAction = pendingAction ? toPendingActionView(pendingAction) : null;
    return view;
  }

  private async publishActivity(runId: string, nodeId: string, nodeRunId: string, detail: WorkflowNodeActivityDetail): Promise<void> {
    const payload: WorkflowNodeActivityEventPayload = { nodeId, nodeRunId, phase: detail.phase, detail };
    await this.publish(runId, 'node.activity', payload);
  }

  private async publish(runId: string, type: RunProgressEvent['type'], payload: unknown): Promise<void> {
    if (type === 'node.delta') {
      this.bufferDelta(runId, payload);
      return;
    }
    // A non-delta event must not overtake text that was streamed before it.
    this.flushDeltaBuffers(runId);
    await this.persistEvent(runId, type, payload);
  }

  private bufferDelta(runId: string, payload: unknown): void {
    const record = asRecord(payload);
    const nodeRunId = typeof record?.nodeRunId === 'string' ? record.nodeRunId : null;
    const delta = typeof record?.delta === 'string' ? record.delta : '';
    if (!nodeRunId || !delta) return;
    const key = `${runId}:${nodeRunId}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) {
      existing.text += delta;
      if (existing.text.length >= DELTA_FLUSH_CHARS) this.flushDelta(key);
      return;
    }
    const timer = setTimeout(() => this.flushDelta(key), DELTA_FLUSH_MS);
    timer.unref();
    this.deltaBuffers.set(key, {
      nodeId: typeof record?.nodeId === 'string' ? record.nodeId : '',
      nodeRunId,
      text: delta,
      timer,
    });
  }

  private flushDelta(key: string): void {
    const buffer = this.deltaBuffers.get(key);
    if (!buffer) return;
    this.deltaBuffers.delete(key);
    clearTimeout(buffer.timer);
    void this.persistEvent(key.slice(0, key.indexOf(':')), 'node.delta', { nodeId: buffer.nodeId, nodeRunId: buffer.nodeRunId, delta: buffer.text });
  }

  private flushDeltaBuffers(runId: string): void {
    for (const key of [...this.deltaBuffers.keys()]) {
      if (key.startsWith(`${runId}:`)) this.flushDelta(key);
    }
  }

  private async persistEvent(runId: string, type: RunProgressEvent['type'], payload: unknown): Promise<void> {
    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const [row] = await this.db.insert(workflowRunEvents).values({ runId, sequence: sql<number>`coalesce((select max(sequence) from workflow_run_events where run_id = ${runId}), 0) + 1`, type, payload: sanitizeWorkflowImages(payload) }).returning();
      if (!row) return;
      const event: RunProgressEvent = { runId: row.runId, sequence: row.sequence, type: row.type, payload: sanitizeWorkflowImages(row.payload), occurredAt: row.createdAt.toISOString() };
      for (const listener of this.listeners) listener(event);
    });
    this.eventQueues.set(runId, next);
    try {
      await next;
    } finally {
      if (this.eventQueues.get(runId) === next) this.eventQueues.delete(runId);
    }
  }
}

function parseWorkflowAgentJson(value: string): unknown {
  const raw = value.trim().replace(/^\uFEFF/, '');
  const fenced = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  const candidate = fenced?.[1] ?? raw;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error('Agent node JSON output requires valid JSON.');
  }
}

export type SkillScriptCallRecord = { skillId: string; skillName: string; exitCode: number | null; status: 'succeeded' | 'failed'; failureReason?: string };

const MODEL_REPLY_EXCERPT_MAX_CHARS = 500;

/**
 * Keeps a JSON-output failure actionable: the node error carries a bounded,
 * whitespace-collapsed excerpt of what the model actually said. Other errors
 * pass through unchanged.
 */
export function workflowAgentFailure(error: unknown): unknown {
  const isJsonOutputError = error instanceof AgentJsonOutputError
    || (error instanceof Error && error.name === 'AgentJsonOutputError' && typeof (error as { output?: unknown }).output === 'string');
  if (!isJsonOutputError) return error;
  const reply = (error as AgentJsonOutputError).output.replace(/\s+/g, ' ').trim();
  if (!reply) return error;
  const excerpt = reply.length > MODEL_REPLY_EXCERPT_MAX_CHARS ? `${reply.slice(0, MODEL_REPLY_EXCERPT_MAX_CHARS)}…` : reply;
  return new Error(`${(error as Error).message} Model reply: ${excerpt}`, { cause: error });
}

/**
 * Fails an Agent node unless every required Skill has at least one script call
 * that succeeded: the process exited 0 and its output did not report `ok: false`.
 * A failed call followed by a successful retry passes; a successful call that
 * found no relevant results also passes, because the script itself decides that
 * outcome.
 */
export function assertRequiredSkillScriptCalls(requiredSkillIds: readonly string[], calls: readonly SkillScriptCallRecord[]): void {
  const missing = requiredSkillIds.filter((skillId) => !calls.some((call) => call.skillId === skillId && call.status === 'succeeded'));
  if (missing.length === 0) return;
  const reasons = missing.map((skillId) => {
    const attempts = calls.filter((call) => call.skillId === skillId);
    const last = attempts.at(-1);
    const label = last?.skillName || skillId;
    return last
      ? `Required research Skill ${label} has no successful script call (last exit code ${last.exitCode ?? 'unknown'}${last.failureReason ? `: ${last.failureReason}` : ''}).`
      : `Required research Skill ${label} has no successful script call.`;
  });
  throw new Error(reasons.join(' '));
}

// Valid JSON is not the same thing as the node's intended result. Without a declared contract an
// Agent could commit a progress note or a raw tool-call object, and every downstream node would
// consume it as though the node had produced its evidence.
function assertWorkflowAgentOutputContract(output: unknown, contract: unknown, allowEmptyOutputKeys?: unknown): void {
  if (!Array.isArray(contract) || contract.length === 0) return;
  const keys = contract.filter((key): key is string => typeof key === 'string' && key.trim().length > 0);
  if (keys.length === 0) return;
  const emptyAllowed = new Set(Array.isArray(allowEmptyOutputKeys)
    ? allowEmptyOutputKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    : []);
  const record = asRecord(output);
  if (!record) throw new Error(`Agent node JSON output requires an object containing ${keys.join(', ')}.`);
  const missing = keys.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return true;
    const value = record[key];
    if (value === null || value === undefined) return true;
    if (typeof value === 'string' && value.trim().length === 0) return true;
    return Array.isArray(value) && value.length === 0 && !emptyAllowed.has(key);
  });
  if (missing.length > 0) throw new Error(`Agent node JSON output is missing required keys: ${missing.join(', ')}.`);
}

function rankSystemOneMapResults(entries: Record<string, unknown>[], rank: unknown): Record<string, unknown>[] {
  const config = asRecord(rank);
  if (!config || typeof config.path !== 'string' || !config.path.trim()) return entries;
  const path = config.path.trim();
  const score = (entry: Record<string, unknown>): number | null => {
    const value = readWorkflowOutputPath(entry, path).value;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  // Ranking is deterministic selection applied after evaluation, never a second model judgement.
  // An element whose answer path holds no number cannot be compared with a threshold, so a
  // configured minimum drops it instead of letting it survive as though it had scored.
  const minimum = typeof config.minimum === 'number' && Number.isFinite(config.minimum) ? config.minimum : null;
  const kept = minimum === null ? [...entries] : entries.filter((entry) => {
    const value = score(entry);
    return value !== null && value >= minimum;
  });
  const descending = config.order !== 'asc';
  const ordered = kept
    .map((entry, index) => ({ entry, index, value: score(entry) }))
    .sort((left, right) => {
      if (left.value === null && right.value === null) return left.index - right.index;
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      if (left.value === right.value) return left.index - right.index;
      return descending ? right.value - left.value : left.value - right.value;
    })
    .map((item) => item.entry);
  const limit = typeof config.limit === 'number' && Number.isInteger(config.limit) && config.limit > 0 ? config.limit : null;
  return limit === null ? ordered : ordered.slice(0, limit);
}

// Every Gateway call a node makes is charged to the Workflow surface with the same
// three identifiers, so a Workflow node never has to assemble this itself.
function workflowCorrelation(context: NodeExecutionContext): GatewayCorrelation {
  return {
    surface: 'workflow',
    workflowId: context.workflowId,
    workflowRunId: context.workflowRunId,
    nodeRunId: context.nodeRunId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function inferArtifactFormat(output: unknown, hasGeneratedImages: boolean): 'text' | 'json' | 'image' {
  if (hasGeneratedImages) return 'image';
  if (output === null || output === undefined) return 'text';
  if (typeof output === 'string') {
    try {
      JSON.parse(output);
      return 'json';
    } catch {
      return 'text';
    }
  }
  return typeof output === 'object' || typeof output === 'number' || typeof output === 'boolean' ? 'json' : 'text';
}

// An Agent node's model configuration is one public model id, or an ordered list of fallback
// candidates; a historical row only ever holds a single string.
function modelOrList(value: unknown): string | string[] | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string')) return value as string[];
  return null;
}

function describeWorkflowEdgeCondition(condition: StoredWorkflowEdge['condition']): string {
  if (!condition) return 'unconditional';
  if (condition.kind === 'fallback') return 'fallback';
  const target = condition.path.trim() || '$';
  if (condition.value === undefined) return `${target} ${condition.operator}`;
  return `${target} ${condition.operator} ${JSON.stringify(condition.value)}`;
}

type GeneratedWorkflowImage = {
  type: 'workflow_image';
  model: string;
  mediaType: 'image/png';
  width?: number;
  height?: number;
  key?: string;
  data: Array<{ b64Json: string }>;
};

function takeReadyArtifactInvocation(state: WorkflowSchedulerState, definition: StoredWorkflowDefinition) {
  const artifactNodeIds = new Set(definition.nodes.filter((node) => node.type === 'worklite/artifact').map((node) => node.id));
  const index = state.ready.findIndex((invocation) => artifactNodeIds.has(invocation.nodeId));
  return index < 0 ? undefined : state.ready.splice(index, 1)[0];
}

function isGeneratedWorkflowImage(value: unknown): value is GeneratedWorkflowImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'workflow_image'
    && typeof record.model === 'string'
    && record.mediaType === 'image/png'
    && Array.isArray(record.data)
    && record.data.length > 0
    && record.data.every((item) => Boolean(item)
      && typeof item === 'object'
      && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).b64Json === 'string');
}

function collectGeneratedWorkflowImages(value: unknown): GeneratedWorkflowImage[] {
  const images: GeneratedWorkflowImage[] = [];
  const visit = (current: unknown): void => {
    if (isGeneratedWorkflowImage(current)) {
      images.push(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    const record = asRecord(current);
    if (record) Object.values(record).forEach(visit);
  };
  visit(value);
  return images;
}

function pngDimensions(content: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (content.byteLength < 24 || !content.subarray(0, 8).equals(signature)) throw new Error('Artifact image format requires PNG data.');
  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error('Artifact image format has invalid PNG dimensions.');
  return { width, height };
}

function sanitizeWorkflowImages<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sanitizeWorkflowImages(item)) as T;
  if (isGeneratedWorkflowImage(value)) return {
    type: 'workflow_image_summary',
    model: value.model,
    mediaType: value.mediaType,
    imageCount: value.data.length,
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(typeof value.height === 'number' ? { height: value.height } : {}),
    ...(typeof value.key === 'string' ? { key: value.key } : {}),
  } as T;
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = sanitizeWorkflowImages(item);
  return output as T;
}

function toNodeRunView(row: typeof workflowNodeRuns.$inferSelect, retryable: boolean, activity: WorkflowNodeActivityView[] = [], streamedOutput: string | null = null): WorkflowNodeRunView {
  return { id: row.id, runId: row.runId, nodeId: row.nodeId, position: row.position, type: row.type, typeVersion: row.typeVersion, status: row.status, input: sanitizeWorkflowImages(row.input), output: sanitizeWorkflowImages(row.output), artifactIds: row.artifactIds ?? [], error: row.error, retryCount: row.retryCount, retryable, startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, streamedOutput, activity };
}

function retryableNodeRunIdOf(run: typeof workflowRuns.$inferSelect): string | null {
  return run.status === 'failed' ? run.executionState?.active?.nodeRunId ?? null : null;
}

function runResumable(run: typeof workflowRuns.$inferSelect): boolean {
  return run.status === 'paused' || (run.status === 'cancelled' && run.executionState !== null);
}

function toArtifactView(row: typeof artifacts.$inferSelect, workspaceSlug: string, workflowName: string): ArtifactView {
  return {
    id: row.id,
    workspaceSlug,
    name: row.name,
    format: row.format,
    placement: row.placement,
    workflowId: row.workflowId ?? null,
    workflowName,
    runId: row.runId ?? '',
    size: row.size,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    contentUrl: row.format === 'image' && row.objectKey ? `/api/artifacts/${encodeURIComponent(row.id)}/content` : null,
    createdAt: row.createdAt?.toISOString() ?? '',
    content: row.content,
  };
}

function toPendingActionView(row: typeof workflowPendingActions.$inferSelect): WorkflowPendingActionView {
  const expired = row.status === 'expired' || (row.status === 'pending' && Boolean(row.expiresAt && row.expiresAt.getTime() <= Date.now()));
  return { id: row.id, runId: row.runId, nodeRunId: row.nodeRunId, type: row.type, status: expired ? 'expired' : row.status, title: row.title, description: row.description, qrCode: expired ? null : row.qrCode, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() };
}
