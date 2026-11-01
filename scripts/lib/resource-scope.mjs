import { readFileSync, writeFileSync } from 'node:fs';
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

// Probe before executing real work so a failed test/build is never retried.
// Scopes on older systemd versions reject OOMScoreAdjust; retain the cgroup
// limits and set our own OOM score, inherited by every child, separately.
export async function enterResourceScope(script, args) {
  checkHeadroom();
  process.env.NODE_OPTIONS = '--max-old-space-size=2048';
  if (process.platform === 'linux') writeFileSync('/proc/self/oom_score_adj', '500');
  if (process.env.CQ_RESOURCE_SCOPED === '1') return;
  let selectedArgs = scopeArgs;
  const probe = spawnSync('systemd-run', [...selectedArgs, 'true'], { stdio: 'ignore' });
  if (probe.error?.code === 'ENOENT') return;
  if (probe.error || probe.status !== 0) {
    selectedArgs = scopeArgs.slice(0, -2);
    const retry = spawnSync('systemd-run', [...selectedArgs, 'true'], { stdio: 'ignore' });
    if (retry.error || retry.status !== 0) {
      throw new Error(
        'systemd-run is installed but cannot apply the memory scope; move to another host',
      );
    }
  }
  const child = spawn('systemd-run', [...selectedArgs, process.execPath, script, ...args], {
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
