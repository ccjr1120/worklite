import { WechatDraftRevisionService } from '../connections/wechat-draft-revision.service';
import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { Lexer } from 'marked';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { agentPublications, agentToolCalls, artifacts, auditLogs, type Database, type StoredWorkflowNode } from '@worklite/db';
import { NodeTypeRegistry, resolveWorkflowNodeCapability, readWorkflowOutputPath, composeWorkflowArticle } from '@worklite/workflow-engine';
import { AgentJsonOutputError } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { WechatOfficialAccountService } from '../connections/wechat-official-account.service';
import { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import { ArtifactStorageService } from '../artifacts/artifact-storage.service';
import { renderCanvasSticker, validateCanvasStickerConfig } from '../runs/canvas-sticker';
import { renderCanvasScript, validateCanvasRenderCode, validateCanvasRenderConfig } from '../runs/canvas-render';
import { LocalProjectsService } from '../local-projects/local-projects.service';

/** Individual tools selected by an Agent; this service has no graph scheduler or Workflow Run. */
@Injectable()
export class AgentCapabilitiesService {
  private readonly registry = new NodeTypeRegistry();
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly wechatOfficialAccount: WechatOfficialAccountService, private readonly gateway: PortkeyGatewayService, private readonly artifactStorage: ArtifactStorageService, private readonly draftRevisions?: WechatDraftRevisionService, private readonly localProjects?: LocalProjectsService) {
    const capability = (id: string, version = '1') => {
      const value = resolveWorkflowNodeCapability(id, version);
      if (!value) throw new Error('Agent capability is unavailable: ' + id + '@' + version);
      return value;
    };
    this.registry.register({
      ...capability('worklite/local-project-search'),
      execute: async ({ input }) => {
        if (!this.localProjects) throw new Error('Local project search service is unavailable.');
        return { output: await this.localProjects.searchForAgent(input) };
      },
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
          correlation: capabilityCorrelation(request.context),
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
              correlation: capabilityCorrelation(request.context),
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
          correlation: capabilityCorrelation(request.context),
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
  }

async execute(workspaceId: string, executionId: string, callId: string, capability: { id: string; type: string; typeVersion: string; config: Record<string, unknown> }, input: unknown, signal: AbortSignal): Promise<unknown> {
    const operation = asRecord(input)?.operation;
    if (capability.type === 'wechat-official-account/publish' && typeof operation === 'string') {
      const args = asRecord(input)!;
      if (operation === 'list') return this.db.select({ id: agentPublications.id, runId: agentPublications.runId, draftId: agentPublications.draftId, title: agentPublications.title, status: agentPublications.status }).from(agentPublications).where(eq(agentPublications.workspaceId, workspaceId)).orderBy(desc(agentPublications.createdAt)).limit(50).all();
      const runId = typeof args.runId === 'string' ? args.runId : '';
      const draftId = typeof args.draftId === 'string' ? args.draftId : '';
      const publication = runId && draftId ? this.db.select().from(agentPublications).where(and(eq(agentPublications.workspaceId, workspaceId), eq(agentPublications.runId, runId), eq(agentPublications.draftId, draftId))).get() : undefined;
      if (operation !== 'publish' && !publication) throw new BadRequestException('Select a recorded Agent article using runId and draftId from operation list.');
      if (operation === 'publish') {
        if (args.mode !== 'draft' && args.mode !== 'publish') throw new BadRequestException('Select mode draft or publish explicitly.');
        const article = typeof args.article === 'string' ? args.article : publication?.article;
        if (!article) throw new BadRequestException('Provide the article to publish.');
        const images = args.images ?? (publication && this.draftRevisions ? await this.draftRevisions.publicationImages(runId, draftId, args.imageReplacements) : undefined);
        const coverImage = args.coverImage ?? (publication && images && this.draftRevisions ? await this.draftRevisions.publicationCover(runId, draftId) : undefined);
        // A fresh call creates a new publication. Existing published posts are never silently edited.
        return this.execute(workspaceId, executionId, callId, { ...capability, typeVersion: images || coverImage ? '2' : '1', config: { ...capability.config, mode: args.mode } }, { article, metadata: args.metadata ?? publication?.metadata ?? {}, images, coverImage }, signal);
      }
      if (!this.draftRevisions) throw new BadRequestException('Article editing tools are unavailable.');
      switch (operation) {
        case 'inspect': return { ...await this.draftRevisions.inspect(runId, draftId), article: publication!.article, metadata: publication!.metadata };
        case 'render_image': return this.draftRevisions.renderImage(runId, draftId, args);
        case 'revise': return this.draftRevisions.revise(runId, draftId, args);
        case 'verify': return this.draftRevisions.verify(runId, draftId);
        default: throw new BadRequestException('Unknown WeChat article operation.');
      }
    }
    if (['worklite/agent', 'worklite/map', 'worklite/input', 'worklite/timer', 'worklite/branch', 'worklite/join', 'worklite/dashboard'].includes(capability.type)) throw new BadRequestException('Control-flow nodes are unavailable to Agents.');
    const nodeType = this.registry.resolve(capability.type, capability.typeVersion);
    const ownerCall = this.db.select({ input: agentToolCalls.input }).from(agentToolCalls).where(and(eq(agentToolCalls.id, callId), eq(agentToolCalls.workspaceId, workspaceId), eq(agentToolCalls.executionId, executionId))).get();
    const result = await nodeType.execute({ input, config: capability.config, signal, context: {
      workspaceId, workflowId: '', workflowVersionId: '', workflowRunId: executionId,
      nodeId: capability.id, nodeRunId: callId, pendingActionId: `apa_${callId}`, variables: { workflowInput: input, agentRunId: asRecord(ownerCall?.input)?.__agentRunId ?? executionId },
    } });
    if (result.status === 'waiting_for_input') return result;
    if (capability.type === 'worklite/artifact') {
      const prepared = await this.prepareArtifactNode({ id: null, workspaceId, workflowId: null }, { ...capability, position: { x: 0, y: 0 }, errorPolicy: 'stop' }, result.output);
      if (!prepared) throw new Error('Artifact could not be prepared.');
      try {
        this.db.transaction((tx) => { for (const value of prepared.records) tx.insert(artifacts).values(value).run(); });
      } catch (error) {
        await Promise.allSettled(prepared.storageKeys.map((key) => this.artifactStorage.remove(key)));
        throw error;
      }
      return prepared.output;
    }
    if (['worklite/image', 'worklite/canvas-render', 'worklite/compose-article'].includes(capability.type)) {
      const saved = await this.execute(workspaceId, executionId, `${callId}_artifact`, { id: `${capability.id}_artifact`, type: 'worklite/artifact', typeVersion: '1', config: { name: typeof capability.config.label === 'string' ? capability.config.label : capability.type } }, { data: result.output }, signal);
      const call = this.db.select({ input: agentToolCalls.input }).from(agentToolCalls).where(eq(agentToolCalls.id, callId)).get();
      this.db.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'agent.artifact', resource: executionId, metadata: { invocationId: asRecord(call?.input)?.__agentRunId, artifacts: saved } }).run();
      return result.output;
    }
    return result.output;
  }

private async prepareArtifactNode(run: { id: string | null; workspaceId: string; workflowId: string | null }, node: StoredWorkflowNode, output: unknown): Promise<PreparedArtifactNode | null> {
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
        .where(and((run.id ? eq(artifacts.runId, run.id) : sql`0 = 1`), eq(artifacts.format, 'image'), sql`coalesce(${artifacts.placement}, 'inline') = 'inline'`));
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
}

const MODEL_REPLY_EXCERPT_MAX_CHARS = 500;

type PreparedArtifactItem = { id: string; name: string; format: 'text' | 'markdown' | 'json' | 'image' };

type PreparedArtifactNode = {
  records: Array<typeof artifacts.$inferInsert>;
  items: PreparedArtifactItem[];
  storageKeys: string[];
  output: unknown;
};

export type SkillScriptCallRecord = { skillId: string; skillName: string; exitCode: number | null; status: 'succeeded' | 'failed'; failureReason?: string };

export function workflowAgentFailure(error: unknown): unknown {
  const isJsonOutputError = error instanceof AgentJsonOutputError
    || (error instanceof Error && error.name === 'AgentJsonOutputError' && typeof (error as { output?: unknown }).output === 'string');
  if (!isJsonOutputError) return error;
  const reply = (error as AgentJsonOutputError).output.replace(/\s+/g, ' ').trim();
  if (!reply) return error;
  const excerpt = reply.length > MODEL_REPLY_EXCERPT_MAX_CHARS ? `${reply.slice(0, MODEL_REPLY_EXCERPT_MAX_CHARS)}…` : reply;
  return new Error(`${(error as Error).message} Model reply: ${excerpt}`, { cause: error });
}

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

export function assertWorkflowAgentOutputContract(output: unknown, contract: unknown, allowEmptyOutputKeys?: unknown): void {
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

type GeneratedWorkflowImage = {
  type: 'workflow_image';
  model: string;
  mediaType: 'image/png';
  width?: number;
  height?: number;
  key?: string;
  data: Array<{ b64Json: string }>;
};

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

function capabilityCorrelation(context: { workflowRunId: string; variables: Readonly<Record<string, unknown>> }) {
  return { surface: 'agent' as const, agentExecutionId: context.workflowRunId,
    agentRunId: typeof context.variables.agentRunId === 'string' ? context.variables.agentRunId : context.workflowRunId };
}
