import { describe, expect, it } from 'vitest';
import {
  deepEqual,
  formatAge,
  prInfo,
  prepareCurrent,
  prepareLocalReview,
  preparePushCurrent,
  pyPrefix,
  quietReason,
  type Item,
  type PathRow,
  type PrepareCurrentEffects,
  type PrepareLocalReviewEffects,
  type PreparePushEffects,
  type Queue,
  type QuietReasonEffects,
  type RepoConfig,
} from '../../src/queue-runner/preparePasses.js';
import { currentEquivalence } from '../../src/policy/crq/receiptIdentity.js';
import { receiptJsonDigest } from '../../src/policy/crq/pythonJson.js';

const T = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const PB = 'c'.repeat(40);
const PH = 'd'.repeat(40);

const row = (path: string, extra: PathRow = {}): PathRow => ({
  path,
  source_path: path,
  disposition: 'included',
  bytes: 10,
  blob: 'blob-' + path,
  ...extra,
});

function currentFx(
  log: string[],
  over: Partial<PrepareCurrentEffects> & { paths?: PathRow[] } = {},
): PrepareCurrentEffects {
  return {
    iso: () => '2026-11-15T00:00:00Z',
    liveItems: (q) => q.items.filter((i) => i.kind !== 'promotion'),
    selectorRef: (s) => {
      if (s !== 'promoted-main') throw new Error('KeyError ' + s);
      return 'origin/main';
    },
    revParseCommit: async () => T,
    revParseTree: async () => TREE,
    currentPaths: async () => over.paths ?? [row('b.ts'), row('a.ts')],
    reviewerVersion: async () => ' 9.9.9\n',
    buildCurrentProjection: async (target, selected) => {
      log.push('project:' + selected.join(','));
      return { base: 'e'.repeat(40), head: 'f'.repeat(40) };
    },
    updateRef: async (name, sha) => void log.push(`ref:${name}=${sha.slice(0, 1)}`),
    saveQueue: async () => void log.push('save'),
    readReceipt: async () => ({ receiptId: 'r', document: {} }),
    writeCurrentReceipt: async (_i, outcome) => {
      log.push('receipt:' + outcome);
      return 'rcpt-' + outcome;
    },
    ...over,
  };
}
const curItem = (extra: Item = {}): Item => ({
  id: 'mc-1',
  kind: 'merged-current',
  pr: 7,
  merge_commit: 'm'.repeat(40),
  state: 'pending',
  subject: { target_selector: 'promoted-main' },
  ...extra,
});

