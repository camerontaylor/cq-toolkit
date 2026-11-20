import { describe, expect, it } from 'vitest';
import { JsonObject, JsonNumber } from '../../src/policy/crq/jsonValue.js';
import { fromPlainJson } from '../../src/policy/crq/queueDoc.js';
import { bindStartOne, type StartOneBundle } from '../../src/queue-runner/startOneEffects.js';
import type { LaunchEffects } from '../../src/queue-runner/launch.js';
import type { CoverageEffects } from '../../src/queue-runner/coverageUsage.js';
import type { ScheduleContext } from '../../src/policy/crq/tickSchedule.js';
import type { StartRecord } from '../../src/queue-runner/startOne.js';

const HEAD = 'b'.repeat(40);
const PIN = 'a'.repeat(40);

function trap<T extends object>(name: string): T {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        throw new Error(`unexpected ${name} effect: ${String(key)}`);
      },
    },
  ) as T;
}

function queueDoc(items: StartRecord[]): JsonObject {
  return fromPlainJson({ items, starts: [] }) as JsonObject;
}

function bundle(
  calls: string[],
  coverage: Partial<CoverageEffects> = {},
): (queue: StartRecord) => StartOneBundle {
  return (queue) => ({
    context: { nowMicros: 1_700_000_000_000_000n } as unknown as ScheduleContext,
    plan: {
      itemRepo: () => 'o/primary',
      prInfo: {
        repo: 'o/primary',
        ghJson: () =>
          Promise.resolve({
            state: 'OPEN',
            isDraft: false,
            headRefOid: HEAD,
            headRefName: 'feat/x',
            baseRefName: 'main',
            updatedAt: '2026-11-20T00:00:00Z',
          }),
      },
      quiet: {
        cloneFor: () => undefined,
        activeAgentsFor: () => Promise.resolve([]),
        ensureCommit: () => Promise.resolve(true),
        commitTimestamp: () => Promise.resolve(0),
        parseIsoSeconds: () => 0,
        nowSeconds: () => 10_000_000,
        quietMinutes: 1,
      },
      ordinary: {
        defaultBranch: () => null,
        ensureCommit: () => Promise.resolve(true),
        mergeBase: () => Promise.resolve(PIN),
      },
      mergedAuthor: trap('mergedAuthor'),
      current: trap('current'),
      push: trap('push'),
      localReview: trap('localReview'),
    },
    launch: {
      nowIso: () => '2026-11-20T01:02:03Z',
      runStamp: () => '20261120T010203Z',
      itemRepo: () => 'o/primary',
      isPrimaryRepo: () => true,
      repoConfig: () => null,
      onDemandClone: () => Promise.resolve('/c'),
      launchBand: () => 'background',
      allocateRun: (id) => Promise.resolve(`/runs/${id}`),
      scan: () => Promise.resolve({ ok: true, denylistHits: 0, gitleaksHits: 0, artifactPath: '' }),
      scanBackfillContext: trap('scanBackfillContext'),
      writeBlockedReceipt: trap('writeBlockedReceipt'),
      checkout: ({ runId }) => Promise.resolve({ path: `/wt/${runId}`, branch: 'b' }),
      removeWorktree: () => Promise.resolve(),
      checkAuthor: () => undefined,
      grantAuthor: () => undefined,
      writeMeta: () => Promise.resolve(),
      workStarted: () => Promise.resolve(),
      saveQueue: () => {
        calls.push(`save:${String((queue.starts as unknown[]).length)}`);
        return Promise.resolve();
      },
      spawn: () => Promise.resolve(99),
      event: (kind) => {
        calls.push(`event:${kind}`);
        return Promise.resolve();
      },
    } satisfies LaunchEffects,
    coverage: {
      select: () => Promise.resolve({ started: null, available: false }),
      backfillDispatchConfigured: () => false,
      mergeQueueSha: () => Promise.resolve(PIN),
      liveItems: () => [],
      compareItems: () => 0,
      coverageCandidate: () => null,
      ...coverage,
    } as unknown as Omit<CoverageEffects, 'launch'>,
    event: (kind) => {
      calls.push(`event:${kind}`);
      return Promise.resolve();
    },
    nowIso: () => '2026-11-20T01:02:03Z',
  });
}

const ctx = { dry: false, only: null, ignoreQuiet: false };
const pending = (): StartRecord => ({
  id: 'pr-7',
  kind: 'open',
  pr: 7,
  state: 'pending',
  priority: 0,
});

describe('bindStartOne', () => {
  it('plans, launches and returns the edited JsonObject queue', async () => {
    const calls: string[] = [];
    const startOne = bindStartOne({ bundle: bundle(calls) });
    const out = await startOne(queueDoc([pending()]), ctx);
    expect(out.queue).toBeInstanceOf(JsonObject);
    const items = out.queue.get('items') as JsonObject[];
    expect(items[0]?.get('state')).toBe('reviewing');
    const run = items[0]?.get('run') as JsonObject | undefined;
    expect(run?.get('pid')).toEqual(JsonNumber.int(99));
    expect(out.queue.get('starts')).toEqual(['2026-11-20T01:02:03Z']);
    expect(out.log.at(-1)).toBe(
      'started pr-7 [one review of captured range] run pr-7-20261120T010203Z',
    );
    expect(calls).toEqual(['save:1', 'save:1', 'event:review_started']);
    expect(out.hasCoverage).toBe(false);
  });

  it('preserves integers beyond the safe range in untouched fields', async () => {
    const big = 9007199254740993n;
    const doc = queueDoc([pending()]);
    const withExtra = new JsonObject([...doc.entries, ['extension', JsonNumber.int(big)]]);
    const out = await bindStartOne({ bundle: bundle([]) })(withExtra, ctx);
    expect(out.queue.get('extension')).toEqual(JsonNumber.int(big));
  });

  it('keeps an integral float beyond the safe range a float', async () => {
    const doc = queueDoc([pending()]);
    const withFloat = new JsonObject([...doc.entries, ['extension', JsonNumber.float(1e20)]]);
    const out = await bindStartOne({ bundle: bundle([]) })(withFloat, ctx);
    expect(out.queue.get('extension')).toEqual(JsonNumber.float(1e20));
  });

  it('a dry run plans without launching or editing state', async () => {
    const calls: string[] = [];
    const out = await bindStartOne({ bundle: bundle(calls) })(queueDoc([pending()]), {
      ...ctx,
      dry: true,
    });
    expect(calls).toEqual([]);
    expect((out.queue.get('items') as JsonObject[])[0]?.get('state')).toBe('pending');
    expect(out.log.some((line) => line.startsWith('DRY-RUN would start pr-7'))).toBe(true);
  });

  it('maps coverage_fallback availability onto hasCoverage', async () => {
    const out = await bindStartOne({
      bundle: bundle([], {
        backfillDispatchConfigured: () => true,
        select: () => Promise.resolve({ started: null, available: true }),
      }),
    })(queueDoc([]), { ...ctx, dry: true });
    expect(out.hasCoverage).toBe(true);
    expect(out.log).toContain('no eligible item this tick');
  });

  it('threads the only filter and the ignoreQuiet flag through', async () => {
    const calls: string[] = [];
    const out = await bindStartOne({ bundle: bundle(calls) })(
      queueDoc([pending(), { ...pending(), id: 'pr-8', pr: 8 }]),
      { dry: false, only: 'pr-8', ignoreQuiet: true },
    );
    const items = out.queue.get('items') as JsonObject[];
    expect(items[0]?.get('state')).toBe('pending');
    expect(items[1]?.get('state')).toBe('reviewing');
  });
});
