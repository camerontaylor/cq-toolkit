import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileDeferredRefreshEffects } from '../../../src/adapters/crq/deferredSource.js';
import { withLock } from '../../../src/adapters/crq/lock.js';
import { ForgeBudget } from '../../../src/policy/crq/forgeBudget.js';
import { runDeferredRefresh } from '../../../src/queue-runner/deferredRefresh.js';

const head = 'a'.repeat(40);
const binding = {
  kind: 'deferred-author',
  repo: 'owner/repo',
  producer: 'author',
  head,
  target: 'main',
  targetSelector: 'promoted-main',
};
const pr = {
  number: 12,
  user: { login: 'author' },
  head: { sha: head },
  base: { ref: 'main', repo: { full_name: 'owner/repo' } },
  state: 'open',
  merged: false,
};

describe('file deferred refresh', () => {
  it('searches and re-verifies through a shared budget, saving under the existing lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deferred-file-'));
    await mkdir(join(root, 'other'));
    await writeFile(
      join(root, 'queue.json'),
      JSON.stringify({
        items: [],
        queue_client_requests: { req: { binding, state: 'awaiting-pr', unknown: 1.5 } },
      }),
    );
    const calls: string[][] = [];
    const budget = new ForgeBudget({ requests: 3, seconds: 30, clock: () => 0 });
    const effects = fileDeferredRefreshEffects({
      repo: 'owner/repo',
      stateRoot: root,
      budget,
      gh: async (args) => {
        calls.push(args);
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify(
            args.includes('search/issues')
              ? {
                  incomplete_results: false,
                  total_count: 1,
                  items: [{ number: 12, pull_request: {} }],
                }
              : pr,
          ),
        };
      },
    });
    const result = await withLock(join(root, 'tick.lock'), { wait: false }, () =>
      runDeferredRefresh('2026-10-01T00:00:00Z', effects),
    );
    expect(result.refreshed).toEqual(['req']);
    expect(calls).toHaveLength(2);
    expect(budget.remaining).toBe(1);
    const persisted: unknown = JSON.parse(await readFile(join(root, 'queue.json'), 'utf8'));
    expect(persisted).toMatchObject({
      queue_client_requests: { req: { state: 'awaiting-merge', pr: 12, unknown: 1.5 } },
    });
  });
  it('retains debt for incomplete searches and never trusts candidate snippets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deferred-incomplete-'));
    await writeFile(
      join(root, 'queue.json'),
      JSON.stringify({
        items: [],
        queue_client_requests: { req: { binding, state: 'awaiting-pr' } },
      }),
    );
    const effects = fileDeferredRefreshEffects({
      repo: 'owner/repo',
      stateRoot: root,
      budget: new ForgeBudget(),
      gh: async () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ incomplete_results: true, total_count: 0, items: [] }),
      }),
    });
    const result = await runDeferredRefresh('now', effects);
    const persisted: unknown = JSON.parse(await readFile(join(root, 'queue.json'), 'utf8'));
    expect(result.refreshed).toEqual(['req']);
    expect(persisted).toMatchObject({
      queue_client_requests: {
        req: { state: 'awaiting-pr', refreshError: 'forge refresh unavailable; debt retained' },
      },
    });
  });
});
