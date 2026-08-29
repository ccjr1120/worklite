import { execFileSync } from 'node:child_process';

const ports = [Number(process.env.API_PORT ?? 3000), 5173];
const processIds = new Set();

for (const port of ports) {
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const value of output.split(/\s+/)) {
      if (/^\d+$/.test(value)) processIds.add(Number(value));
    }
  } catch {
    // lsof exits non-zero when the port is unused.
  }
}

for (const processId of processIds) {
  try {
    process.kill(processId, 'SIGTERM');
  } catch {
    // The process may have exited between lsof and termination.
  }
}
