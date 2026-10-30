import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { AgentTeamOperationRecoveryDecision } from '@worklite/contracts';
import {
  coderOperations,
  type AgentTeamOperation,
  type Database,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

type AgentTeamOperationScope = {
  workspaceId: string;
  runId: string;
  taskAttemptId: string;
};

type AgentTeamOperationRecordView = {
  key: string;
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
  status: 'reserved' | 'completed' | 'uncertain' | 'failed';
  commandId?: string;
  result?: unknown;
  failureReason?: string;
  recoveryDecision?: AgentTeamOperationRecoveryDecision;
};

type AgentTeamOperationReservation = {
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
  pendingResult?: unknown;
};

type AgentTeamScopedOperationJournal = {
  findOperation(operationKey: string): Promise<AgentTeamOperationRecordView | undefined>;
  findReplayOperation(taskKey: string, replayOperationKey: string): Promise<AgentTeamOperationRecordView | undefined>;
  reserveOperation(
    request: AgentTeamOperationReservation,
    commandId?: string,
    transaction?: Database,
  ): AgentTeamOperationRecordView;
  completeOperation(operationKey: string, result: unknown, commandId?: string): Promise<AgentTeamOperationRecordView>;
  markOperationUncertain(operationKey: string, reason: string): Promise<AgentTeamOperationRecordView>;
  failOperation(operationKey: string, reason: string): Promise<AgentTeamOperationRecordView>;
  attachReplayCommand(operationKey: string, commandId: string, transaction?: Database): AgentTeamOperationRecordView;
};

@Injectable()
export class AgentTeamOperationJournalService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  forAttempt(scope: AgentTeamOperationScope): AgentTeamScopedOperationJournal {
    return {
      findOperation: (operationKey) => this.findOperation(scope, operationKey),
      findReplayOperation: (taskKey, replayOperationKey) => this.findOperation(scope, `${taskKey}:${replayOperationKey}`),
      reserveOperation: (request, commandId, transaction) => this.reserveOperation(scope, request, commandId, transaction),
      completeOperation: (operationKey, result, commandId) => this.completeOperation(scope, operationKey, result, commandId),
      markOperationUncertain: (operationKey, reason) => this.updateFailure(scope, operationKey, 'uncertain', reason),
      failOperation: (operationKey, reason) => this.updateFailure(scope, operationKey, 'failed', reason),
      attachReplayCommand: (operationKey, commandId, transaction) => this.attachReplayCommand(scope, operationKey, commandId, transaction),
    };
  }

  private async findOperation(scope: AgentTeamOperationScope, operationKey: string): Promise<AgentTeamOperationRecordView | undefined> {
    const [row] = await this.db.select().from(coderOperations)
      .where(and(
        eq(coderOperations.key, persistedKey(scope, operationKey)),
        eq(coderOperations.runId, scope.runId),
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
    const [row] = db.insert(coderOperations).values({
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
      result: request.pendingResult ?? null,
    }).returning().all();
    return toRecord(row, logicalKey);
  }

  private async completeOperation(
    scope: AgentTeamOperationScope,
    operationKey: string,
    result: unknown,
    commandId: string | undefined,
  ): Promise<AgentTeamOperationRecordView> {
    const [row] = await this.db.update(coderOperations)
      .set({
        status: 'completed',
        result,
        failureReason: null,
        ...(commandId === undefined ? {} : { commandId }),
        updatedAt: new Date(),
      })
      .where(operationScopeFilter(scope, operationKey))
      .returning().all();
    if (!row) throw new NotFoundException(`Executor operation ${operationKey} was not found.`);
    return toRecord(row, operationKey);
  }

  private async updateFailure(
    scope: AgentTeamOperationScope,
    operationKey: string,
    status: 'uncertain' | 'failed',
    reason: string,
  ): Promise<AgentTeamOperationRecordView> {
    const [row] = await this.db.update(coderOperations)
      .set({
        status,
        failureReason: reason,
        recoveryDecision: null,
        recoveryDecidedAt: null,
        updatedAt: new Date(),
      })
      .where(operationScopeFilter(scope, operationKey))
      .returning().all();
    if (!row) throw new NotFoundException(`Executor operation ${operationKey} was not found.`);
    return toRecord(row, operationKey);
  }

  private attachReplayCommand(
    scope: AgentTeamOperationScope,
    operationKey: string,
    commandId: string,
    transaction: Database | undefined,
  ): AgentTeamOperationRecordView {
    const db = transaction ?? this.db;
    const [row] = db.update(coderOperations).set({ commandId, updatedAt: new Date() })
      .where(and(
        operationScopeFilter(scope, operationKey),
        eq(coderOperations.status, 'reserved'),
      ))
      .returning().all();
    if (!row) throw new NotFoundException(`Executor operation ${operationKey} was not found.`);
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
    eq(coderOperations.key, persistedKey(scope, logicalKey)),
    eq(coderOperations.runId, scope.runId),
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
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.recoveryDecision ? { recoveryDecision: row.recoveryDecision } : {}),
  };
}
