import { describe, expect, it } from 'vitest';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import {
  recoverPublication,
  remoteHeadOf,
  type PublicationRecoveryEffects,
  type RecoveryBranchPr,
  type RecoveryPrInfo,
} from '../../src/queue-runner/publicationRecovery.js';

// Mirrors apps/crq-python/test_repair_publication_lease.py.
const HEAD = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const STALE = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const BRANCH = 'crq/fix-run';

interface World {
  readonly remote?: string;
  readonly pr?: RecoveryPrInfo;
  readonly prs?: readonly RecoveryBranchPr[];
  /** `[older, newer]` pairs the fake Git reports as ancestry. */
  readonly ancestors?: readonly (readonly [string, string])[];
}

function fake(world: World) {
  const calls: string[] = [];
  const pushes: { branch: string; expected: string; sha: string }[] = [];
  const effects: PublicationRecoveryEffects = {
    async lsRemoteHeads(branch) {
      calls.push('ls-remote');
      return world.remote ? `${world.remote}\trefs/heads/${branch}` : '';
    },
    async prInfo() {
      calls.push('pr-info');
      if (!world.pr) throw new Error('unexpected pr_info');
      return world.pr;
    },
    async listBranchPrs() {
      calls.push('pr-list');
      return world.prs ?? [];
    },
    async isAncestor(older, newer) {
      calls.push('is-ancestor');
      return (world.ancestors ?? []).some(([a, b]) => a === older && b === newer);
    },
    async push(branch, expected, sha) {
      calls.push('push');
      pushes.push({ branch, expected, sha });
    },
    async finalize() {
      calls.push('finalize');
    },
  };
  return { effects, calls, pushes };
}

const journal = (openPr: boolean, withTarget = true) => ({
  head: HEAD,
  ...(withTarget ? { target: TARGET } : {}),
  branch: BRANCH,
  open_pr: openPr,
  commits: [HEAD],
});

async function run(world: World, openPr: boolean, withTarget = true) {
  const f = fake(world);
  const record: Record<string, unknown> = {};
  let thrown: unknown;
  try {
    await recoverPublication(f.effects, { pr: 7 }, record, journal(openPr, withTarget));
  } catch (e) {
    thrown = e;
  }
  return { ...f, record, thrown };
}

const openPr = (headRefOid: string, over: Partial<RecoveryPrInfo> = {}): RecoveryPrInfo => ({
  state: 'OPEN',
  headRefName: BRANCH,
  headRefOid,
  ...over,
});

describe('recoverPublication: open PR', () => {
  it('leases the push on the journaled target, not the stale remote read', async () => {
    const r = await run(
      {
        remote: STALE,
        pr: openPr(TARGET),
        ancestors: [
          [TARGET, HEAD],
          [STALE, HEAD],
        ],
      },
      true,
    );
    expect(r.thrown).toBeUndefined();
    expect(r.pushes).toEqual([{ branch: BRANCH, expected: TARGET, sha: HEAD }]);
    expect(r.calls.at(-1)).toBe('finalize');
  });

  it('refuses without pushing when the journaled target is not an ancestor of head', async () => {
    const r = await run({ remote: STALE, pr: openPr(TARGET) }, true);
    expect(r.thrown).toBeInstanceOf(PyError);
    expect((r.thrown as PyError).kind).toBe('ValueError');
    expect((r.thrown as PyError).message).toBe(
      'publication would not fast-forward the checked remote head',
    );
    expect(r.pushes).toEqual([]);
    expect(r.calls).not.toContain('finalize');
  });

  it('finalizes without pushing when the PR is already at head', async () => {
    const r = await run({ remote: STALE, pr: openPr(HEAD) }, true);
    expect(r.pushes).toEqual([]);
    expect(r.calls).toEqual(['ls-remote', 'pr-info', 'finalize']);
  });

  it('finalizes without pushing when head is already contained in the PR', async () => {
    const r = await run({ pr: openPr(OTHER), ancestors: [[HEAD, OTHER]] }, true);
    expect(r.pushes).toEqual([]);
    expect(r.calls.at(-1)).toBe('finalize');
  });

  it.each([
    ['closed', openPr(TARGET, { state: 'CLOSED' })],
    ['merged', openPr(TARGET, { state: 'MERGED' })],
    ['renamed branch', openPr(TARGET, { headRefName: 'other' })],
  ])('marks the record stale when the PR is %s', async (_name, pr) => {
    const r = await run({ remote: TARGET, pr }, true);
    expect(r.record).toEqual({ state: 'stale', error: 'PR no longer publishable' });
    expect(r.calls).toEqual(['ls-remote', 'pr-info']);
  });

  it('marks the record stale when the PR head moved past the journaled target', async () => {
    const r = await run({ remote: OTHER, pr: openPr(OTHER) }, true);
    expect(r.record).toEqual({
      state: 'stale',
      error: 'head moved after prepared publication; needs new review',
    });
    expect(r.pushes).toEqual([]);
    expect(r.calls).not.toContain('finalize');
  });

  it('skips the push but still finalizes when the remote already holds head', async () => {
    const r = await run({ remote: HEAD, pr: openPr(TARGET) }, true);
    expect(r.pushes).toEqual([]);
    expect(r.calls.at(-1)).toBe('finalize');
  });
});

