import { Injectable } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import type { PluginView } from '@worklite/contracts';

export const CODEX_CLI_PLUGIN_ID = 'codex-cli-chat' as const;
export const CODEX_CLI_AGENT_ID = 'agt_codex_cli_chat' as const;

@Injectable()
export class PluginsService {
  list(): PluginView[] {
    return [{
      id: CODEX_CLI_PLUGIN_ID,
      name: 'Codex CLI Chat',
      description: 'Chat with Codex CLI in the API workspace.',
      enabled: this.isCodexAvailable(),
    }];
  }

  private isCodexAvailable(): boolean {
    const result = spawnSync(process.env.CODEX_BIN || 'codex', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  }
}
