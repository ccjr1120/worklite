import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { catchUpMaintenanceSettings, createDb, databaseMaintenanceSettings, initializeDatabase, runDatabaseMaintenance, type Database, type DatabaseMaintenanceSettings } from '@worklite/db';

export const DATABASE = Symbol('DATABASE');

/**
 * Keeps the main database bounded while the deployment runs.
 *
 * Retention and page reclamation used to happen only in initializeDatabase, so a long-lived
 * deployment grew without limit between restarts and its WAL was never truncated: under the
 * continuous event-stream write load SQLite's own passive checkpoints backfill frames but
 * never reset the journal, which is how a multi-gigabyte database ends up beside a WAL of
 * comparable size. The service lives in this file so the DATABASE token stays importable
 * without a cycle between the module and its provider.
 */
@Injectable()
export class DatabaseMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseMaintenanceService.name);
  private readonly settings: DatabaseMaintenanceSettings = databaseMaintenanceSettings();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private catchingUp = false;
  private stopped = false;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  onModuleInit(): void {
    // The isolated preflight candidate opens the live database file; it must never prune or
    // rewrite it while the deployment that owns it is still serving requests.
    if (process.env.WORKLITE_PREFLIGHT === '1') return;
    // The first pass runs shortly after boot rather than a full interval later: a deployment
    // that has just gained retention has its whole backlog waiting, and startup is also the
    // moment with the least request traffic to contend with.
    this.schedule(this.settings.catchUpIntervalMs);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Each pass schedules the next one, so a backlog can be worked off faster than the normal cadence. */
  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => this.run(), delayMs);
    this.timer.unref();
  }

  /** One pass. A locked or failing database must never fail a request or stop the process. */
  run(): void {
    if (this.running) return;
    this.running = true;
    try {
      const settings = this.catchingUp ? catchUpMaintenanceSettings(this.settings) : this.settings;
      const report = runDatabaseMaintenance(this.db.$client, settings);
      this.catchingUp = report.backlog;
      if (report.commandStreamRowsRemoved || report.eventStreamRowsRemoved) {
        this.logger.log(`Database maintenance removed ${report.commandStreamRowsRemoved} command stream rows and ${report.eventStreamRowsRemoved} replay event rows; ${report.freePages} free pages remain.`);
      }
    } catch (error) {
      // A pass that failed says nothing about the backlog; the next one runs on the normal cadence.
      this.catchingUp = false;
      this.logger.warn(`Database maintenance pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
      this.schedule(this.catchingUp ? this.settings.catchUpIntervalMs : this.settings.maintenanceIntervalMs);
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<Database> => {
        const db = createDb(config.get<string>('SQLITE_PATH') ?? '../../.data/deployment/worklite.db');
        await initializeDatabase(db);
        return db;
      },
    },
    DatabaseMaintenanceService,
  ],
  exports: [DATABASE, DatabaseMaintenanceService],
})
export class DatabaseModule {}
