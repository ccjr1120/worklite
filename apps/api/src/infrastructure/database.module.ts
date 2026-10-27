import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, databaseMaintenanceSettings, initializeDatabase, runDatabaseMaintenance, type Database, type DatabaseMaintenanceSettings } from '@worklite/db';

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
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  onModuleInit(): void {
    // The isolated preflight candidate opens the live database file; it must never prune or
    // rewrite it while the deployment that owns it is still serving requests.
    if (process.env.WORKLITE_PREFLIGHT === '1') return;
    this.timer = setInterval(() => this.run(), this.settings.maintenanceIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. A locked or failing database must never fail a request or stop the process. */
  run(): void {
    if (this.running) return;
    this.running = true;
    try {
      const report = runDatabaseMaintenance(this.db.$client, this.settings);
      if (report.commandStreamRowsRemoved || report.eventStreamRowsRemoved) {
        this.logger.log(`Database maintenance removed ${report.commandStreamRowsRemoved} command stream rows and ${report.eventStreamRowsRemoved} replay event rows.`);
      }
    } catch (error) {
      this.logger.warn(`Database maintenance pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
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
