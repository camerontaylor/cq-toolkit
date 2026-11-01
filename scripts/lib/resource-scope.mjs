import { readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
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
export async function enterResourceScope(script, args, { onSignalExit } = {}) {
  checkHeadroom();
  process.env.NODE_OPTIONS = [
    (process.env.NODE_OPTIONS ?? '')
      .replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, '')
      .trim(),
    '--max-old-space-size=2048',
  ]
    .filter(Boolean)
    .join(' ');
  let oom = 'unavailable';
  if (process.platform === 'linux') {
    try {
      writeFileSync('/proc/self/oom_score_adj', '500');
      oom = '500';
    } catch (error) {
      console.error(`resource scope: cannot raise oom_score_adj: ${error.message}`);
    }
  }
  if (process.env.CQ_RESOURCE_SCOPED === '1') return;
  let selectedArgs = scopeArgs;
  const probe = spawnSync('systemd-run', [...selectedArgs, 'true'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    selectedArgs = scopeArgs.slice(0, -2);
    const retry =
      probe.error?.code === 'ENOENT'
        ? probe
        : spawnSync('systemd-run', [...selectedArgs, 'true'], { encoding: 'utf8' });
    if (retry.error || retry.status !== 0) {
      const reason =
        retry.error?.message ?? retry.stderr?.trim().split('\n')[0] ?? 'scope rejected';
      console.error(
        `resource scope: memory scope unavailable (${reason}); running uncapped with oom_score_adj=${oom}, --max-old-space-size=2048, maxWorkers=2`,
      );
      return;
    }
  }
  const child = spawn('systemd-run', [...selectedArgs, process.execPath, script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, CQ_RESOURCE_SCOPED: '1' },
  });
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    const { status, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => resolve({ status, signal }));
    });
    const code = status ?? 128 + (constants.signals[signal] ?? 1);
    if (signal) onSignalExit?.(signal, code);
    return { exit: code };
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}
