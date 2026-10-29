import 'i18next';
import type zhAssistant from './locales/zh-CN/assistant.json';
import type zhArtifacts from './locales/zh-CN/artifacts.json';
import type zhAgentTeams from './locales/zh-CN/executorCategories.json';
import type zhCommon from './locales/zh-CN/common.json';
import type zhHome from './locales/zh-CN/home.json';
import type zhLogs from './locales/zh-CN/logs.json';
import type zhMcpServers from './locales/zh-CN/mcpServers.json';
import type zhPlugins from './locales/zh-CN/plugins.json';
import type zhRuns from './locales/zh-CN/runs.json';
import type zhSettings from './locales/zh-CN/settings.json';
import type zhSkills from './locales/zh-CN/skills.json';
import type zhWorkflows from './locales/zh-CN/workflows.json';
import type zhWorkspace from './locales/zh-CN/workspace.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof zhCommon;
      executorCategories: typeof zhAgentTeams;
      workspace: typeof zhWorkspace;
      home: typeof zhHome;
      assistant: typeof zhAssistant;
      workflows: typeof zhWorkflows;
      runs: typeof zhRuns;
      skills: typeof zhSkills;
      mcpServers: typeof zhMcpServers;
      plugins: typeof zhPlugins;
      artifacts: typeof zhArtifacts;
      settings: typeof zhSettings;
      logs: typeof zhLogs;
    };
  }
}
