import { BadRequestException, Injectable } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import type { StoredProjectExecutor, StoredProjectExecutorLaunch } from '@worklite/db';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { ClaudeCodeService } from './claude-code.service';
import { CodexAppServerService } from './codex-app-server.service';
import { PROJECT_EXECUTOR_PROTOCOLS, isGatewayPublicModel, type AgentRuntimeCapabilities, type PreparedProjectExecution, type ProjectExecutorRequest, type ProjectExecutorSkill } from './project-executor.types';

// Chat project tasks and the executor developer role share this boundary. Executors run natively in the project
// directory; Codex App Server and Claude Code receive the same prepared prompt plus selected resources.
@Injectable()
export class ProjectExecutorService {
  constructor(
    private readonly codex: CodexAppServerService,
    private readonly claude: ClaudeCodeService,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  async captureLaunch(executor: StoredProjectExecutor, model: string | null): Promise<StoredProjectExecutorLaunch> {
    if (executor === 'codex') {
      return this.codex.captureLaunch(model);
    }
    return this.claude.captureLaunch(model);
  }

  // A native Codex model designation is left to the operator's own Codex configuration; a Gateway public
  // model must exist and speak a protocol the executor can reach through the Gateway.
  async requireModel(workspaceId: string, executor: StoredProjectExecutor, model: string): Promise<void> {
    const protocols = PROJECT_EXECUTOR_PROTOCOLS[executor];
    if (!protocols) return;
    if (executor === 'codex' && !isGatewayPublicModel(model)) return;
    const runtime = await this.resources.publicModelRuntime(workspaceId, model);
    if (!protocols.includes(runtime.protocol)) {
      const label = executor === 'codex' ? 'Codex' : 'Claude Code';
      throw new BadRequestException(`${label} 需要 ${protocols.join(' 或 ')} 协议的 Gateway 模型。`);
    }
  }

  capabilities(executor: StoredProjectExecutor): AgentRuntimeCapabilities {
    return (executor === 'codex' ? this.codex : this.claude).capabilities;
  }

  async execute(request: ProjectExecutorRequest): Promise<string> {
    // The adapter must receive the owning invocation as well as its engine, even
    // when the selected model comes from local configuration rather than a Provider.
    request = {
      ...request,
      correlation: {
        ...request.correlation,
        surface: request.correlation?.surface ?? (request.owner === 'agent' ? 'agent' : request.owner === 'coder' ? 'coder_project_task' : 'chat_project_task'),
        executor: request.launch.executor,
      },
    };
    const directory = request.resourceDirectory ?? await mkdtemp(join(tmpdir(), `worklite-executor-${request.owner}-`));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const prepared = await prepare(directory, request);
      return request.launch.executor === 'codex'
        ? await this.codex.execute(request, prepared)
        : await this.claude.execute(request, prepared);
    } finally {
      if (!request.resourceDirectory) await rm(directory, { recursive: true, force: true });
    }
  }
}

