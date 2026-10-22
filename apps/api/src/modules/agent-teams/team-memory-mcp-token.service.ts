import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { TeamMemoryActorContext } from './team-memory.service';

// Executor MCP credentials live in this API process only. Each project-executor
// task registers one binding before launch and revokes it in the task's finally
// block, so a finished or cancelled task cannot keep writing Team memory.
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

type Binding = { context: TeamMemoryActorContext; expiresAt: number };

@Injectable()
export class TeamMemoryMcpTokenService {
  private readonly bindings = new Map<string, Binding>();

  register(context: TeamMemoryActorContext): string {
    const token = `wtm_${randomBytes(32).toString('hex')}`;
    this.bindings.set(token, { context, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  resolve(token: string | undefined): TeamMemoryActorContext | undefined {
    if (!token) return undefined;
    const binding = this.bindings.get(token);
    if (!binding) return undefined;
    if (binding.expiresAt <= Date.now()) {
      this.bindings.delete(token);
      return undefined;
    }
    return binding.context;
  }

  revoke(token: string): void {
    this.bindings.delete(token);
  }

  // Test/diagnostic visibility into live credentials without exposing tokens.
  get activeCount(): number {
    return this.bindings.size;
  }
}
