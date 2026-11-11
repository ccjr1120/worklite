import { createHash } from 'node:crypto';
import type { GatewayToolDefinition } from '@worklite/model-gateway';

const REMOVED_TOOLS = new Set(['web_fetch', 'update_plan']);
const CORE_TOOLS = new Set([
  'discover_tools', 'ask_user', 'inspect_agents', 'run_agent',
  'run_host_command', 'query_platform', 'search_local_projects',
  'read_history_archive', 'inspect_agent_run', 'cancel_agent_execution',
]);
const TOOL_GROUPS = {
  files: { description: '发送本地文件和图片 / send local files and images', names: ['upload_local_files', 'upload_local_images'] },
  agents: { description: '创建、修改、删除 Agent 和控制子实例 / agent configuration and instance control', names: ['create_agent', 'update_agent', 'delete_agent', 'refresh_agent_action', 'control_agent_instance'] },
  platform: { description: '平台资源汇总、共享 Skill 和 MCP 配置 / resource catalog, shared Skills and MCP configuration', names: ['inspect_workspace', 'create_skill', 'create_mcp_server', 'delete_mcp_server'] },
  chat: { description: 'Chat 模型配置、通知和其他对话管理 / Chat settings and other conversations', names: ['inspect_chat', 'update_chat', 'inspect_chat_conversations', 'inspect_chat_conversation', 'start_chat_conversation', 'message_chat_conversation'] },
  providers: { description: '模型 Provider 配置与模型发现 / model providers and model discovery', names: ['create_provider', 'discover_provider_models', 'update_provider_models'] },
  projects: { description: '维护本地项目别名 / local project aliases', names: ['list_local_project_aliases', 'set_local_project_alias', 'remove_local_project_alias'] },
  tasks: { description: '历史项目任务及订阅 / legacy project tasks and subscriptions', names: ['inspect_project_task', 'list_project_tasks', 'subscribe_project_task'] },
  diagnostics: { description: 'Gateway 请求统计和日志诊断 / gateway usage and request logs', names: ['inspect_gateway_stats', 'inspect_gateway_request_logs', 'inspect_gateway_request_log'] },
  publishing: { description: '微信公众号草稿修改与配图 / WeChat article drafts and illustrations', names: ['inspect_wechat_draft', 'render_article_image', 'revise_wechat_draft', 'resolve_wechat_draft_revision'] },
  deployment: { description: 'WorkLite 升级部署 / upgrades and deployment', names: ['propose_upgrade', 'redeploy', 'inspect_upgrade'] },
  settings: { description: '外观设置和页面导航 / appearance and navigation', names: ['update_settings', 'navigate'] },
  memory: { description: '长期记忆的查询和增删改 / long-term memory', names: ['list_memories', 'save_memory', 'update_memory', 'delete_memory'] },
  waiting: { description: '显式等待其他对话或历史任务；后台结果通常自动通知 / explicit waits, normally prefer automatic notifications', names: ['wait_chat_conversation', 'wait_project_task'] },
} as const;

export const DISCOVER_CHAT_TOOLS: GatewayToolDefinition = {
  name: 'discover_tools', executionMode: 'parallel',
  description: 'Load additional tools for the next model step, without executing them. Select groups or exact toolNames; omit both to list available groups and tool names. Loaded tools stay available for this user turn. Prefer query_platform for ordinary platform reads and inspect_agent_run for Agent progress; waiting is usually unnecessary because background results arrive automatically.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    groups: { type: 'array', maxItems: 4, items: { type: 'string', enum: Object.keys(TOOL_GROUPS) }, description: Object.entries(TOOL_GROUPS).map(([key, group]) => `${key}: ${group.description}`).join('; ') },
    toolNames: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 128 }, description: 'Exact names from the catalog or task instructions; only captured tools can be loaded.' },
  } },
};

