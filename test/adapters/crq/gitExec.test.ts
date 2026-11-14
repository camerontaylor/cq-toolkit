// The bounded Git runner owns a process group: a timeout or deadline kill must
// take descendants with it, not just the direct child, or ssh transports and
// remote helpers can outlive the request.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { GitPool, gitCall } from '../../../src/adapters/crq/gitExec.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

describe('gitCall process ownership', () => {
  test.skipIf(process.platform === 'win32')(
    'a timeout kills the descendant process group',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cq-git-group-'));
      const marker = join(dir, 'descendant.pid');
      const savedPath = process.env.PATH;
      const pool = new GitPool();
      try {
        await writeFile(
          join(dir, 'git'),
          `#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\necho $! > ${JSON.stringify(marker)}\nwait\n`,
          { mode: 0o755 },
        );
        process.env.PATH = `${dir}:${savedPath ?? ''}`;
        const result = await gitCall(pool, dir, ['status'], { timeoutMs: 300 });
        expect(result.code).toBeNull();
        const pid = Number((await readFile(marker, 'utf8')).trim());
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        const dead = await waitDead(pid);
        if (!dead) process.kill(pid, 'SIGKILL');
        expect(dead).toBe(true);
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
        pool.killAll();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