describe('prepareCurrent', () => {
  it('dry run returns the dispatch-pin plan and touches nothing', async () => {
    const log: string[] = [];
    const r = await prepareCurrent({ items: [] }, curItem(), true, currentFx(log));
    expect(r).toEqual({
      outcome: 'plan',
      plan: {
        base: '(dispatch-pin)',
        head: '(dispatch-pin)',
        target: 'promoted-main',
        cycle: null,
        branch: null,
        label: 'affected current files (not captured)',
        notes: [],
      },
    });
    expect(log).toEqual([]);
  });

  it('a live reviewing legacy merged item for the same PR is NotReady; promotion records are not live', async () => {
    const log: string[] = [];
    const legacy = { kind: 'merged', pr: 7, state: 'reviewing' };
    const r = await prepareCurrent({ items: [legacy] }, curItem(), false, currentFx(log));
    expect(r).toEqual({
      outcome: 'not-ready',
      reason: 'legacy source review still owns a live/ambiguous run; no new dispatch',
    });
    expect(log).toEqual([]);
    const other = await prepareCurrent(
      { items: [{ ...legacy, pr: 8 }] },
      curItem(),
      false,
      currentFx([]),
    );
    expect(other.outcome).toBe('plan');
  });

  it('captures, pins refs for base and head, saves, and plans the pinned target', async () => {
    const log: string[] = [];
    const item = curItem();
    const q: Queue = { items: [item] };
    const r = await prepareCurrent(q, item, false, currentFx(log));
    expect(log).toEqual([
      'project:a.ts,b.ts',
      'ref:refs/crq/current/mc-1/base=e',
      'ref:refs/crq/current/mc-1/head=f',
      'save',
    ]);
    const cap = item.capture as Record<string, unknown>;
    expect(cap.reviewer_version).toBe('9.9.9');
    expect(cap.captured_at).toBe('2026-11-15T00:00:00Z');
    expect(cap.equivalence).toBe(currentEquivalence(cap));
    expect(r).toEqual({
      outcome: 'plan',
      plan: {
        base: 'e'.repeat(40),
        head: 'f'.repeat(40),
        target: T,
        review_pin: T,
        cycle: null,
        branch: null,
        label: 'affected current files at ' + T,
        notes: [],
      },
    });
  });

  it('truncates the reviewer version to 100 code points, not UTF-16 units', async () => {
    const item = curItem();
    await prepareCurrent(
      { items: [item] },
      item,
      false,
      currentFx([], { reviewerVersion: async () => '😀'.repeat(150) }),
    );
    expect(
      Array.from((item.capture as { reviewer_version: string }).reviewer_version),
    ).toHaveLength(100);
    expect(pyPrefix('😀😀😀', 2)).toBe('😀😀');
  });

  it('no included path: unsupported beats no-current-code, receipt written, state set, nothing to review', async () => {
    for (const [disposition, outcome] of [
      ['unsupported', 'unsupported'],
      ['ambiguous', 'unsupported'],
      ['excluded-config', 'no-current-code'],
    ] as const) {
      const log: string[] = [];
      const item = curItem();
      const r = await prepareCurrent(
        { items: [item] },
        item,
        false,
        currentFx(log, { paths: [row('x.bin', { disposition })] }),
      );
      expect(r).toEqual({ outcome: 'nothing-to-review' });
      expect(item.state).toBe(outcome);
      expect(item.receipt_id).toBe('rcpt-' + outcome);
      expect(log).toEqual(['save', 'receipt:' + outcome, 'save']);
    }
  });

  it('an unknown target selector throws instead of planning', async () => {
    const item = curItem({ subject: { target_selector: 'nope' } });
    await expect(prepareCurrent({ items: [item] }, item, false, currentFx([]))).rejects.toThrow(
      'KeyError nope',
    );
  });

  describe('equivalent-subject reuse', () => {
    async function captured(): Promise<{ item: Item; q: Queue; fx: () => PrepareCurrentEffects }> {
      const item = curItem();
      const q: Queue = { items: [item] };
      await prepareCurrent(q, item, false, currentFx([]));
      return { item, q, fx: () => currentFx([]) };
    }
    const sibling = (item: Item, extra: Item): Item => ({
      id: 'mc-2',
      kind: 'merged-current',
      capture: { equivalence: (item.capture as { equivalence: string }).equivalence },
      ...extra,
    });

    it('an equivalent reviewing sibling blocks with its id', async () => {
      const { item, q, fx } = await captured();
      q.items.push(sibling(item, { state: 'reviewing' }));
      expect(await prepareCurrent(q, item, false, fx())).toEqual({
        outcome: 'not-ready',
        reason: 'equivalent current subject already reviewing: mc-2',
      });
    });

    it('a finished no-current-code sibling is adopted after its receipt matches', async () => {
      const { item, q } = await captured();
      q.items.push(sibling(item, { state: 'no-current-code', receipt_id: 'rc' }));
      const log: string[] = [];
      const r = await prepareCurrent(
        q,
        item,
        false,
        currentFx(log, {
          readReceipt: async () => ({ receiptId: 'rc', document: { capture: item.capture } }),
        }),
      );
      expect(r).toEqual({ outcome: 'nothing-to-review' });
      expect(item).toMatchObject({
        state: 'no-current-code',
        receipt_id: 'rc',
        reused_from: 'mc-2',
      });
      expect(log).toEqual(['save']);
    });

    it('a receipt whose scope differs throws instead of being reused', async () => {
      const { item, q } = await captured();
      q.items.push(sibling(item, { state: 'unsupported', receipt_id: 'rc' }));
      const other = structuredClone(item.capture) as Record<string, unknown>;
      other.tree = 'f'.repeat(40);
      await expect(
        prepareCurrent(
          q,
          item,
          false,
          currentFx([], {
            readReceipt: async () => ({ receiptId: 'rc', document: { capture: other } }),
          }),
        ),
      ).rejects.toThrow('reuse receipt scope mismatch');
    });

    it('a done sibling whose receipt is not countable evidence is skipped, not adopted', async () => {
      const { item, q } = await captured();
      q.items.push(sibling(item, { state: 'done', receipt_id: 'rc' }));
      const r = await prepareCurrent(
        q,
        item,
        false,
        currentFx([], {
          readReceipt: async () => ({
            receiptId: 'rc',
            document: { version: 1, counted: false, capture: item.capture },
          }),
        }),
      );
      expect(r.outcome).toBe('plan');
      expect(item.state).toBe('pending');
    });

    it('a done sibling with countable completed evidence is adopted', async () => {
      const { item, q } = await captured();
      q.items.push(sibling(item, { state: 'done', receipt_id: 'rc' }));
      const document = {
        version: 1,
        counted: true,
        outcome: 'terminal-clean',
        classification: { counted: true, outcome: 'completed' },
        capture: item.capture,
      };
      const r = await prepareCurrent(
        q,
        item,
        false,
        currentFx([], { readReceipt: async () => ({ receiptId: 'rc', document }) }),
      );
      expect(r).toEqual({ outcome: 'nothing-to-review' });
      expect(item.reused_from).toBe('mc-2');
    });

    it('a sibling with a different equivalence is ignored', async () => {
      const { item, q, fx } = await captured();
      q.items.push({
        id: 'mc-3',
        kind: 'merged-current',
        state: 'reviewing',
        capture: { equivalence: 'x' },
      });
      expect((await prepareCurrent(q, item, false, fx())).outcome).toBe('plan');
    });
  });
});