export const NATIVE_CHAT_TOOL_GUIDANCE = 'Use the tools currently supplied. For other abilities call discover_tools with a group or exact toolNames, then use the loaded tool in the next model step. Discovery only loads definitions and never performs the requested action; continue until the user goal is fulfilled. Loaded tools remain available for the current user turn. Use query_platform for ordinary read-only platform facts; use inspect_agents to select an Agent and inspect_agent_run for execution evidence. Specialized inspection tools provide aggregation, revision checks or diagnostics. Prefer automatic background completion notifications; discover waiting tools only when an explicit wait is needed. Never substitute shell/API calls for a missing platform mutation tool: discover its typed contract first.';

export function nativeChatTurnKey(execution: { displayMessages: readonly { id: string; role: string }[]; modelMessages: readonly { role: string; content: unknown }[] }): string {
  const displayed = execution.displayMessages.filter((message) => message.role === 'user').at(-1);
  if (displayed) return displayed.id;
  const latest = execution.modelMessages.filter((message) => message.role === 'user').at(-1);
  return createHash('sha256').update(JSON.stringify(latest?.content ?? '')).digest('hex');
}

export function loadedChatToolNames(turnKey: string, outputs: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const output of outputs) {
    try {
      const result = JSON.parse(output);
      if (result?.kind === 'native-tool-discovery' && result.turnKey === turnKey && Array.isArray(result.toolNames)) {
        for (const name of result.toolNames) if (typeof name === 'string') names.add(name);
      }
    } catch { /* Old or failed results do not grant tool availability. */ }
  }
  return names;
}

export function visibleChatTools(catalog: readonly GatewayToolDefinition[], loaded: ReadonlySet<string>): GatewayToolDefinition[] {
  return catalog.filter((tool) => !REMOVED_TOOLS.has(tool.name) && (CORE_TOOLS.has(tool.name) || loaded.has(tool.name)));
}

export function discoverChatTools(catalog: readonly GatewayToolDefinition[], input: unknown, turnKey: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object with groups or toolNames.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'groups' && key !== 'toolNames')) throw new Error('Only groups and toolNames are accepted.');
  const groups = value.groups === undefined ? [] : value.groups;
  const requested = value.toolNames === undefined ? [] : value.toolNames;
  if (!Array.isArray(groups) || groups.length > 4 || groups.some((group) => typeof group !== 'string' || !Object.hasOwn(TOOL_GROUPS, group))) throw new Error('Select at most four valid tool groups.');
  if (!Array.isArray(requested) || requested.length > 12 || requested.some((name) => typeof name !== 'string' || !name.length || name.length > 128)) throw new Error('Select at most twelve exact tool names.');
  catalog = catalog.filter((tool) => !REMOVED_TOOLS.has(tool.name));
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  const unknown = requested.filter((name) => !byName.has(name));
  if (unknown.length) throw new Error(`Tools are unavailable in this captured turn: ${unknown.join(', ')}. Call discover_tools with {} to inspect the catalog.`);
  const names = new Set<string>(requested);
  for (const key of groups as Array<keyof typeof TOOL_GROUPS>) for (const name of TOOL_GROUPS[key].names) if (byName.has(name)) names.add(name);
  const tools = catalog.filter((tool) => names.has(tool.name)).map((tool) => ({ name: tool.name, description: tool.description.slice(0, 180) }));
  return {
    kind: 'native-tool-discovery', turnKey, toolNames: tools.map((tool) => tool.name), tools,
    ...(groups.length || requested.length ? { note: 'Definitions are available in the next model step. No action has been executed.' } : {
      groups: Object.entries(TOOL_GROUPS).map(([name, group]) => ({ name, description: group.description, tools: group.names.filter((name) => byName.has(name)) })).filter((group) => group.tools.length),
      // Include future catalog additions even before they have a named group.
      otherTools: catalog.filter((tool) => !CORE_TOOLS.has(tool.name) && !Object.values(TOOL_GROUPS).some((group) => (group.names as readonly string[]).includes(tool.name))).map((tool) => tool.name),
    }),
  };
}

/** Remove obsolete built-in instructions from captured platform prompts as well as new ones. */
export function nativeChatInstructions(text: string): string {
  return text.replaceAll('Read public page URLs with web_fetch.', 'Delegate webpage reading and research to an appropriate Agent.')
    .replaceAll('web_fetch reads public page URLs directly.', 'Delegate webpage reading and research to an appropriate Agent.');
}