async function prepare(directory: string, request: ProjectExecutorRequest): Promise<PreparedProjectExecution> {
  const chatRuntime = request.owner === 'chat' && Boolean(request.runtimeSession);
  let skillRoot: string | undefined;
  let pluginDirectory: string | undefined;
  // A durable session must forget deselected files, including when the new selection is empty.
  await rm(join(directory, 'plugin'), { recursive: true, force: true });
  if (chatRuntime) {
    for (const root of ['.agents/skills', '.claude/skills']) await rm(join(directory, root), { recursive: true, force: true });
    for (const name of ['AGENTS.md', 'CLAUDE.md']) await writeInside(directory, name, request.systemPrompt);
  }
  if (request.skills.length > 0) {
    pluginDirectory = join(directory, 'plugin');
    skillRoot = join(pluginDirectory, 'skills');
    const used = new Set<string>();
    for (const skill of request.skills) {
      const slug = uniqueSlug(skill, used);
      for (const file of skill.files) {
        const content = file.path === 'SKILL.md' ? withSkillFrontmatter(slug, skill, file.content) : file.content;
        await writeInside(join(skillRoot, slug), file.path, content);
        if (chatRuntime) {
          await writeInside(join(directory, '.agents/skills', slug), file.path, content);
          await writeInside(join(directory, '.claude/skills', slug), file.path, content);
        }
      }
    }
    if (request.launch.executor === 'claude') {
      await writeInside(pluginDirectory, '.claude-plugin/plugin.json', JSON.stringify({ name: 'worklite-skills', version: '1.0.0', description: 'Skills selected in WorkLite for this task.' }));
    }
  }
  const references: string[] = [];
  for (const reference of request.references ?? []) {
    references.push(await writeInside(join(directory, 'references'), reference.path, reference.content));
  }
  // Images the user supplied with the request are written as real files rather than passed through
  // an executor-specific multimodal input: Codex and Claude Code both read a local image with their
  // own tool, so one materialization serves both adapters.
  const imageLines: string[] = [];
  const imageNames = new Set<string>();
  for (const image of request.images ?? []) {
    const path = await writeImageInside(join(directory, 'images'), uniqueImageName(image.fileName, imageNames), image.body);
    imageLines.push(image.description ? `${path} — ${image.description}` : path);
  }
  return {
    directory,
    skillRoot: chatRuntime && skillRoot ? join(directory, '.agents/skills') : skillRoot,
    pluginDirectory: chatRuntime ? undefined : pluginDirectory,
    systemPrompt: [
      request.systemPrompt.trim(),
      references.length ? `Pinned read-only process reference files:\n${references.join('\n')}` : '',
      imageLines.length
        ? `The user supplied ${imageLines.length === 1 ? 'this image' : 'these images'} with the task; ${imageLines.length === 1 ? 'it is' : 'they are'} already saved as read-only local file${imageLines.length === 1 ? '' : 's'} outside the project:\n${imageLines.join('\n')}\nOpen each path with your own image-reading tool (Claude Code: the Read tool; Codex: view_image) before acting on any instruction that refers to a picture, screenshot or design. Treat them as task input, not as something you produced, and do not copy them into the project.`
        : '',
    ].filter(Boolean).join('\n\n'),
    mcpServers: request.mcpServers
      .filter((server) => server.endpoint.trim())
      .map((server) => ({ ...server, key: `worklite_${server.id.replace(/[^A-Za-z0-9_-]/g, '_')}` })),
  };
}

// Pasted images arrive with a client-supplied file name; keep only a flat, safe leaf name so the
// written path can never escape the per-execution directory, and keep names distinct.
function uniqueImageName(fileName: string, used: Set<string>): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-120) || 'image.png';
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : '';
  let name = safe;
  for (let index = 2; used.has(name); index += 1) name = `${base}-${index}${extension}`;
  used.add(name);
  return name;
}

async function writeImageInside(root: string, fileName: string, body: Buffer): Promise<string> {
  const path = join(root, fileName);
  await mkdir(root, { recursive: true });
  await writeFile(path, body, { mode: 0o600 });
  return path;
}

async function writeInside(root: string, relativePath: string, content: string): Promise<string> {
  const path = normalize(join(root, relativePath));
  if (!path.startsWith(`${root}/`)) throw new BadRequestException(`Package file ${relativePath} is outside its directory.`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: relativePath.startsWith('scripts/') && content.startsWith('#!') ? 0o700 : 0o600 });
  return path;
}

function uniqueSlug(skill: ProjectExecutorSkill, used: Set<string>): string {
  const base = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  let slug = base;
  for (let index = 2; used.has(slug); index += 1) slug = `${base}-${index}`;
  used.add(slug);
  return slug;
}

// Both executors discover a skill through SKILL.md frontmatter; WorkLite packages may omit it.
function withSkillFrontmatter(slug: string, skill: ProjectExecutorSkill, content: string): string {
  if (content.startsWith('---\n')) return content;
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  const description = lines.find((line) => !line.startsWith('#')) ?? lines[0]?.replace(/^#+\s*/, '') ?? skill.name;
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description.slice(0, 500))}\n---\n\n${content}`;
}
