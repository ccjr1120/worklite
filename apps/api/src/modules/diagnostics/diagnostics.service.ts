import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { diagnosticLogs, type Database, type DiagnosticLog } from '@worklite/db';
import type { DiagnosticLogLevel, DiagnosticLogStatus, DiagnosticLogView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';

@Injectable()
export class DiagnosticsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  start(workspaceId: string, providerId: string, operation: string, stage: string, message: string, metadata: Record<string, unknown> = {}) {
    const traceId = `trace_${randomUUID()}`;
    this.write(workspaceId, { traceId, providerId, operation, stage, level: 'info', status: 'started', message, metadata });
    return traceId;
  }

  write(workspaceId: string, input: { traceId: string; providerId?: string | null; operation: string; stage: string; level: DiagnosticLogLevel; status: DiagnosticLogStatus; message: string; durationMs?: number | null; metadata?: Record<string, unknown> }) {
    this.db.insert(diagnosticLogs).values({
      id: `diag_${randomUUID()}`,
      workspaceId,
      traceId: input.traceId,
      providerId: input.providerId ?? null,
      operation: input.operation,
      stage: input.stage,
      level: input.level,
      status: input.status,
      message: input.message,
      durationMs: input.durationMs ?? null,
      metadata: input.metadata ?? {},
    }).run();
  }

  list(workspaceId: string, traceId?: string): DiagnosticLogView[] {
    const conditions = [eq(diagnosticLogs.workspaceId, workspaceId)];
    if (traceId?.trim()) conditions.push(eq(diagnosticLogs.traceId, traceId.trim()));
    const rows = this.db.select().from(diagnosticLogs).where(and(...conditions)).orderBy(desc(diagnosticLogs.createdAt)).all();
    return rows.map((row) => this.toView(row));
  }

  private toView(row: DiagnosticLog): DiagnosticLogView {
    return {
      id: row.id,
      traceId: row.traceId,
      providerId: row.providerId,
      operation: row.operation,
      stage: row.stage,
      level: row.level,
      status: row.status,
      message: row.message,
      durationMs: row.durationMs,
      metadata: row.metadata,
      timestamp: row.createdAt.toISOString(),
    };
  }
}