// ------------------------------------------------------------ push-current

const cfg: RepoConfig = {
  repo: 'o/other',
  name: 'other',
  clone: '/clones/other',
  defaultRef: 'origin/main',
};
const pushItem = (extra: Item = {}, subject: Item = {}): Item => ({
  id: 'push-other-aaaaaaaaaa-bbbbbbbbbb',
  kind: 'push-current',
  state: 'pending',
  subject: { type: 'push-range', repo: 'o/other', base: PB, head: PH, ...subject },
  ...extra,
});

function pushFx(
  log: string[],
  over: Partial<PreparePushEffects> & { paths?: PathRow[]; ancestor?: boolean } = {},
): PreparePushEffects {
  return {
    iso: () => '2026-11-15T00:00:00Z',
    repoConfig: () => cfg,
    itemRepo: () => 'o/other',
    inScope: (_c, p) => !p.startsWith('vendor/'),
    revParse: async (ref) => (ref.endsWith('^{tree}') ? TREE : T),
    isAncestor: async () => over.ancestor ?? true,
    currentPaths: async (target, pre, clone) => {
      log.push(`paths:${target.slice(0, 1)}:${pre.slice(0, 1)}:${clone}`);
      return over.paths ?? [row('b.ts'), row('a.ts')];
    },
    textBlob: async (_c, blob) => !blob.includes('bin'),
    enrollFollowup: (_q, _c, f) =>
      void log.push(`enroll:${f.id}<-${f.dependsOn}[${f.pathsFilter}]pin=${f.pin.slice(0, 1)}`),
    reviewerVersion: async () => '1.0',
    buildCurrentProjection: async (_t, selected, clone) => {
      log.push(`project:${selected}@${clone}`);
      return { base: 'e'.repeat(40), head: 'f'.repeat(40) };
    },
    updateRef: async (name, _sha, clone) => void log.push(`ref:${name}@${clone}`),
    saveQueue: async () => void log.push('save'),
    writeCurrentReceipt: async (_i, o) => 'rcpt-' + o,
    ...over,
  };
}

