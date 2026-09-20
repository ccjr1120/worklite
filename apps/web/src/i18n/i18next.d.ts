import 'i18next';
import type enAssistant from './locales/en/assistant.json';
import type enArtifacts from './locales/en/artifacts.json';
import type enCommon from './locales/en/common.json';
import type enHome from './locales/en/home.json';
import type enMcpServers from './locales/en/mcpServers.json';
import type enPlugins from './locales/en/plugins.json';
import type enRuns from './locales/en/runs.json';
import type enSettings from './locales/en/settings.json';
import type enSkills from './locales/en/skills.json';
import type enWorkflows from './locales/en/workflows.json';
import type enWorkspace from './locales/en/workspace.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof enCommon;
      workspace: typeof enWorkspace;
      home: typeof enHome;
      assistant: typeof enAssistant;
      workflows: typeof enWorkflows;
      runs: typeof enRuns;
      skills: typeof enSkills;
      mcpServers: typeof enMcpServers;
      plugins: typeof enPlugins;
      artifacts: typeof enArtifacts;
      settings: typeof enSettings;
    };
  }
}
