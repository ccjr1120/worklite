import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';

export function upgradeStateDirectory(): string | undefined {
  return process.env.WORKLITE_RUNTIME_STATE_DIR;
}

export function upgradePhase(): string | undefined {
  const directory = upgradeStateDirectory();
  if (!directory || !existsSync(join(directory, 'active.json'))) return undefined;
  const active = JSON.parse(readFileSync(join(directory, 'active.json'), 'utf8')) as { jobId: string };
  const job = JSON.parse(readFileSync(join(directory, 'upgrades', `${active.jobId}.json`), 'utf8')) as { phase: string };
  return job.phase;
}

export function runtimeAdmissionClosed(): boolean {
  return process.env.WORKLITE_PREFLIGHT === '1' || ['draining', 'frozen', 'switching', 'recovering'].includes(upgradePhase() ?? '');
}

export function runtimeWritesFrozen(): boolean {
  return ['frozen', 'switching', 'recovering'].includes(upgradePhase() ?? '');
}

export function assertRuntimeAdmission(): void {
  if (runtimeAdmissionClosed()) throw new ServiceUnavailableException('WorkLite is handing off tasks for an upgrade. Retry after the upgrade settles.');
}