describe('recoverPublication: branch only', () => {
  it('refuses a present branch that differs from the prepared head', async () => {
    const r = await run({ remote: STALE, ancestors: [[STALE, HEAD]] }, false);
    expect((r.thrown as PyError).kind).toBe('ValueError');
    expect((r.thrown as PyError).message).toBe(
      'existing fix branch differs from prepared publication',
    );
    expect(r.pushes).toEqual([]);
  });

  it('pushes with an empty lease when the branch is absent', async () => {
    const r = await run({}, false);
    expect(r.pushes).toEqual([{ branch: BRANCH, expected: '', sha: HEAD }]);
    // An empty lease needs no ancestry proof.
    expect(r.calls).toEqual(['ls-remote', 'pr-list', 'push', 'finalize']);
  });

  it('finalizes without pushing when the remote already holds head', async () => {
    const r = await run({ remote: HEAD }, false);
    expect(r.pushes).toEqual([]);
    expect(r.calls).toEqual(['ls-remote', 'pr-list', 'finalize']);
  });

  it('finalizes when exactly one fix PR exists at the prepared head', async () => {
    const r = await run({ remote: HEAD, prs: [{ headRefOid: HEAD }] }, false);
    expect(r.pushes).toEqual([]);
    expect(r.calls.at(-1)).toBe('finalize');
  });

  it.each([
    ['a PR at another head', [{ headRefOid: OTHER }]],
    ['two PRs', [{ headRefOid: HEAD }, { headRefOid: HEAD }]],
  ])('refuses on %s', async (_name, prs) => {
    const r = await run({ remote: HEAD, prs }, false);
    expect((r.thrown as PyError).message).toBe('fix PR identity or prepared head mismatch');
    expect(r.calls).not.toContain('finalize');
  });
});

describe('recoverPublication: journal shape', () => {
  it('raises KeyError for a journal without open_pr, before any PR read', async () => {
    const f = fake({});
    const { open_pr: _drop, ...partial } = journal(false);
    await expect(recoverPublication(f.effects, {}, {}, partial)).rejects.toMatchObject({
      kind: 'KeyError',
      message: "'open_pr'",
    });
    expect(f.calls).toEqual(['ls-remote']);
  });

  it('raises KeyError for an open-PR publication on an item without pr', async () => {
    const f = fake({ pr: openPr(HEAD) });
    await expect(recoverPublication(f.effects, {}, {}, journal(true))).rejects.toMatchObject({
      kind: 'KeyError',
      message: "'pr'",
    });
  });
});

// Python reads `publication['target']` lazily: only the open-PR "head moved"
// comparison (after the ancestry read) and the open-PR push lease touch it. A
// journal without `target` therefore recovers on every path that never reads
// it, and an eager read would change which of these outcomes happens.
describe('recoverPublication: target is read lazily, as in Python', () => {
  it('finalizes a PR already at head without reading target', async () => {
    const r = await run({ remote: STALE, pr: openPr(HEAD) }, true, false);
    expect(r.thrown).toBeUndefined();
    expect(r.calls).toEqual(['ls-remote', 'pr-info', 'finalize']);
  });

  it('raises KeyError(target) for a moved PR only after the ancestry read', async () => {
    const r = await run({ remote: OTHER, pr: openPr(OTHER) }, true, false);
    expect(r.thrown).toMatchObject({ kind: 'KeyError', message: "'target'" });
    expect(r.calls).toEqual(['ls-remote', 'pr-info', 'is-ancestor']);
    expect(r.pushes).toEqual([]);
    expect(r.record).toEqual({});
  });

  it('pushes an absent branch with an empty lease without reading target', async () => {
    const r = await run({}, false, false);
    expect(r.thrown).toBeUndefined();
    expect(r.pushes).toEqual([{ branch: BRANCH, expected: '', sha: HEAD }]);
    expect(r.calls).toEqual(['ls-remote', 'pr-list', 'push', 'finalize']);
  });
});

describe('remoteHeadOf', () => {
  it('takes the first token of the ls-remote line, and null when absent', () => {
    expect(remoteHeadOf(`${HEAD}\trefs/heads/x`)).toBe(HEAD);
    expect(remoteHeadOf('')).toBeNull();
    expect(remoteHeadOf('  \n')).toBeNull();
  });
});
