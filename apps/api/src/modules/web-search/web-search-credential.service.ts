import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { workspaceCredentials, workspaces, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { decryptSecret, encryptSecret } from '../../common/secret-encryption';

// One credential row per workspace. The key is a stable identifier, not the
// secret itself; the encrypted value is never returned by an API response.
export const VOLCENGINE_SEARCH_CREDENTIAL_KEY = 'volcengine_search_api_key';
const PERSONAL_WORKSPACE_SLUG = 'personal';
const MAX_API_KEY_LENGTH = 512;

export type WebSearchCredentialStatus = {
  configured: boolean;
  updatedAt: string | null;
};

@Injectable()
export class WebSearchCredentialService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async workspaceId(slug = PERSONAL_WORKSPACE_SLUG): Promise<string> {
    const [workspace] = await this.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    if (!workspace) throw new NotFoundException(`Workspace ${slug} not found`);
    return workspace.id;
  }

  async status(slug = PERSONAL_WORKSPACE_SLUG): Promise<WebSearchCredentialStatus> {
    const workspaceId = await this.workspaceId(slug);
    const [row] = await this.db.select({ encryptedValue: workspaceCredentials.encryptedValue, updatedAt: workspaceCredentials.updatedAt })
      .from(workspaceCredentials)
      .where(and(eq(workspaceCredentials.workspaceId, workspaceId), eq(workspaceCredentials.credentialKey, VOLCENGINE_SEARCH_CREDENTIAL_KEY)))
      .limit(1);
    const configured = row ? Boolean(this.decrypt(row.encryptedValue)) : false;
    return { configured, updatedAt: configured && row ? row.updatedAt.toISOString() : null };
  }

  // Only the search client calls this. A rotated SECRET_ENCRYPTION_KEY leaves a
  // row this process cannot read; treat that as unconfigured instead of failing.
  async read(slug = PERSONAL_WORKSPACE_SLUG): Promise<string | null> {
    const workspaceId = await this.workspaceId(slug);
    return this.readForWorkspace(workspaceId);
  }

  async readForWorkspace(workspaceId: string): Promise<string | null> {
    const [row] = await this.db.select({ encryptedValue: workspaceCredentials.encryptedValue })
      .from(workspaceCredentials)
      .where(and(eq(workspaceCredentials.workspaceId, workspaceId), eq(workspaceCredentials.credentialKey, VOLCENGINE_SEARCH_CREDENTIAL_KEY)))
      .limit(1);
    if (!row) return null;
    return this.decrypt(row.encryptedValue);
  }

  async save(apiKey: unknown, slug = PERSONAL_WORKSPACE_SLUG): Promise<WebSearchCredentialStatus> {
    const value = validateApiKey(apiKey);
    if (!process.env.SECRET_ENCRYPTION_KEY?.trim()) {
      throw new ServiceUnavailableException('Web search credential encryption is not configured on this WorkLite instance.');
    }
    const workspaceId = await this.workspaceId(slug);
    const encryptedValue = encryptSecret(value);
    const now = new Date();
    await this.db.insert(workspaceCredentials)
      .values({ workspaceId, credentialKey: VOLCENGINE_SEARCH_CREDENTIAL_KEY, encryptedValue, updatedAt: now })
      .onConflictDoUpdate({
        target: [workspaceCredentials.workspaceId, workspaceCredentials.credentialKey],
        set: { encryptedValue, updatedAt: now },
      });
    return { configured: true, updatedAt: now.toISOString() };
  }

  async clear(slug = PERSONAL_WORKSPACE_SLUG): Promise<WebSearchCredentialStatus> {
    const workspaceId = await this.workspaceId(slug);
    await this.db.delete(workspaceCredentials)
      .where(and(eq(workspaceCredentials.workspaceId, workspaceId), eq(workspaceCredentials.credentialKey, VOLCENGINE_SEARCH_CREDENTIAL_KEY)));
    return { configured: false, updatedAt: null };
  }

  private decrypt(encryptedValue: string): string | null {
    try {
      const value = decryptSecret(encryptedValue).trim();
      return value || null;
    } catch {
      return null;
    }
  }
}

function validateApiKey(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('A Volcengine web search API key is required.');
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestException('A Volcengine web search API key is required.');
  if (trimmed.length > MAX_API_KEY_LENGTH) throw new BadRequestException(`The API key must be no longer than ${MAX_API_KEY_LENGTH} characters.`);
  // Keys travel in an Authorization header, so reject anything that could break
  // the header or smuggle a second header line.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) throw new BadRequestException('The API key must not contain whitespace or control characters.');
  return trimmed;
}
