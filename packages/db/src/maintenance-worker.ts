import { Worker } from 'node:worker_threads';
import {
  databaseMaintenanceSettings,
  maintenanceScriptPath,
  type DatabaseMaintenanceReport,
  type DatabaseMaintenanceSettings,
} from './maintenance';

/** One persistent worker/connection, no overlapping passes and no SQLite work on the caller. */
export class SqliteMaintenanceWorker {
  private worker?: Worker;
  private pending?: {
    resolve: (value: DatabaseMaintenanceReport) => void;
    reject: (error: Error) => void;
  };
  private stopped = false;
  constructor(
    private readonly path: string,
    private readonly settings: DatabaseMaintenanceSettings = databaseMaintenanceSettings(),
    private readonly kind: 'main' | 'gateway' = 'main',
  ) {}
  run(): Promise<DatabaseMaintenanceReport> {
    if (this.stopped) return Promise.reject(new Error('Maintenance worker is stopped.'));
    if (this.pending) return Promise.reject(new Error('Maintenance is already running.'));
    if (!this.worker) {
      const worker = (this.worker = new Worker(maintenanceScriptPath(), {
        workerData: { path: this.path, settings: this.settings, kind: this.kind },
      }));
      worker.unref();
      worker.on('message', (value: { report?: DatabaseMaintenanceReport; error?: string }) => {
        const pending = this.pending;
        this.pending = undefined;
        if (value.report) pending?.resolve(value.report);
        else pending?.reject(new Error(value.error ?? 'Maintenance failed.'));
      });
      worker.on('error', (error) => {
        this.pending?.reject(error);
        this.pending = undefined;
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = undefined;
        this.pending?.reject(new Error(`Maintenance worker exited (${code}).`));
        this.pending = undefined;
      });
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker!.postMessage('run');
    });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.worker?.terminate();
    this.worker = undefined;
  }
}
