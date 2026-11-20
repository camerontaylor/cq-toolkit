import { describe, expect, it } from 'vitest';
import { planItem, type PlanItemDeps } from '../../src/queue-runner/planItem.js';
import { StartNotReady, StartNothingToReview } from '../../src/queue-runner/startOne.js';

/** An effect group the item under test must never reach. */
function trap<T extends object>(name: string): T {
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        throw new Error(`unexpected ${name} effect: ${String(key)}`);
      },
    },
  ) as T;
}

const HEAD = 'b'.repeat(40);
const PIN = 'a'.repeat(40);

interface Opts {
  readonly dry?: boolean;
  readonly ignoreQuiet?: boolean;
  readonly info?: Record<string, unknown>;
  readonly agents?: string[] | null;
  readonly calls?: string[];
}

function deps(opts: Opts = {}): PlanItemDeps {
  const calls = opts.calls ?? [];
  return {
    queue: { items: [] },
    dry: opts.dry ?? false,
    ignoreQuiet: opts.ignoreQuiet ?? false,
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
          ...opts.info,
        }),
    },
    quiet: {
      cloneFor: () => undefined,
      activeAgentsFor: () => {
        calls.push('activeAgentsFor');
        return Promise.resolve(opts.agents === undefined ? [] : opts.agents);
      },
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
  };
}

const open = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pr-7',
  kind: 'open',
  pr: 7,
  state: 'pending',
  ...extra,
});

describe('planItem: ordinary kinds', () => {
  it('plans an open PR from pr_info', async () => {
    const out = await planItem(open(), deps());
    expect(out).toMatchObject({
      outcome: 'plan',
      plan: { base: PIN, head: HEAD, target: 'origin/main', branch: 'feat/x' },
    });
  });

  it('skips a closed PR with Python wording, and does not run the quiet gate', async () => {
    const calls: string[] = [];
    const out = await planItem(open(), deps({ info: { state: 'CLOSED' }, calls }));
    expect(out).toEqual({
      outcome: 'skipped',
      state: 'skipped',
      lastError: 'PR closed before review',
      log: 'PR CLOSED → skipped',
    });
    expect(calls).toEqual([]);
  });

  it('a merged open item is skipped, but a merged delta is planned without the quiet gate', async () => {
    expect(await planItem(open(), deps({ info: { state: 'MERGED' } }))).toMatchObject({
      outcome: 'skipped',
    });
    const calls: string[] = [];
    const out = await planItem(
      open({ kind: 'delta' }),
      deps({ info: { state: 'MERGED', mergeCommit: { oid: HEAD } }, agents: ['busy'], calls }),
    );
    expect(out.outcome).toBe('plan');
    expect(calls).toEqual([]);
  });

  it('an active agent is recorded as a wait, not an error', async () => {
    const out = await planItem(open(), deps({ agents: ['claude pr7'] }));
    expect(out).toEqual({ outcome: 'wait', waitReason: 'active agent(s): claude pr7' });
  });

  it('an unknown agent list fails closed as a wait', async () => {
    const out = await planItem(open(), deps({ agents: null }));
    expect(out).toEqual({
      outcome: 'wait',
      waitReason: 'paseo agent list unavailable (fail closed)',
    });
  });

  it('a draft PR is NotReady and an already-reviewed range is NothingToReview', async () => {
    await expect(planItem(open(), deps({ info: { isDraft: true } }))).rejects.toThrow(
      new StartNotReady('PR is draft'),
    );
    const reviewed = open({
      cycles: [
        {
          base: PIN,
          head: HEAD,
          dirty_diff: 'clean tree',
          run_id: 'r',
          range_policy: 'full-range-once-v1',
        },
      ],
    });
    await expect(planItem(reviewed, deps())).rejects.toBeInstanceOf(StartNothingToReview);
  });

  it('a pr_info without a state is a planning error', async () => {
    await expect(planItem(open(), deps({ info: { state: undefined } }))).rejects.toThrow(
      "pr_info has no string 'state'",
    );
  });
});

describe('planItem: kinds that bypass pr_info', () => {
  it('a dry receipt and a dry push plan without touching the PR or quiet gate', async () => {
    const receipt = await planItem(
      { id: 'r', kind: 'merged-current', pr: 7, subject: { target_selector: 'main' } },
      deps({ dry: true }),
    );
    expect(receipt).toMatchObject({ outcome: 'plan', plan: { base: '(dispatch-pin)' } });
    const push = await planItem(
      { id: 'p', kind: 'push-current', subject: { head: HEAD } },
      deps({ dry: true }),
    );
    expect(push).toMatchObject({ outcome: 'plan', plan: { label: 'push range (not captured)' } });
  });

  it('a dry merged item plans through plan_merged with the default ref', async () => {
    const d = { ...deps({ dry: true }), mergedAuthor: { defaultRef: 'origin/main' } };
    const out = await planItem({ id: 'm', kind: 'merged' }, d as unknown as PlanItemDeps);
    expect(out).toMatchObject({
      outcome: 'plan',
      plan: { target: 'origin/main', label: 'post-merge synthetic review' },
    });
  });
});