describe('preparePushCurrent', () => {
  it('dry run pins to the range head and touches nothing', async () => {
    const log: string[] = [];
    const r = await preparePushCurrent({ items: [] }, pushItem(), true, pushFx(log));
    expect(r).toEqual({
      outcome: 'plan',
      plan: {
        base: '(dispatch-pin)',
        head: '(dispatch-pin)',
        target: PH,
        cycle: null,
        branch: null,
        label: 'push range (not captured)',
        notes: [],
      },
    });
    expect(log).toEqual([]);
  });

  it('an unconfigured repo and a non-ancestor base are NotReady with the Python messages', async () => {
    const a = await preparePushCurrent(
      { items: [] },
      pushItem(),
      false,
      pushFx([], { repoConfig: () => undefined }),
    );
    expect(a).toEqual({
      outcome: 'not-ready',
      reason: 'push item repo is not configured: o/other',
    });
    const log: string[] = [];
    const b = await preparePushCurrent(
      { items: [] },
      pushItem(),
      false,
      pushFx(log, { ancestor: false }),
    );
    expect(b).toEqual({
      outcome: 'not-ready',
      reason: 'push base is not an ancestor of the repository default branch',
    });
    expect(log).toEqual([]);
  });

  it('captures in the repo clone with a push label, pinning both refs there', async () => {
    const log: string[] = [];
    const item = pushItem();
    const r = await preparePushCurrent({ items: [item] }, item, false, pushFx(log));
    expect(log).toEqual([
      `paths:a:c:/clones/other`,
      'project:a.ts,b.ts@/clones/other',
      `ref:refs/crq/current/${item.id as string}/base@/clones/other`,
      `ref:refs/crq/current/${item.id as string}/head@/clones/other`,
      'save',
    ]);
    expect(r).toMatchObject({
      outcome: 'plan',
      plan: {
        target: T,
        review_pin: T,
        label: `push range ${PB.slice(0, 12)}..${PH.slice(0, 12)} at ${T.slice(0, 12)}`,
      },
    });
  });

  it('a follow-up part pins to its parent target instead of re-resolving the default branch', async () => {
    const pin = '9'.repeat(40);
    const item = pushItem({}, { pin });
    await preparePushCurrent({ items: [item] }, item, false, pushFx([]));
    expect((item.capture as { target: string }).target).toBe(pin);
  });

  it('paths_filter keeps only the wanted paths; excluded-config rows never reach the projection', async () => {
    const log: string[] = [];
    const item = pushItem({}, { paths_filter: ['a.ts', 'vendor/x.ts'] });
    await preparePushCurrent(
      { items: [item] },
      item,
      false,
      pushFx(log, { paths: [row('a.ts'), row('b.ts'), row('vendor/x.ts')] }),
    );
    const paths = (item.capture as { paths: PathRow[] }).paths;
    expect(paths.map((r) => [r.path, r.disposition])).toEqual([
      ['a.ts', 'included'],
      ['vendor/x.ts', 'excluded-config'],
    ]);
    expect(paths[1]!.reason).toBe('excluded by repos config for o/other');
    expect(log).toContain('project:a.ts@/clones/other');
  });

  it('scope-cap rows are rescued into the split only when the blob is text', async () => {
    const capped = (path: string): PathRow =>
      row(path, { disposition: 'unsupported', reason: 'current content exceeds scope byte cap' });
    const item = pushItem();
    await preparePushCurrent(
      { items: [item] },
      item,
      false,
      pushFx([], { paths: [capped('text.ts'), capped('bin.dat'), row('keep.ts')] }),
    );
    const byPath = Object.fromEntries(
      (item.capture as { paths: PathRow[] }).paths.map((r) => [r.path, r]),
    ) as Record<string, PathRow>;
    expect(byPath['text.ts']!.disposition).toBe('included');
    expect(byPath['bin.dat']).toMatchObject({
      disposition: 'unsupported',
      reason: 'binary or non-UTF8 current blob',
    });
  });

  it('a per-file over-cap row (bytes above 256 KiB) is not rescued', async () => {
    const big = row('big.ts', {
      disposition: 'unsupported',
      reason: 'current content exceeds scope byte cap',
      bytes: 262145,
    });
    const item = pushItem();
    await preparePushCurrent(
      { items: [item] },
      item,
      false,
      pushFx([], { paths: [big, row('a.ts')] }),
    );
    const rows = (item.capture as { paths: PathRow[] }).paths;
    expect(rows.find((r) => r.path === 'big.ts')!.disposition).toBe('unsupported');
  });

  it('overflow past 2 MiB defers to the next -pN part, which is enrolled with parent, filter and pin', async () => {
    const log: string[] = [];
    const big = (p: string): PathRow => row(p, { bytes: 1500000 });
    const item = pushItem({ id: 'push-other-aaaaaaaaaa-bbbbbbbbbb-p2' });
    await preparePushCurrent(
      { items: [item] },
      item,
      false,
      pushFx(log, { paths: [big('c.ts'), big('a.ts'), big('b.ts')] }),
    );
    expect(log).toContain(
      'enroll:push-other-aaaaaaaaaa-bbbbbbbbbb-p3<-push-other-aaaaaaaaaa-bbbbbbbbbb-p2[b.ts,c.ts]pin=a',
    );
    const rows = (item.capture as { paths: PathRow[] }).paths;
    expect(rows.map((r) => [r.path, r.disposition])).toEqual([
      ['c.ts', 'deferred-split'],
      ['a.ts', 'included'],
      ['b.ts', 'deferred-split'],
    ]);
    expect(rows[0]!.reason).toBe(
      'deferred to follow-up review push-other-aaaaaaaaaa-bbbbbbbbbb-p3 (review scope cap)',
    );
    expect(log).toContain('project:a.ts@/clones/other');
  });

  it('first sorted candidates fit the cap in path order (code-point order, ties by source path)', async () => {
    const item = pushItem();
    const log: string[] = [];
    await preparePushCurrent(
      { items: [item] },
      item,
      false,
      pushFx(log, {
        paths: [
          row('z.ts', { bytes: 2097152 }),
          row('a.ts', { bytes: 1 }),
          row('😀.ts', { bytes: 1 }),
          row('\uFF5E.ts', { bytes: 1 }),
        ],
      }),
    );
    // a.ts fits first; z.ts alone would then overflow; U+FF5E sorts before U+1F600 by code point.
    expect(log.find((l) => l.startsWith('project:'))).toBe(
      'project:a.ts,\uFF5E.ts,😀.ts@/clones/other',
    );
    expect(log).toContain(
      'enroll:push-other-aaaaaaaaaa-bbbbbbbbbb-p2<-push-other-aaaaaaaaaa-bbbbbbbbbb[z.ts]pin=a',
    );
  });

  it('rows summing to exactly 2 MiB all fit; one more byte overflows', async () => {
    const run = async (second: number): Promise<string[]> => {
      const log: string[] = [];
      const item = pushItem();
      await preparePushCurrent(
        { items: [item] },
        item,
        false,
        pushFx(log, { paths: [row('a.ts', { bytes: 1048576 }), row('b.ts', { bytes: second })] }),
      );
      return log;
    };
    const fit = await run(1048576);
    expect(fit.some((l) => l.startsWith('enroll:'))).toBe(false);
    expect(fit).toContain('project:a.ts,b.ts@/clones/other');
    expect((await run(1048577)).some((l) => l.startsWith('enroll:'))).toBe(true);
  });

  it('no included path writes a receipt and finishes the item', async () => {
    const log: string[] = [];
    const item = pushItem();
    const r = await preparePushCurrent(
      { items: [item] },
      item,
      false,
      pushFx(log, { paths: [row('x', { disposition: 'excluded-config' })] }),
    );
    expect(r).toEqual({ outcome: 'nothing-to-review' });
    expect(item).toMatchObject({ state: 'no-current-code', receipt_id: 'rcpt-no-current-code' });
    expect(log).toEqual(['paths:a:c:/clones/other', 'save', 'save']);
  });

  it('an already captured item skips capture entirely', async () => {
    const item = pushItem();
    const q: Queue = { items: [item] };
    await preparePushCurrent(q, item, false, pushFx([]));
    const log: string[] = [];
    const r = await preparePushCurrent(q, item, false, pushFx(log));
    expect(log).toEqual([]);
    expect(r.outcome).toBe('plan');
  });
});

