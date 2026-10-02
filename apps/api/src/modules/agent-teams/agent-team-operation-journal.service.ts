import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  agentTeamOperations,
  type AgentTeamOperation,
  type Database,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

export type AgentTeamOperationScope = {
  workspaceId: string;
  runId: string;
  taskAttemptId: string;
};

export type AgentTeamOperationRecordView = {
  key: string;
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
  status: 'reserved' | 'completed' | 'uncertain' | 'failed';
  commandId?: string;
  result?: unknown;
  failureReason?: string;
};

export type AgentTeamOperationReservation = {
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
};

export type AgentTeamScopedOperationJournal = {
  findOperation(operationKey: string): Promise<AgentTeamOperationRecordView | undefined>;
  reserveOperation(
    request: AgentTeamOperationReservation,
    commandId?: string,
    transaction?: Database,
  ): AgentTeamOperationRecordView;
  completeOperation(operationKey: string, result: unknown, commandId?: string): Promise<AgentTeamOperationRecordView>;
  markOperationUncertain(operationKey: string, reason: string): Promise<AgentTeamOperationRecordView>;
  failOperation(operationKey: string, reason: string): Promise<AgentTeamOperationRecordView>;
};

@Injectable()
export class AgentTeamOperationJournalService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  forAttempt(scope: AgentTeamOperationScope): AgentTeamScopedOperationJournal {
    return {
      findOperation: (operationKey) => this.findOperation(scope, operationKey),
      reserveOperation: (request, commandId, transaction) => this.reserveOperation(scope, request, commandId, transaction),
      completeOperation: (operationKey, result, commandId) => this.completeOperation(scope, operationKey, result, commandId),
      markOperationUncertain: (operationKey, reason) => this.updateFailure(scope, operationKey, 'uncertain', reason),
      failOperation: (operationKey, reason) => this.updateFailure(scope, operationKey, 'failed', reason),
    };
  }

  private async findOperation(scope: AgentTeamOperationScope, operationKey: string): Promise<AgentTeamOperationRecordView | undefined> {
    const [row] = await this.db.select().from(agentTeamOperations)
      .where(and(
        eq(agentTeamOperations.key, persistedKey(scope, operationKey)),
        eq(agentTeamOperations.runId, scope.runId),
      ))
      .limit(1);
    return row ? toRecord(row, operationKey) : undefined;
  }

  private reserveOperation(
    scope: AgentTeamOperationScope,
    request: AgentTeamOperationReservation,
    commandId: string | undefined,
    transaction: Database | undefined,
  ): AgentTeamOperationRecordView {
    const db = transaction ?? this.db;
    const logicalKey = logicalOperationKey(request);
    const [row] = db.insert(agentTeamOperations).values({
      key: persistedKey(scope, logicalKey),
      workspaceId: scope.workspaceId,
      runId: scope.runId,
      taskAttemptId: scope.taskAttemptId,
      taskKey: request.taskKey,
      operationKey: request.operationKey,
      toolName: request.toolName,
      inputFingerprint: request.inputFingerprint,
      status: 'reserved',
      commandId: commandId ?? null,
    }).returning().all();
    return toRecord(row, logicalKey);
  }

  private async completeOperation(
    scope: AgentTeamOperationScope,
    operationKey: string,
    result: unknown,
    commandId: string | undefined,
  ): Promise<AgentTeamOperationRecordView> {
    const [row] = await this.db.update(agentTeamOperations)
      .set({
        status: 'completed',
        result,
        failureReason: null,
        ...(commandId === undefined ? {} : { commandId }),
        updatedAt: new Date(),
      })
      .where(operationScopeFilter(scope, operationKey))
      .returning().all();
    if (!row) throw new NotFoundException(`Agent Team operation ${operationKey} was not found.`);
    return toRecord(row, operationKey);
  }

  private async updateFailure(
    scope: AgentTeamOperationScope,
    operationKey: string,
    status: 'uncertain' | 'failed',
    reason: string,
  ): Promise<AgentTeamOperationRecordView> {
    const [row] = await this.db.update(agentTeamOperations)
      .set({ status, result: null, failureReason: reason, updatedAt: new Date() })
      .where(operationScopeFilter(scope, operationKey))
      .returning().all();
    if (!row) throw new NotFoundException(`Agent Team operation ${operationKey} was not found.`);
    return toRecord(row, operationKey);
  }
}

function logicalOperationKey(request: AgentTeamOperationReservation): string {
  return `${request.taskKey}:${request.operationKey}`;
}

function persistedKey(scope: AgentTeamOperationScope, logicalKey: string): string {
  return `${scope.runId}:${logicalKey}`;
}

function operationScopeFilter(scope: AgentTeamOperationScope, logicalKey: string) {
  return and(
    eq(agentTeamOperations.key, persistedKey(scope, logicalKey)),
    eq(agentTeamOperations.runId, scope.runId),
  );
}

function toRecord(row: AgentTeamOperation, logicalKey: string): AgentTeamOperationRecordView {
  return {
    key: logicalKey,
    taskKey: row.taskKey,
    operationKey: row.operationKey,
    toolName: row.toolName,
    inputFingerprint: row.inputFingerprint,
    status: row.status,
    ...(row.commandId ? { commandId: row.commandId } : {}),
    ...(row.status === 'completed' ? { result: row.result } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  };
}
