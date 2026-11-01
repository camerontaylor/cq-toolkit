import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

export function checkHeadroom() {
  if (process.platform !== 'linux') return;
  const available = Number(
    /^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1],
  );
  if (available >= 2 * 1024 * 1024) return;
  const users = spawnSync('ps', ['-eo', 'pid,rss,comm', '--sort=-rss'], { encoding: 'utf8' });
  throw Object.assign(
    new Error(
      `MemAvailable below 2 GB; move to another host. Top memory users:\n${users.stdout?.split('\n').slice(0, 4).join('\n')}`,
    ),
    { code: 75 },
  );
}

const scopeArgs = [
  '--user',
  '--scope',
  '-p',
  'MemoryMax=3G',
  '-p',
  'MemorySwapMax=0',
  '-p',
  'CPUWeight=50',
  '-p',
  'OOMScoreAdjust=500',
];

// Probe the same properties before starting real work: unavailable user buses
// and unsupported properties fall back without executing a job twice.
export async function enterResourceScope(script, args) {
  checkHeadroom();
  process.env.NODE_OPTIONS = '--max-old-space-size=2048';
  if (process.env.CQ_RESOURCE_SCOPED === '1') return;
  const probe = spawnSync('systemd-run', [...scopeArgs, 'true'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) return;
  const child = spawn('systemd-run', [...scopeArgs, process.execPath, script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, CQ_RESOURCE_SCOPED: '1' },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve(status ?? (signal === 'SIGINT' ? 130 : 143)));
  });
  process.exit(code);
}