// ------------------------------------------------------------ local-review

const WANTED = {
  repo: 'o/other',
  base_commit: PB,
  head_commit: PH,
  config_digest: 'cfg',
};
const lrItem = (extra: Item = {}): Item => ({
  id: 'lr-1',
  kind: 'local-review',
  state: 'pending',
  generation: 1,
  profile: { name: 'p' },
  identity_inputs: { ...WANTED },
  ...extra,
});

function lrFx(
  log: string[],
  over: Partial<PrepareLocalReviewEffects> = {},
): PrepareLocalReviewEffects {
  return {
    iso: () => 'NOW',
    sameRepo: (a, b) => a === b,
    primaryRepo: 'o/primary',
    cloneFor: (r) => `/clone/${r}`,
    objectPresent: async (sha, clone) => {
      log.push(`present:${sha.slice(0, 1)}@${clone}`);
      return true;
    },
    fetch: async (clone) => void log.push('fetch:' + clone),
    facts: async () => ({ ...WANTED }),
    cycleFacts: async () => ({ ...WANTED }),
    equivalent: (a, b) => deepEqual(a, b),
    classify: async () => ({ counted: true, outcome: 'completed' }),
    complete: async (_q, _i, runId, _c, at) => void log.push(`complete:${runId}@${at}`),
    readMeta: async () => ({ base: PB, head: PH }),
    ...over,
  };
}
const pr = (extra: Item): Item => ({ kind: 'open', repo: 'o/other', cycles: [], ...extra });

