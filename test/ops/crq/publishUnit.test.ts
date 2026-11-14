// The publisher unit's ordering and failure isolation: Python's
// `backfill_publisher.main` runs the notification drain first, then the
// publication body, then the off-lock coverage refresh, and the unit's exit
// status is decided by the coverage refresh alone.
//
// Publication itself is exercised against real git by
// `test/ops/crq/publishRun.test.ts` and the B1 vectors; here the publication
// body is driven to its `disabled` outcome (no rollout) so the two daemon
// phases and their composition are the subject under test.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import {
  publishUnitFailed,
  runPublishMain,
  type PublishUnitEffects,
} from '../../../src/ops/crq/publishUnit.js';

interface Harness {
  readonly effects: PublishUnitEffects;
  readonly order: string[];
}

function harness(
  root: string,
  options: {
    drain?: () => Promise<number>;
    refresh?: (head: string | undefined) => Promise<unknown>;
  } = {},
): Harness {
  const order: string[] = [];
  const effects: PublishUnitEffects = {
    stateRoot: root,
    durableArtifactRoot: join(root, 'artifacts'),
    runSchedulerGit: async () => ({
      args: [],
      code: 1,
      stdout: new Uint8Array(),
      stderr: 'unused',
    }),
    runPublisherGit: async () => ({
      args: [],
      code: 1,
      stdout: new Uint8Array(),
      stderr: 'unused',
    }),
    withTickLock: (fn) => fn(),
    readQueue: async () => new TextEncoder().encode('{"items":[]}\n'),
    writeQueue: async () => {},
    drainNotifications: async () => {
      order.push('drain');
      return options.drain === undefined ? 0 : options.drain();
    },
    refreshCoverage: async (head) => {
      order.push('refresh');
      return options.refresh === undefined ? 'disabled' : options.refresh(head);
    },
  };
  return { effects, order };
}

function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  return (async () => {
    const root = mkdtempSync(join(tmpdir(), 'crq-publish-unit-'));
    try {
      mkdirSync(join(root, 'backfill'), { recursive: true });
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })();
}

describe('runPublishMain', () => {
  test('drains notifications before publication, refreshes after it', async () => {
    await withRoot(async (root) => {
      const { effects, order } = harness(root, { drain: async () => 2 });
      const outcome = await runPublishMain(effects);
      expect(order).toEqual(['drain', 'refresh']);
      // Python's single outcome document: the disabled publication is reported
      // beside the delivered count and the coverage phase's own result.
      expect(outcome).toEqual({
        publication: 'disabled',
        notifications: 2,
        coverage: 'disabled',
      });
    });
  });

  test('a zero delivery count is omitted, exactly Python `if notifications:`', async () => {
    await withRoot(async (root) => {
      const outcome = await runPublishMain(harness(root).effects);
      expect(outcome).toEqual({ publication: 'disabled', coverage: 'disabled' });
      expect('notifications' in outcome).toBe(false);
    });
  });

  test('a drain failure is retry-pending and never blocks the publication', async () => {
    await withRoot(async (root) => {
      const { effects, order } = harness(root, {
        drain: async () => {
          throw new Error('queue unavailable');
        },
      });
      const outcome = await runPublishMain(effects);
      expect(order).toEqual(['drain', 'refresh']);
      expect(outcome.notifications).toBe('retry-pending');
      expect(outcome.publication).toBe('disabled');
      // A drain failure is not a coverage failure: the unit still succeeds.
      expect(publishUnitFailed(outcome)).toBe(false);
    });
  });

  test('a refresh failure is demoted to the coverage field and fails the unit', async () => {
    await withRoot(async (root) => {
      const { effects } = harness(root, {
        drain: async () => 1,
        refresh: async () => {
          throw new Error('git fetch failed');
        },
      });
      const outcome = await runPublishMain(effects);
      expect(outcome).toEqual({
        publication: 'disabled',
        notifications: 1,
        coverage: 'failed: git fetch failed',
      });
      expect(publishUnitFailed(outcome)).toBe(true);
    });
  });

  test('the refresh is asked about the published head, and only after publication', async () => {
    await withRoot(async (root) => {
      const heads: Array<string | undefined> = [];
      // A present but incomplete rollout refuses publication: the drain already
      // ran, the refresh is still asked (with no head) and reports its own
      // refusal, and the unit fails on the publication error.
      writeFileSync(join(root, 'backfill-rollout.json'), '{"durable_artifact_root":"/x"}\n');
      const { effects, order } = harness(root, {
        refresh: async (head) => {
          heads.push(head);
          return 'idle';
        },
      });
      await expect(runPublishMain(effects)).rejects.toThrow(/prerequisites/);
      expect(order).toEqual(['drain']);
      expect(heads).toEqual([]);
    });
    await withRoot(async (root) => {
      const heads: Array<string | undefined> = [];
      const { effects } = harness(root, {
        refresh: async (head) => {
          heads.push(head);
          return 'disabled';
        },
      });
      await runPublishMain(effects);
      // No publication ran, so Python's `result.get("ledger_head")` is absent.
      expect(heads).toEqual([undefined]);
    });
  });

  test('exit status follows coverage: an errored target fails the unit', () => {
    expect(
      publishUnitFailed({
        publication: 'disabled',
        coverage: { head: 'a'.repeat(40), targets: { ['a'.repeat(40)]: 'error: boom' } },
      }),
    ).toBe(true);
    expect(
      publishUnitFailed({
        publication: 'disabled',
        coverage: { head: 'a'.repeat(40), targets: { ['a'.repeat(40)]: 'extended' } },
      }),
    ).toBe(false);
    // The JSON outcome (artifacts are printed, not returned as objects) uses
    // the same rule through `JsonObject`.
    expect(
      publishUnitFailed({
        publication: 'disabled',
        coverage: new JsonObject([
          ['head', 'a'.repeat(40)],
          ['targets', new JsonObject([['a'.repeat(40), 'invalid-target']])],
        ]),
      }),
    ).toBe(true);
    expect(
      publishUnitFailed({
        publication: 'disabled',
        coverage: new JsonObject([
          ['head', 'a'.repeat(40)],
          ['targets', new JsonObject([['a'.repeat(40), 'current']])],
        ]),
      }),
    ).toBe(false);
  });
});

describe('the unit outcome is JSON-serializable evidence', () => {
  test('notifications and coverage survive the runner artifact', async () => {
    await withRoot(async (root) => {
      const { effects } = harness(root, {
        drain: async () => 3,
        refresh: async () => ({ head: 'b'.repeat(40), targets: { x: 'full' } }),
      });
      const outcome = await runPublishMain(effects);
      expect(JSON.parse(JSON.stringify(outcome))).toEqual({
        publication: 'disabled',
        notifications: 3,
        coverage: { head: 'b'.repeat(40), targets: { x: 'full' } },
      });
    });
  });
});
