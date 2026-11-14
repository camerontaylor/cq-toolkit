/**
 * The file adapter for `crq reconcile-merged`: bytes, transport mapping and the
 * real state root. The forge is a fake `gh` seam, so no provider is contacted.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import {
  fileReconcileMergedEffects,
  runReconcileMergedUnit,
} from '../../../src/adapters/crq/reconcileSource.js';
import { ForgeBudget } from '../../../src/policy/crq/forgeBudget.js';
import {
  BudgetExhausted,
  PageFailed,
} from '../../../src/policy/crq/reconcileInventory.js';
import {
  normalizeInterval,
  reconcileWrapperKey,
} from '../../../src/policy/crq/reconcileCheckpoint.js';

const A = '2026-10-01T00:00:00Z';
const B = '2026-11-14T11:59:59Z';
const NOW = new Date('2026-11-14T12:00:00Z');
const REPO = 'org/repo';

function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

function fakeGh(): { readonly gh: GhFn; readonly queries: string[] } {
  const queries: string[] = [];
  const gh: GhFn = async (args) => {
    const query = (args[3] ?? '').replace(/^query=/, '');
    queries.push(query);
    if (query.includes('issues(last:1')) {
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          data: {
            repository: {
              id: 'R',
              nameWithOwner: REPO,
              issues: { totalCount: 0, nodes: [] },
              pullRequests: { totalCount: 2, nodes: [{ number: 2 }] },
            },
          },
        }),
      };
    }
    const fields: Record<string, unknown> = {};
    for (const match of query.matchAll(/issueOrPullRequest\(number:(\d+)\)/g)) {
      const number = Number(match[1]);
      fields[`n${String(number)}`] = {
        __typename: 'PullRequest',
        number,
        baseRefName: 'main',
        mergedAt: '2026-10-02T00:00:00Z',
        headRefOid: sha(number + 1000),
        mergeCommit: { oid: sha(number) },
      };
    }
    return {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        data: { repository: { id: 'R', nameWithOwner: REPO, ...fields } },
      }),
    };
  };
  return { gh, queries };
}

describe('reconcile file adapter', () => {
  test('persists the wrapper atomically and stages enrollment in queue.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-reconcile-source-'));
    try {
      const stateRoot = join(root, 'state');
      await mkdir(stateRoot, { recursive: true });
      const queuePath = join(stateRoot, 'queue.json');
      await writeFile(queuePath, '{"items":[],"merged_current_requests":{}}\n');
      const { gh, queries } = fakeGh();
      const result = await runReconcileMergedUnit(
        ['--after', A, '--before', B, '--page-budget', '1'],
        {
          repo: REPO,
          stateRoot,
          gh,
          now: () => NOW,
          budget: new ForgeBudget({ requests: 5, seconds: 30, clock: () => 0 }),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(queries).toHaveLength(2);

      const queue = JSON.parse(await readFile(queuePath, 'utf8')) as {
        items: unknown[];
        merged_current_requests: Record<string, unknown>;
        merged_reconcile: { complete: boolean; represented: number };
      };
      expect(queue.items).toHaveLength(2);
      expect(Object.keys(queue.merged_current_requests)).toHaveLength(2);
      expect(queue.merged_reconcile).toMatchObject({ complete: true, represented: 2 });

      const key = reconcileWrapperKey(REPO, normalizeInterval(A, B));
      const wrapperPath = join(stateRoot, 'reconcile', `${key}.json`);
      const wrapper = JSON.parse(await readFile(wrapperPath, 'utf8')) as {
        source: { method: string };
        checkpoint: { complete: boolean };
      };
      expect(wrapper.source.method).toBe('all-number-slots-v1');
      expect(wrapper.checkpoint.complete).toBe(true);
      // Atomic replacement leaves no temp file behind.
      expect(await readdir(join(stateRoot, 'reconcile'))).toEqual([`${key}.json`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('maps budget exhaustion and transport failure to distinct typed errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-reconcile-source-'));
    try {
      const exhausted = fileReconcileMergedEffects({
        repo: REPO,
        stateRoot: root,
        budget: new ForgeBudget({ requests: 0 }),
      });
      await expect(exhausted.forgeQuery('query { x }')).rejects.toBeInstanceOf(BudgetExhausted);

      const failing = fileReconcileMergedEffects({
        repo: REPO,
        stateRoot: root,
        gh: () => Promise.resolve({ code: 1, stdout: '', stderr: 'boom' }),
        budget: new ForgeBudget({ requests: 1, seconds: 30, clock: () => 0 }),
      });
      await expect(failing.forgeQuery('query { x }')).rejects.toBeInstanceOf(PageFailed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('wrapper reads distinguish absent from unparsable storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-reconcile-source-'));
    try {
      const effects = fileReconcileMergedEffects({ repo: REPO, stateRoot: root });
      const path = join(root, 'reconcile', 'missing.json');
      expect(await effects.readWrapperText(path)).toBeNull();
      await effects.writeWrapperText(path, '{"a":1.0}\n');
      expect(await effects.readWrapperText(path)).toBe('{"a":1.0}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