describe('prepareLocalReview', () => {
  it('plans the pinned range with the item generation, profile and config digest', async () => {
    const item = lrItem({ generation: 3, repeat_requested: true });
    const r = await prepareLocalReview({ items: [item] }, item, false, lrFx([]));
    expect(r).toEqual({
      outcome: 'plan',
      plan: {
        base: PB,
        head: PH,
        target: PB,
        label: 'local full-diff review',
        cycle: 3,
        branch: null,
        notes: [],
        review_pin: PB,
        range_policy: 'full-range-once-v1',
        profile: { name: 'p' },
        config_digest: 'cfg',
      },
    });
  });

  it('fetches a foreign clone only when an object is missing, and never for the primary repo', async () => {
    const item = lrItem();
    const a: string[] = [];
    await prepareLocalReview({ items: [item] }, item, false, lrFx(a));
    expect(a).toEqual(['present:c@/clone/o/other', 'present:d@/clone/o/other']);
    const b: string[] = [];
    await prepareLocalReview(
      { items: [item] },
      item,
      false,
      lrFx(b, { objectPresent: async (sha) => sha === PB }),
    );
    expect(b).toEqual(['fetch:/clone/o/other']);
    const c: string[] = [];
    const primary = lrItem({ identity_inputs: { ...WANTED, repo: 'o/primary' } });
    await prepareLocalReview(
      { items: [primary] },
      primary,
      false,
      lrFx(c, { facts: async () => ({ ...WANTED, repo: 'o/primary' }) }),
    );
    expect(c).toEqual([]);
  });

  it('facts drift from the pinned inputs is NotReady', async () => {
    const item = lrItem();
    const r = await prepareLocalReview(
      { items: [item] },
      item,
      false,
      lrFx([], { facts: async () => ({ ...WANTED, config_digest: 'other' }) }),
    );
    expect(r).toEqual({ outcome: 'not-ready', reason: 'pinned-local-review-facts-mismatch' });
  });

  const done = { base: PB, head: PH, run_id: 'run-9', ndjson: '/r/x.ndjson', completed_at: 'T0' };

  it('an equivalent counted completed cycle completes the item from the receipt and spawns nothing', async () => {
    const item = lrItem();
    const log: string[] = [];
    const r = await prepareLocalReview(
      { items: [item, pr({ cycles: [done] })] },
      item,
      false,
      lrFx(log),
    );
    expect(r).toEqual({ outcome: 'nothing-to-review' });
    expect(log).toContain('complete:run-9@T0');
  });

  it('completed_at falls back to the clock', async () => {
    const item = lrItem();
    const log: string[] = [];
    await prepareLocalReview(
      { items: [item, pr({ cycles: [{ ...done, completed_at: null }] })] },
      item,
      false,
      lrFx(log),
    );
    expect(log).toContain('complete:run-9@NOW');
  });

  it('a dry run reports nothing-to-review without completing', async () => {
    const item = lrItem();
    const log: string[] = [];
    const r = await prepareLocalReview(
      { items: [item, pr({ cycles: [done] })] },
      item,
      true,
      lrFx(log),
    );
    expect(r).toEqual({ outcome: 'nothing-to-review' });
    expect(log.some((l) => l.startsWith('complete'))).toBe(false);
  });

  it('an uncounted or non-completed cycle is skipped and planning continues', async () => {
    for (const cls of [
      { counted: false, outcome: 'completed' },
      { counted: true, outcome: 'failed' },
    ]) {
      const item = lrItem();
      const log: string[] = [];
      const r = await prepareLocalReview(
        { items: [item, pr({ cycles: [done] })] },
        item,
        false,
        lrFx(log, { classify: async () => cls }),
      );
      expect(r.outcome).toBe('plan');
      expect(log.some((l) => l.startsWith('complete'))).toBe(false);
    }
  });

  it('a repeat request (explicit, or generation > 1 by default) ignores completed cycles', async () => {
    for (const extra of [{ repeat_requested: true }, { generation: 2 }]) {
      const item = lrItem(extra);
      const r = await prepareLocalReview(
        { items: [item, pr({ cycles: [done] })] },
        item,
        false,
        lrFx([]),
      );
      expect(r.outcome).toBe('plan');
    }
    const explicitNo = lrItem({ generation: 2, repeat_requested: false });
    const r = await prepareLocalReview(
      { items: [explicitNo, pr({ cycles: [done] })] },
      explicitNo,
      false,
      lrFx([]),
    );
    expect(r).toEqual({ outcome: 'nothing-to-review' });
  });

  it('only open/delta items of the same repo are considered; a missing repo means the primary repo', async () => {
    const item = lrItem();
    const q: Queue = {
      items: [
        item,
        pr({ kind: 'merged', cycles: [done] }),
        pr({ repo: 'o/else', cycles: [done] }),
        { kind: 'open', cycles: [done] }, // repo defaults to o/primary, not o/other
      ],
    };
    expect((await prepareLocalReview(q, item, false, lrFx([]))).outcome).toBe('plan');
  });

  it('a cycle for another range is skipped', async () => {
    const item = lrItem();
    const r = await prepareLocalReview(
      { items: [item, pr({ cycles: [{ ...done, head: 'z'.repeat(40) }] })] },
      item,
      false,
      lrFx([]),
    );
    expect(r.outcome).toBe('plan');
  });

  it('an equivalent live PR review blocks; completedOnly ignores the live run', async () => {
    const item = lrItem();
    const q: Queue = { items: [item, pr({ run: { run_id: 'live-1' } })] };
    expect(await prepareLocalReview(q, item, false, lrFx([]))).toEqual({
      outcome: 'not-ready',
      reason: 'equivalent-pr-review',
    });
    expect(
      (await prepareLocalReview(q, item, false, lrFx([]), { completedOnly: true })).outcome,
    ).toBe('plan');
  });

  it('a live run on another range, or with non-equivalent facts, does not block', async () => {
    const item = lrItem();
    const q: Queue = { items: [item, pr({ run: { run_id: 'live-1' } })] };
    expect(
      (
        await prepareLocalReview(
          q,
          item,
          false,
          lrFx([], { readMeta: async () => ({ base: PB, head: 'z' }) }),
        )
      ).outcome,
    ).toBe('plan');
    const r = await prepareLocalReview(q, item, false, lrFx([], { equivalent: () => false }));
    expect(r.outcome).toBe('plan');
  });
});

