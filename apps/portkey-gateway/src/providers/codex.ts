import OpenAIAPIConfig from './openai/api';
import type { ProviderConfigs } from './types';
import { codexRequestHandler } from '../worklite/codex-transport';

const CodexConfig: ProviderConfigs = {
  api: OpenAIAPIConfig,
  createModelResponse: {},
  requestHandlers: {
    proxy: codexRequestHandler,
    createModelResponse: codexRequestHandler,
  },
  responseTransforms: {},
};

export default CodexConfig;
