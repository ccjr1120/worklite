import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { applyDocumentLocale } from './locale';
import zhCoders from './locales/zh-CN/coders.json';
import zhAssistant from './locales/zh-CN/assistant.json';
import zhArtifacts from './locales/zh-CN/artifacts.json';
import zhCommon from './locales/zh-CN/common.json';
import zhHome from './locales/zh-CN/home.json';
import zhLogs from './locales/zh-CN/logs.json';
import zhMcpServers from './locales/zh-CN/mcpServers.json';
import zhPlugins from './locales/zh-CN/plugins.json';
import zhRuns from './locales/zh-CN/runs.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhSkills from './locales/zh-CN/skills.json';
import zhWorkflows from './locales/zh-CN/workflows.json';
import zhWorkspace from './locales/zh-CN/workspace.json';

const NAMESPACES = [
  'common',
  'workspace',
  'home',
  'assistant',
  'coders',
  'workflows',
  'runs',
  'skills',
  'mcpServers',
  'plugins',
  'artifacts',
  'settings',
  'logs',
] as const;

const resources = {
  'zh-CN': {
    common: zhCommon,
    workspace: zhWorkspace,
    home: zhHome,
    assistant: zhAssistant,
    coders: zhCoders,
    workflows: zhWorkflows,
    runs: zhRuns,
    skills: zhSkills,
    mcpServers: zhMcpServers,
    plugins: zhPlugins,
    artifacts: zhArtifacts,
    settings: zhSettings,
    logs: zhLogs,
  },
} as const;


applyDocumentLocale();

void i18n.use(initReactI18next).init({
  resources,
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  supportedLngs: ['zh-CN'],
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