// ------------------------------------------------------ pr_info, quiet_reason

describe('prInfo', () => {
  it('asks gh for the fixed field list, defaulting to the primary repo', async () => {
    const calls: string[][] = [];
    const fx = { repo: 'o/primary', ghJson: async (a: string[]) => (calls.push(a), { number: 5 }) };
    expect(await prInfo(5, undefined, fx)).toEqual({ number: 5 });
    await prInfo(5, 'o/other', fx);
    expect(calls[0]).toEqual([
      'pr',
      'view',
      '5',
      '--repo',
      'o/primary',
      '--json',
      'number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt',
    ]);
    expect(calls[1]![4]).toBe('o/other');
  });

  it('a non-object forge answer throws', async () => {
    await expect(prInfo(1, undefined, { repo: 'r', ghJson: async () => [] })).rejects.toThrow();
  });
});

const INFO = {
  headRefName: 'feat/x',
  headRefOid: 'h'.repeat(40),
  updatedAt: '2026-11-15T00:00:00Z',
};

function quietFx(over: Partial<QuietReasonEffects> = {}): QuietReasonEffects {
  return {
    cloneFor: () => '/clone',
    activeAgentsFor: async () => [],
    ensureCommit: async () => true,
    commitTimestamp: async () => 1000,
    parseIsoSeconds: () => 900,
    nowSeconds: () => 1000 + 60 * 20,
    quietMinutes: 10,
    ...over,
  };
}

