import { runtimeWritesFrozen } from './runtime-upgrade-state';
import { initializeAgentFiles } from '../modules/agents/agent-file-store';
import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createDb,
  databaseMaintenanceSettings,
  initializeDatabase,
  SqliteMaintenanceWorker,
  type Database,
} from '@worklite/db';

export const DATABASE = Symbol('DATABASE');

/** Retention, backfill and reclamation use a separate thread and SQLite connection. */
@Injectable()
export class DatabaseMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseMaintenanceService.name);
  private readonly settings = databaseMaintenanceSettings();
  private worker?: SqliteMaintenanceWorker;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  onModuleInit(): void {
    if (process.env.WORKLITE_PREFLIGHT === '1' || this.db.$client.name === ':memory:') return;
    this.worker = new SqliteMaintenanceWorker(this.db.$client.name, this.settings);
    this.schedule(this.settings.catchUpIntervalMs);
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.worker?.stop();
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.run();
    }, delay);
    this.timer.unref();
  }
  async run(): Promise<void> {
    if (this.running || !this.worker || this.stopped) return;
    this.running = true;
    let backlog = false;
    try {
      if (runtimeWritesFrozen()) return;
      const report = await this.worker.run();
      backlog = report.backlog;
      if (report.removed || report.changed)
        this.logger.log(
          `Database maintenance removed ${report.removed} expired rows, compacted ${report.changed} payloads; ${report.freePages} free pages remain.`,
        );
    } catch (error) {
      backlog = /locked|busy/i.test(String(error));
      this.logger.warn(
        `Database maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
      this.schedule(
        backlog ? this.settings.catchUpIntervalMs : this.settings.maintenanceIntervalMs,
      );
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
        const db = createDb(
          config.get<string>('SQLITE_PATH') ?? '../../.data/deployment/worklite.db',
        );
        await initializeDatabase(db);
        if (process.env.WORKLITE_PREFLIGHT !== '1') initializeAgentFiles(db);
        return db;
      },
    },
    DatabaseMaintenanceService,
  ],
  exports: [DATABASE, DatabaseMaintenanceService],
})
export class DatabaseModule {}
