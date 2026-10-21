import { BadRequestException, Injectable } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import type { StoredProjectExecutor, StoredProjectExecutorLaunch } from '@worklite/db';
import { CLAUDE_CODE_PLUGIN_ID, CODEX_CLI_PLUGIN_ID, PluginsService } from '../plugins/plugins.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { ClaudeCodeService } from './claude-code.service';
import { CodexAppServerService } from './codex-app-server.service';
import { PROJECT_EXECUTOR_PROTOCOLS, type PreparedProjectExecution, type ProjectExecutorRequest, type ProjectExecutorSkill } from './project-executor.types';

// Chat project tasks and the Team developer role share this boundary. Executors run natively in the project
// directory; WorkLite only hands over selected Skills, MCP servers and reference files in each executor's own form.
@Injectable()
export class ProjectExecutorService {
  constructor(
    private readonly codex: CodexAppServerService,
    private readonly claude: ClaudeCodeService,
    private readonly plugins: PluginsService,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  async captureLaunch(executor: StoredProjectExecutor, model: string | null): Promise<StoredProjectExecutorLaunch> {
    return executor === 'codex'
      ? this.codex.captureLaunch(await this.plugins.commandArguments(CODEX_CLI_PLUGIN_ID), model)
      : this.claude.captureLaunch(await this.plugins.commandArguments(CLAUDE_CODE_PLUGIN_ID), model);
  }

  // Codex is not required to use a Gateway model: it runs through the operator's own native configuration.
  async requireModel(workspaceId: string, executor: StoredProjectExecutor, model: string): Promise<void> {
    const protocols = PROJECT_EXECUTOR_PROTOCOLS[executor];
    if (!protocols) return;
    const runtime = await this.resources.publicModelRuntime(workspaceId, model);
    if (!protocols.includes(runtime.protocol)) {
      throw new BadRequestException(`Claude Code 需要 ${protocols.join(' 或 ')} 协议的 Gateway 模型。`);
    }
  }

  async execute(request: ProjectExecutorRequest): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `worklite-executor-${request.owner}-`));
    try {
      const prepared = await prepare(directory, request);
      return request.launch.executor === 'codex'
        ? await this.codex.execute(request, prepared)
        : await this.claude.execute(request, prepared);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function prepare(directory: string, request: ProjectExecutorRequest): Promise<PreparedProjectExecution> {
  let skillRoot: string | undefined;
  let pluginDirectory: string | undefined;
  if (request.skills.length > 0) {
    pluginDirectory = join(directory, 'plugin');
    skillRoot = join(pluginDirectory, 'skills');
    const used = new Set<string>();
    for (const skill of request.skills) {
      const slug = uniqueSlug(skill, used);
      for (const file of skill.files) {
        const content = file.path === 'SKILL.md' ? withSkillFrontmatter(slug, skill, file.content) : file.content;
        await writeInside(join(skillRoot, slug), file.path, content);
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
  return {
    directory,
    skillRoot,
    pluginDirectory,
    systemPrompt: [
      request.systemPrompt.trim(),
      references.length ? `Pinned read-only process reference files:\n${references.join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
    mcpServers: request.mcpServers
      .filter((server) => server.endpoint.trim())
      .map((server) => ({ ...server, key: `worklite_${server.id.replace(/[^A-Za-z0-9_-]/g, '_')}` })),
  };
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
