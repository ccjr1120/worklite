import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentTeamDocumentView, AgentTeamDocumentDownloadView } from '@worklite/contracts';
import { executorDocuments, executorRuns, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { agentTeamDocumentFileName, AgentTeamRuntimeService } from './executor-category-runtime.service';

@Injectable()
export class AgentTeamDocumentsService {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly workspaces: WorkspaceService, private readonly runtime: AgentTeamRuntimeService) {}

  async getDocument(request: Request, workspaceSlug: string, documentId: string): Promise<AgentTeamDocumentView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    let document = await this.getDocumentRow(documentId, workspace.id);
    if (document.deliveryStatus !== 'delivered') {
      await this.runtime.deliverRunDocuments(document.runId, workspace.id);
      document = await this.getDocumentRow(documentId, workspace.id);
    }
    return toDocumentView(document);
  }

  async downloadDocument(
    request: Request,
    workspaceSlug: string,
    documentId: string,
  ): Promise<AgentTeamDocumentDownloadView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    let document = await this.getDocumentRow(documentId, workspace.id);
    if (document.deliveryStatus !== 'delivered') {
      await this.runtime.deliverRunDocuments(document.runId, workspace.id);
      document = await this.getDocumentRow(documentId, workspace.id);
    }
    if (document.deliveryStatus !== 'delivered') {
      throw new NotFoundException('The executor document file is not available.');
    }
    return {
      fileName: agentTeamDocumentFileName(document.key, document.revision),
      content: document.content,
    };
  }

  private async getDocumentRow(documentId: string, workspaceId: string) {
    const [row] = await this.db.select({ document: executorDocuments })
      .from(executorDocuments)
      .innerJoin(executorRuns, eq(executorRuns.id, executorDocuments.runId))
      .where(and(
        eq(executorDocuments.id, documentId),
        eq(executorDocuments.workspaceId, workspaceId),
        eq(executorRuns.workspaceId, workspaceId),
      ))
      .limit(1);
    if (!row) throw new NotFoundException('Executor document not found.');
    return row.document;
  }

}

function toDocumentView(row: typeof executorDocuments.$inferSelect): AgentTeamDocumentView {
  return {
    id: row.id,
    runId: row.runId,
    taskAttemptId: row.taskAttemptId,
    key: row.key,
    revision: row.revision,
    title: row.title,
    content: row.content,
    upstreamDocumentKeys: row.upstreamDocumentKeys,
    deliveryStatus: row.deliveryStatus,
    deliveryError: row.deliveryError,
    fileName: agentTeamDocumentFileName(row.key, row.revision),
    createdAt: row.createdAt.toISOString(),
  };
}