describe('quietReason', () => {
  const item: Item = { pr: 3 };

  it('fails closed when the agent list is unavailable, before anything else', async () => {
    const r = await quietReason(item, INFO, true, quietFx({ activeAgentsFor: async () => null }));
    expect(r).toBe('paseo agent list unavailable (fail closed)');
  });

  it('active agents block even with ignoreAge', async () => {
    const r = await quietReason(
      item,
      INFO,
      true,
      quietFx({ activeAgentsFor: async () => ['a1 t', 'b2 u'] }),
    );
    expect(r).toBe('active agent(s): a1 t; b2 u');
  });

  it('ignoreAge returns quiet without reading git', async () => {
    const r = await quietReason(
      item,
      INFO,
      true,
      quietFx({
        commitTimestamp: async () => {
          throw new Error('git read');
        },
      }),
    );
    expect(r).toBeNull();
  });

  it('our own addressing push is quiet without reading git', async () => {
    const r = await quietReason(
      { pr: 3, last_push: { sha: INFO.headRefOid } },
      INFO,
      false,
      quietFx({
        ensureCommit: async () => {
          throw new Error('git read');
        },
      }),
    );
    expect(r).toBeNull();
    const other = await quietReason({ pr: 3, last_push: { sha: 'x' } }, INFO, false, quietFx());
    expect(other).toBeNull(); // 20m old, window 10m
  });

  it('a head missing from the clone is reported', async () => {
    expect(await quietReason(item, INFO, false, quietFx({ ensureCommit: async () => false }))).toBe(
      'source head unavailable in repository clone',
    );
  });

  it('uses the later of commit time and forge updatedAt, and reports minutes', async () => {
    const fx = quietFx({
      commitTimestamp: async () => 1000,
      parseIsoSeconds: () => 1000 + 60 * 18,
      nowSeconds: () => 1000 + 60 * 20,
    });
    expect(await quietReason(item, INFO, false, fx)).toBe(
      'recent activity 2m ago (< 10m quiet window)',
    );
  });

  it('the window boundary is exclusive: exactly quiet_minutes old is quiet', async () => {
    const at = (age: number): QuietReasonEffects =>
      quietFx({
        commitTimestamp: async () => 0,
        parseIsoSeconds: () => 0,
        nowSeconds: () => age * 60,
      });
    expect(await quietReason(item, INFO, false, at(10))).toBeNull();
    expect(await quietReason(item, INFO, false, at(9.5))).toBe(
      'recent activity 10m ago (< 10m quiet window)',
    );
  });

  it('threads the item PR, branch and clone through to its collaborators', async () => {
    const seen: unknown[] = [];
    await quietReason(
      item,
      INFO,
      false,
      quietFx({
        activeAgentsFor: async (p, b) => (seen.push(['agents', p, b]), []),
        ensureCommit: async (p, s, c) => (seen.push(['ensure', p, s.slice(0, 1), c]), true),
        commitTimestamp: async (s, c) => (seen.push(['ct', s.slice(0, 1), c]), 0),
      }),
    );
    expect(seen).toEqual([
      ['agents', 3, 'feat/x'],
      ['ensure', 3, 'h', '/clone'],
      ['ct', 'h', '/clone'],
    ]);
  });
});

describe('formatAge (Python "%.0f")', () => {
  it('rounds half to even, keeps the sign of small negatives', () => {
    expect([0.5, 1.5, 2.5, 3.5, 2.4, 2.6].map(formatAge)).toEqual(['0', '2', '2', '4', '2', '3']);
    expect(formatAge(-0.4)).toBe('-0');
    expect(formatAge(-1.5)).toBe('-2');
  });
});

describe('support helpers', () => {
  it('deepEqual compares nested JSON structurally and order-insensitively for keys', () => {
    expect(deepEqual({ a: [1, { b: 2 }], c: 3 }, { c: 3, a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(receiptJsonDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
