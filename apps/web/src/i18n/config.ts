import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE } from './locale';
import enAgents from './locales/en/agents.json';
import enAssistant from './locales/en/assistant.json';
import enArtifacts from './locales/en/artifacts.json';
import enCommon from './locales/en/common.json';
import enHome from './locales/en/home.json';
import enMcpServers from './locales/en/mcpServers.json';
import enOnboarding from './locales/en/onboarding.json';
import enPlugins from './locales/en/plugins.json';
import enRuns from './locales/en/runs.json';
import enSettings from './locales/en/settings.json';
import enSkills from './locales/en/skills.json';
import enWorkflows from './locales/en/workflows.json';
import enWorkspace from './locales/en/workspace.json';
import zhAgents from './locales/zh-CN/agents.json';
import zhAssistant from './locales/zh-CN/assistant.json';
import zhArtifacts from './locales/zh-CN/artifacts.json';
import zhCommon from './locales/zh-CN/common.json';
import zhHome from './locales/zh-CN/home.json';
import zhMcpServers from './locales/zh-CN/mcpServers.json';
import zhOnboarding from './locales/zh-CN/onboarding.json';
import zhPlugins from './locales/zh-CN/plugins.json';
import zhRuns from './locales/zh-CN/runs.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhSkills from './locales/zh-CN/skills.json';
import zhWorkflows from './locales/zh-CN/workflows.json';
import zhWorkspace from './locales/zh-CN/workspace.json';

export const NAMESPACES = [
  'common',
  'workspace',
  'home',
  'onboarding',
  'agents',
  'assistant',
  'workflows',
  'runs',
  'skills',
  'mcpServers',
  'plugins',
  'artifacts',
  'settings',
] as const;

const resources = {
  en: {
    common: enCommon,
    workspace: enWorkspace,
    home: enHome,
    onboarding: enOnboarding,
    agents: enAgents,
    assistant: enAssistant,
    workflows: enWorkflows,
    runs: enRuns,
    skills: enSkills,
    mcpServers: enMcpServers,
    plugins: enPlugins,
    artifacts: enArtifacts,
    settings: enSettings,
  },
  'zh-CN': {
    common: zhCommon,
    workspace: zhWorkspace,
    home: zhHome,
    onboarding: zhOnboarding,
    agents: zhAgents,
    assistant: zhAssistant,
    workflows: zhWorkflows,
    runs: zhRuns,
    skills: zhSkills,
    mcpServers: zhMcpServers,
    plugins: zhPlugins,
    artifacts: zhArtifacts,
    settings: zhSettings,
  },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: ['en', 'zh-CN'],
  defaultNS: 'common',
  ns: [...NAMESPACES],
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
  saveMissing: import.meta.env.DEV,
  missingKeyHandler: (languages, namespace, key) => {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] Missing key ${namespace}:${key} for ${languages.join(', ')}`);
    }
  },
  parseMissingKeyHandler: (key) => {
    if (import.meta.env.DEV) {
      return key;
    }
    return '';
  },
});

export { i18n };
