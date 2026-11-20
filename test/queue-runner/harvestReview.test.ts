import { describe, expect, it } from 'vitest';
import { JsonNumber } from '../../src/policy/crq/jsonValue.js';
import {
  CoverageLineageError,
  harvestReview,
  type Classification,
  type HarvestReviewEffects,
  type Item,
  type Queue,
  type Rec,
} from '../../src/queue-runner/harvestReview.js';

const NOW = Date.parse('2026-11-20T00:00:00Z');
const iso = (ms: number = NOW): string => new Date(ms).toISOString().slice(0, 19) + 'Z';

function cls(over: Rec = {}): Classification {
  return {
    outcome: 'completed',
    findings: 0,
    severity_counts: {},
    counted: true,
    message: null,
    ...over,
  } as Classification;
}

const META = {
  run_id: 'r-1',
  worktree: '/wt/r-1',
  wt_branch: 'wt/r-1',
  head: 'h1',
  base: 'b1',
  cycle: 1,
};

function harness(
  c: Classification = cls(),
  over: Partial<HarvestReviewEffects> = {},
  state: 'alive' | 'ambiguous' | 'harvest' = 'harvest',
) {
  const calls: string[] = [];
  const events: Array<[string, Rec]> = [];
  const saved: string[] = [];
  const recorded: Rec[] = [];
  const fx: HarvestReviewEffects = {
    kinds: {
      localReview: 'local-review',
      reviewReceipt: 'review-receipt',
      pushCurrent: 'push-current',
      backfill: 'backfill',
      author: 'author',
    },
    config: { maxItemFailures: 3, errorBackoffMin: 5, rateLimitDefaultBackoffMin: 30 },
    coverage: {
      newLedger: () => ({ runs: {} }),
      legacyOrigins: () => void calls.push('origins'),
      recordReview: (ledger, args) => (recorded.push(args), { ...(ledger as Rec), last: args }),
      recordLegacySuccess: (_q, _i, paths) => void calls.push('legacy-ok:' + paths.join(',')),
      recordLegacyFailure: (_q, _i, _at, outcome, runId) =>
        void calls.push(`legacy-fail:${outcome}:${runId}`),
    },
    exitFileExists: async (id) => (calls.push('exit?:' + id), true),
    runLiveness: async (id, _i, _r, has) => (calls.push(`live:${id}:${String(has)}`), state),
    readExitCode: async () => (calls.push('readExit'), 0),
    readEndedAtMs: async () => NOW,
    writeNext: async () => void calls.push('next'),
    readMeta: async () => (calls.push('meta'), { ...META }),
    classify: async () => (calls.push('classify'), c),
    writeClassification: async () => void calls.push('write-cls'),
    writeFindings: async () => void calls.push('write-findings'),
    runPath: (id, name) => `/runs/${id}/${name}`,
    readReviewText: async () => (calls.push('stream'), ''),
    event: async (kind, data) => void events.push([kind, data]),
    saveQueue: async () => void (saved.push('save'), calls.push('save')),
    removeWorktree: async (wt, br, clone) =>
      void calls.push(`rm:${String(wt)}:${String(br)}:${String(clone)}`),
    nowMs: () => NOW,
    iso,
    itemRepo: () => 'acme/primary',
    isPrimaryRepo: (repo) => repo === 'acme/primary',
    cloneFor: (repo) => `/clones/${repo}`,
    writeReceipt: async (_i, outcome) => (calls.push('receipt:' + outcome), 'rcpt-1'),
    mergedCurrentEnabled: () => true,
    repairEnqueue: async () => (calls.push('repair'), null),
    backfillHarvest: async () => (calls.push('backfill'), 'backfill done'),
    requestPrReview: async () => void calls.push('pr-review'),
    ...over,
  };
  return { fx, calls, events, saved, recorded };
}

function item(over: Item = {}): Item {
  return {
    id: 'a',
    kind: 'open',
    state: 'reviewing',
    run: { run_id: 'r-1', band: 'fast', started_at: 't0' },
    attempts: [],
    ...over,
  };
}
const captureItem = (over: Item = {}): Item =>
  item({
    capture: { paths: [{ disposition: 'reviewed' }], target: 'tip' },
    subject: { base: 'b1', head: 'h1' },
    ...over,
  });

describe('harvestReview liveness', () => {
  it('refuses a local-review item (it has its own port)', async () => {
    const h = harness();
    await expect(harvestReview({}, item({ kind: 'local-review' }), false, h.fx)).rejects.toThrow(
      /local-review/,
    );
  });

  it('records a wait reason and does nothing else while the run is alive', async () => {
    const h = harness(cls(), {}, 'alive');
    const it = item();
    expect(await harvestReview({}, it, false, h.fx)).toBeNull();
    expect(it.wait_reason).toBe('detached review still alive');
    expect(h.calls).toEqual(['exit?:r-1', 'live:r-1:true']);
    const author = item({ kind: 'author' });
    await harvestReview({}, author, false, h.fx);
    expect(author.wait_reason).toBe('author: run alive');
  });

  it('fails closed on an ambiguous run: event only when live, wait reason either way', async () => {
    const h = harness(cls(), {}, 'ambiguous');
    const it = item();
    expect(await harvestReview({}, it, false, h.fx)).toBeNull();
    expect(h.events).toEqual([['review_ambiguous', { item: 'a', run: 'r-1' }]]);
    expect(String(it.wait_reason)).toMatch(/^run not releasable/);
    expect(h.calls).toEqual(['exit?:r-1', 'live:r-1:true']);
    const dry = harness(cls(), {}, 'ambiguous');
    const author = item({ kind: 'author' });
    await harvestReview({}, author, true, dry.fx);
    expect(dry.events).toEqual([]);
    expect(String(author.wait_reason)).toMatch(/^author: run not releasable/);
  });

  it('passes whether exit.json exists to liveness', async () => {
    const h = harness(cls(), { exitFileExists: async () => false }, 'alive');
    await harvestReview({}, item(), false, h.fx);
    expect(h.calls).toEqual(['live:r-1:false']);
  });

  it('reads the exit code then stops for a dry harvest, writing nothing', async () => {
    const h = harness();
    expect(await harvestReview({}, item(), true, h.fx)).toBe('would harvest r-1');
    expect(h.calls).toEqual(['exit?:r-1', 'live:r-1:true', 'readExit']);
    expect(h.events).toEqual([]);
  });

  it('a missing run or run_id is a KeyError, not a skip', async () => {
    const h = harness();
    const bare: Item = { id: 'a', kind: 'open', state: 'reviewing' };
    await expect(harvestReview({}, bare, false, h.fx)).rejects.toThrow(/run missing/);
    await expect(harvestReview({}, item({ run: {} }), false, h.fx)).rejects.toThrow(/run_id/);
  });
});

describe('harvestReview artifacts', () => {
  it('writes next-review-at, classification and findings, then review_finished, before kind logic', async () => {
    const c = cls({ findings: 2, severity_counts: { high: 2 } });
    const h = harness(c);
    await harvestReview({}, item({ kind: 'open' }), false, h.fx);
    expect(h.calls.slice(0, 7)).toEqual([
      'exit?:r-1',
      'live:r-1:true',
      'readExit',
      'next',
      'meta',
      'classify',
      'write-cls',
    ]);
    expect(h.calls[7]).toBe('write-findings');
    expect(h.events[0]).toEqual([
      'review_finished',
      { item: 'a', run: 'r-1', outcome: 'completed', findings: 2, severity: { high: 2 } },
    ]);
  });
});

describe('harvestReview classification keys', () => {
  const without = (key: string): Classification => {
    const c = { ...cls() } as Rec;
    delete c[key];
    return c as Classification;
  };

  it.each(['outcome', 'findings', 'severity_counts'])(
    'a classification missing %s aborts before review_finished and leaves the run intact',
    async (key) => {
      const h = harness(without(key));
      const it = item();
      await expect(harvestReview({}, it, false, h.fx)).rejects.toThrow(`classification.${key}`);
      expect(h.events).toEqual([]);
      expect(it.state).toBe('reviewing');
      expect(it.run).not.toBeNull();
    },
  );

  it.each(['review-receipt', 'push-current', 'open'])(
    'a classification missing counted aborts the %s harvest without consuming the run',
    async (kind) => {
      const h = harness(without('counted'));
      const it = captureItem({ kind });
      await expect(harvestReview({}, it, false, h.fx)).rejects.toThrow('classification.counted');
      expect(it.state).toBe('reviewing');
      expect(it.run).not.toBeNull();
    },
  );
});

describe('harvestReview open/delta completed', () => {
  const stream = [
    'not json',
    JSON.stringify({ type: 'progress' }),
    JSON.stringify({
      type: 'complete',
      reviewedFiles: ['a.ts', { path: 'b.ts' }, { path: '', fileName: 'c.ts' }, { path: '' }, 7],
    }),
    JSON.stringify({ type: 'complete', reviewedFiles: 3 }),
  ].join('\n');

  it('records a cycle and coverage from the terminal stream; clean repair leaves it done', async () => {
    const h = harness(cls({ findings: 1 }), { readReviewText: async () => stream });
    const q: Queue = {};
    const it = item({ pr: 12 });
    const msg = await harvestReview(q, it, false, h.fx);
    expect(msg).toBe('a: completed (1 findings)');
    expect(it.state).toBe('done');
    expect(it.run).toBeNull();
    expect(it.failures).toBe(0);
    expect(it.last_error).toBeNull();
    expect(it.cycles).toEqual([
      {
        run_id: 'r-1',
        cycle: 1,
        base: 'b1',
        head: 'h1',
        pr_head: 'h1',
        dirty_diff: 'clean tree',
        range_policy: null,
        ndjson: '/runs/r-1/review.ndjson',
        findings: 1,
        severity_counts: {},
        completed_at: iso(),
      },
    ]);
    expect(h.recorded).toEqual([
      {
        runId: 'r-1',
        completedAt: iso(),
        reviewedPaths: ['a.ts', 'b.ts', 'c.ts'],
        reviewSha: 'h1',
        counted: true,
        outcome: 'completed',
        focusPaths: null,
      },
    ]);
    expect(h.calls).toContain('pr-review');
    // Worktree is removed before the attempt is appended and the run is cleared.
    expect(h.calls.indexOf('rm:/wt/r-1:wt/r-1:null')).toBeGreaterThan(-1);
    expect(it.attempts).toEqual([
      {
        run_id: 'r-1',
        band: 'fast',
        started_at: 't0',
        outcome: 'completed',
        counted: true,
        at: iso(),
        head: 'h1',
        base: 'b1',
        message: null,
      },
    ]);
  });

  it('prefers coverage_sha, then reviewed_tip, and the coverage paths for focus', async () => {
    const meta = { ...META, coverage_sha: 'cs', reviewed_tip: 'rt', coverage_paths: ['x'] };
    const h = harness(cls(), { readMeta: async () => meta });
    await harvestReview({}, item(), false, h.fx);
    expect(h.recorded[0]).toMatchObject({ reviewSha: 'cs', focusPaths: ['x'] });
    const h2 = harness(cls(), {
      readMeta: async () => ({ ...META, reviewed_tip: 'rt', planned_paths: ['p'] }),
    });
    await harvestReview({}, item(), false, h2.fx);
    expect(h2.recorded[0]).toMatchObject({ reviewSha: 'rt', focusPaths: ['p'] });
  });

  it('keeps profile and config digest on the cycle only when a profile is set', async () => {
    const h = harness(cls(), {
      readMeta: async () => ({ ...META, profile: 'deep', config_digest: 'cd' }),
    });
    const it = item();
    await harvestReview({}, it, false, h.fx);
    expect(it.cycles).toMatchObject([{ profile: 'deep', config_digest: 'cd' }]);
    const bad = harness(cls(), { readMeta: async () => ({ ...META, profile: 'deep' }) });
    await expect(harvestReview({}, item(), false, bad.fx)).rejects.toThrow(/config_digest/);
  });

  it('enqueues repair and reports repairing when repair is pending', async () => {
    const h = harness(cls({ findings: 3 }), { repairEnqueue: async () => ({ jobs: 1 }) });
    const it = item();
    await harvestReview({}, it, false, h.fx);
    expect(it.state).toBe('repairing');
  });

  it('a clean PR review request is recorded as debt on the item', async () => {
    const h = harness(cls({ findings: 0 }));
    const it = item({ pr: 9 });
    await harvestReview({}, it, false, h.fx);
    expect(it.clean_review_request).toEqual({
      run_id: 'r-1',
      pr: 9,
      base: 'b1',
      head: 'h1',
      ndjson: '/runs/r-1/review.ndjson',
    });
    expect(it.clean_review_pending).toBe(true);
    expect(it.clean_review_attempts).toBe(0);
    expect(h.calls).not.toContain('pr-review');
  });

  it('a foreign open review is done with no coverage or repair, cleaned in its own clone', async () => {
    const h = harness(cls({ findings: 2 }), { itemRepo: () => 'acme/other' });
    const it = item({ pr: 3 });
    const msg = await harvestReview({}, it, false, h.fx);
    expect(msg).toBe('a: completed (2 findings)');
    expect(it.state).toBe('done');
    expect(h.recorded).toEqual([]);
    expect(h.calls).not.toContain('repair');
    expect(h.calls).toContain('rm:/wt/r-1:wt/r-1:/clones/acme/other');
    expect(h.calls).toContain('pr-review');
    expect(h.calls).not.toContain('stream');
  });

  it('an author completion is cycle evidence only: no repair, coverage or PR review', async () => {
    const h = harness(cls({ findings: 4 }));
    const it = item({ kind: 'author', pr: 1 });
    const msg = await harvestReview({}, it, false, h.fx);
    expect(msg).toBe('a: completed (4 findings) [author: no repair/coverage credit]');
    expect(it.state).toBe('done');
    expect(it.author_cycles).toHaveLength(1);
    expect(it.cycles).toBeUndefined();
    expect(h.recorded).toEqual([]);
    expect(h.calls).not.toContain('pr-review');
    expect(h.calls).not.toContain('repair');
  });

  it('starts a fresh ledger only when the queue has none', async () => {
    const h = harness();
    const q: Queue = { coverage: { runs: { old: 1 } } };
    await harvestReview(q, item(), false, h.fx);
    expect((q.coverage as Rec).runs).toEqual({ old: 1 });
    const q2: Queue = {};
    await harvestReview(q2, item(), false, h.fx);
    expect((q2.coverage as Rec).runs).toEqual({});
  });
});

describe('harvestReview uncounted outcomes', () => {
  it('rate limit: cooldown, deadline, doubled backoff, item returns to pending', async () => {
    const h = harness(
      cls({ outcome: 'rate_limited', counted: false, message: 'slow down', wait_seconds: 600 }),
    );
    const q: Queue = { rl_backoff_min: 20 };
    const it = item();
    const msg = await harvestReview(q, it, false, h.fx);
    expect(q.cooldown_until).toBe(iso(NOW + 600_000));
    expect(msg).toBe(`a: rate limited → global cooldown until ${iso(NOW + 600_000)}`);
    expect(q.rl_backoff_min).toBe(40);
    expect(it.state).toBe('pending');
    expect(it.last_error).toBe('rate limited (slow down); not counted');
    expect((it.attempts as Rec[])[0]).toMatchObject({
      outcome: 'rate_limited',
      deadline: iso(NOW + 600_000),
    });
  });

  it('rate limit without a wait uses the queue backoff minutes, capped at 240 doubled', async () => {
    const h = harness(cls({ outcome: 'rate_limited', counted: false }));
    const q: Queue = {};
    await harvestReview(q, item(), false, h.fx);
    expect(q.cooldown_until).toBe(iso(NOW + 30 * 60_000));
    expect(q.rl_backoff_min).toBe(60);
    const big: Queue = { rl_backoff_min: 200 };
    await harvestReview(
      big,
      item(),
      false,
      harness(cls({ outcome: 'rate_limited', counted: false })).fx,
    );
    expect(big.rl_backoff_min).toBe(240);
  });

  it('keeps the later of an existing and a new cooldown', async () => {
    const later = iso(NOW + 3_600_000);
    const h = harness(cls({ outcome: 'rate_limited', counted: false, wait_seconds: 60 }));
    const q: Queue = { cooldown_until: later };
    await harvestReview(q, item(), false, h.fx);
    expect(q.cooldown_until).toBe(later);
  });

  it('a float backoff stays a float after doubling', async () => {
    const h = harness(cls({ outcome: 'rate_limited', counted: false }));
    const q: Queue = { rl_backoff_min: JsonNumber.float(1.5) };
    await harvestReview(q, item(), false, h.fx);
    const next = q.rl_backoff_min as JsonNumber;
    expect(next).toBeInstanceOf(JsonNumber);
    expect(next.kind).toBe('float');
    expect(next.float).toBe(3);
  });

  it('an author rate limit is a consumed terminal with no retry', async () => {
    const h = harness(cls({ outcome: 'rate_limited', counted: false, wait_seconds: 60 }));
    const it = item({ kind: 'author' });
    const q: Queue = {};
    const msg = await harvestReview(q, it, false, h.fx);
    expect(msg).toBe(
      `a: rate limited → global cooldown until ${iso(NOW + 60_000)}; author terminal (no retry)`,
    );
    expect(it.state).toBe('author_failed');
    expect(it.run).toBeNull();
    expect(String(it.last_error)).toMatch(/no automatic retry — owner disposition required$/);
    expect(h.events.at(-1)).toEqual([
      'author_failed',
      { item: 'a', run: 'r-1', outcome: 'rate_limited' },
    ]);
  });

  it.each(['auth', 'action_required'])(
    '%s pauses the queue and keeps the item pending',
    async (o) => {
      const h = harness(cls({ outcome: o, counted: false, message: 'login' }));
      const q: Queue = {};
      const it = item();
      const msg = await harvestReview(q, it, false, h.fx);
      const reason = `${o} on r-1: login — owner action needed (never --use-credits)`;
      expect(q.paused).toBe(true);
      expect(q.pause_reason).toBe(reason);
      expect(it.last_error).toBe(reason);
      expect(it.state).toBe('pending');
      expect(msg).toBe(`a: ${o} → queue PAUSED`);
      expect(h.events.at(-1)).toEqual(['queue_paused', { reason }]);
    },
  );

  it('an author auth failure is terminal and quotes the pause', async () => {
    const h = harness(cls({ outcome: 'auth', counted: false, message: 'x' }));
    const it = item({ kind: 'author' });
    const msg = await harvestReview({}, it, false, h.fx);
    expect(msg).toBe('a: auth → queue PAUSED; author terminal (no retry)');
    expect(it.state).toBe('author_failed');
    expect(String(it.last_error)).toMatch(/^auth → queue PAUSED \(auth on r-1: x/);
  });

  it('backs off exponentially on an error and blocks at the failure ceiling', async () => {
    const make = () => harness(cls({ outcome: 'error', counted: false, message: 'boom' }));
    const first = item({ failures: JsonNumber.int(0) });
    expect(await harvestReview({}, first, false, make().fx)).toBe(
      'a: error (not counted) → pending',
    );
    expect(first.failures).toBe(1);
    expect(first.not_before).toBe(iso(NOW + 5 * 60_000));
    expect(first.last_error).toBe('error: boom');
    const third = item({ failures: 1 });
    await harvestReview({}, third, false, make().fx);
    expect(third.not_before).toBe(iso(NOW + 10 * 60_000));
    const last = item({ failures: 2 });
    expect(await harvestReview({}, last, false, make().fx)).toBe(
      'a: error (not counted) → blocked',
    );
    expect(last.not_before).toBeUndefined();
  });

  it.each(['skipped', 'too_large'])('%s blocks at once', async (o) => {
    const h = harness(cls({ outcome: o, counted: false, message: 'm' }));
    const it = item();
    await harvestReview({}, it, false, h.fx);
    expect(it.state).toBe('blocked');
    expect(it.failures).toBe(1);
  });

  it('an author error is terminal even before the failure ceiling', async () => {
    const h = harness(cls({ outcome: 'error', counted: false, message: 'm' }));
    const it = item({ kind: 'author' });
    const msg = await harvestReview({}, it, false, h.fx);
    expect(msg).toBe('a: error (not counted) → author_failed (author, no retry)');
    expect(String(it.last_error)).toBe(
      'author review error (not counted): m; no automatic retry — owner disposition required',
    );
  });

  it('a legacy coverage item records its failure lineage', async () => {
    const h = harness(cls({ outcome: 'error', counted: false, message: 'm' }));
    await harvestReview({}, item({ kind: 'coverage' }), false, h.fx);
    expect(h.calls).toContain('legacy-fail:error:r-1');
  });
});

describe('harvestReview review_receipt', () => {
  const kind = 'review-receipt';

  it('writes the receipt first, tracks repair separately, then saves and cleans up', async () => {
    const h = harness(cls({ findings: 2 }));
    const q: Queue = {};
    const it = captureItem({ kind });
    const msg = await harvestReview(q, it, false, h.fx);
    expect(msg).toBe(
      'a: terminal-with-findings; receipt rcpt-1 (repair evidence tracked separately)',
    );
    expect(it.state).toBe('done');
    expect(it.receipt_id).toBe('rcpt-1');
    expect(it.remediation_state).toBe('pending-merged-evidence');
    expect(it.run).toBeNull();
    expect(h.calls).toContain('repair');
    // Crash-recovery order: receipt, then the queue save, then worktree cleanup.
    const trace = h.calls.filter((c) => /^(receipt:|save$|rm:)/.test(c));
    expect(trace).toEqual(['receipt:terminal-with-findings', 'save', 'rm:/wt/r-1:wt/r-1:null']);
    expect(h.saved).toEqual(['save']);
    expect(it.attempts).toEqual([
      {
        run_id: 'r-1',
        band: 'fast',
        started_at: 't0',
        outcome: 'completed',
        counted: true,
        receipt_id: 'rcpt-1',
      },
    ]);
  });

  it('a repair enqueue failure is recorded, truncated by code point, never thrown', async () => {
    const h = harness(cls({ findings: 1 }), {
      repairEnqueue: async () => {
        throw new Error('😀'.repeat(400));
      },
    });
    const it = captureItem({ kind });
    await harvestReview({}, it, false, h.fx);
    expect(Array.from(String(it.repair_error))).toHaveLength(300);
    expect(it.state).toBe('done');
  });

  it('partial scope is its own outcome and never enqueues repair', async () => {
    const h = harness(cls({ findings: 1 }));
    const it = captureItem({
      kind,
      capture: { paths: [{ disposition: 'ambiguous' }], target: 'tip' },
    });
    const msg = await harvestReview({}, it, false, h.fx);
    expect(msg).toMatch(/^a: partial-scope; receipt rcpt-1/);
    expect(it.remediation_state).toBeUndefined();
    expect(h.calls).not.toContain('repair');
  });

  it('a clean counted receipt does not enqueue repair', async () => {
    const h = harness(cls({ findings: 0 }));
    const msg = await harvestReview({}, captureItem({ kind }), false, h.fx);
    expect(msg).toMatch(/^a: terminal-clean;/);
    expect(h.calls).not.toContain('repair');
  });

  it('repair is skipped when merged-current repair is disabled', async () => {
    const h = harness(cls({ findings: 5 }), { mergedCurrentEnabled: () => false });
    await harvestReview({}, captureItem({ kind }), false, h.fx);
    expect(h.calls).not.toContain('repair');
  });

  it('an uncounted receipt blocks the item; rate limit and auth still act on the queue', async () => {
    const rl = harness(
      cls({ outcome: 'rate_limited', counted: false, message: 'm', wait_seconds: 60 }),
    );
    const q: Queue = {};
    const it = captureItem({ kind });
    const msg = await harvestReview(q, it, false, rl.fx);
    expect(msg).toMatch(/^a: rate_limited; receipt rcpt-1/);
    expect(it.state).toBe('blocked');
    expect(it.last_error).toBe('m');
    expect(q.cooldown_until).toBe(iso(NOW + 60_000));
    const auth = harness(cls({ outcome: 'auth', counted: false, message: 'm' }));
    const q2: Queue = {};
    await harvestReview(q2, captureItem({ kind }), false, auth.fx);
    expect(q2).toEqual({ paused: true, pause_reason: 'auth on r-1; owner action needed' });
  });

  it('a missing capture is a KeyError before any receipt is written', async () => {
    const h = harness(cls());
    await expect(harvestReview({}, item({ kind }), false, h.fx)).rejects.toThrow(/capture/);
    expect(h.calls.some((c) => c.startsWith('receipt:'))).toBe(false);
  });
});

describe('harvestReview push_current', () => {
  const kind = 'push-current';

  it('a counted whole-range review advances reviewed_tip and keeps findings as delivery debt', async () => {
    const h = harness(cls({ findings: 2, severity_counts: { high: 2 } }));
    const q: Queue = {};
    const it = captureItem({ kind, failures: 2, last_error: 'old' });
    const msg = await harvestReview(q, it, false, h.fx);
    expect(msg).toBe('a: terminal-with-findings; receipt rcpt-1');
    expect((q.push_discovery as Rec)['acme/primary']).toEqual({ reviewed_tip: 'tip' });
    expect(it.state).toBe('done');
    expect(it.failures).toBe(0);
    expect(it.last_error).toBeNull();
    expect(it.issue_pending).toBe(true);
    expect(it.issue_request).toEqual({
      run_id: 'r-1',
      severity_counts: { high: 2 },
      findings_md: '/runs/r-1/findings.md',
      base: 'b1',
      head: 'h1',
    });
    expect(h.calls).toContain('rm:/wt/r-1:wt/r-1:/clones/acme/primary');
    expect(h.saved).toEqual(['save']);
  });

  it('only advances reviewed_tip from the pinned base or when unset; a split part never does', async () => {
    const at = (reviewed: unknown, over: Item = {}) => {
      const q: Queue = { push_discovery: { 'acme/primary': { reviewed_tip: reviewed } } };
      return harvestReview(q, captureItem({ kind, ...over }), false, harness().fx).then(
        () => ((q.push_discovery as Rec)['acme/primary'] as Rec).reviewed_tip,
      );
    };
    expect(await at('b1')).toBe('tip');
    expect(await at(null)).toBe('tip');
    expect(await at('other')).toBe('other');
    expect(await at('b1', { depends_on: 'x' })).toBe('b1');
    expect(await at('b1', { subject: { base: 'b1', head: 'h1', paths_filter: ['a'] } })).toBe('b1');
  });

  it('a rate limit leaves it pending with a cooldown and does not advance the tip', async () => {
    const h = harness(
      cls({ outcome: 'rate_limited', counted: false, message: 'm', wait_seconds: 60 }),
    );
    const q: Queue = {};
    const it = captureItem({ kind });
    await harvestReview(q, it, false, h.fx);
    expect(it.state).toBe('pending');
    expect(it.last_error).toBe('rate limited (m); not counted');
    expect(q.push_discovery).toBeUndefined();
    expect(q.cooldown_until).toBe(iso(NOW + 60_000));
  });

  it('auth pauses; an error backs off and eventually blocks', async () => {
    const auth = harness(cls({ outcome: 'auth', counted: false, message: 'm' }));
    const q: Queue = {};
    const a = captureItem({ kind });
    await harvestReview(q, a, false, auth.fx);
    expect(q.paused).toBe(true);
    expect(a.state).toBe('pending');
    expect(a.last_error).toBe('m');
    const err = () => harness(cls({ outcome: 'error', counted: false, message: 'e' }));
    const b = captureItem({ kind, failures: 0 });
    await harvestReview({}, b, false, err().fx);
    expect(b.state).toBe('pending');
    expect(b.not_before).toBe(iso(NOW + 5 * 60_000));
    expect(b.last_error).toBe('error: e');
    const c = captureItem({ kind, failures: 2 });
    await harvestReview({}, c, false, err().fx);
    expect(c.state).toBe('blocked');
  });
});

describe('harvestReview backfill and coverage', () => {
  it('delegates backfill, then records the attempt and saves once the run is cleared', async () => {
    let seen: unknown[] = [];
    const h = harness(cls(), {
      backfillHarvest: async (...args) => {
        seen = args.slice(2);
        (args[1] as Item).run = null;
        return 'bf';
      },
    });
    const it = item({ kind: 'backfill' });
    expect(await harvestReview({}, it, false, h.fx)).toBe('bf');
    expect(seen[0]).toBe('r-1');
    expect(seen.at(-2)).toBe(0);
    expect(seen.at(-1)).toBe(true);
    expect(it.attempts).toEqual([
      { run_id: 'r-1', band: 'fast', started_at: 't0', outcome: 'completed' },
    ]);
    expect(h.saved).toEqual(['save']);
  });

  it('does not duplicate an attempt the delegate already recorded, nor record while still running', async () => {
    const recorded = harness(cls(), {
      backfillHarvest: async (_q, it) => {
        (it as Item).run = null;
        return null;
      },
    });
    const it = item({ kind: 'backfill', attempts: [{ run_id: 'r-1' }] });
    expect(await harvestReview({}, it, false, recorded.fx)).toBeNull();
    expect(it.attempts).toHaveLength(1);
    expect(recorded.saved).toEqual([]);
    const running = harness(cls());
    const live = item({ kind: 'backfill' });
    await harvestReview({}, live, false, running.fx);
    expect(live.attempts).toEqual([]);
  });

  it('an unresolved legacy lineage blocks the item, settles the reservation and saves', async () => {
    const h = harness(cls({ outcome: 'rate_limited', counted: false, wait_seconds: 60 }), {
      coverage: {
        ...harness().fx.coverage,
        legacyOrigins: () => {
          throw new CoverageLineageError('no origin');
        },
      },
    });
    const q: Queue = { backfill_reservations: { att: {} } };
    const it = item({ kind: 'coverage', attempt_id: 'att' });
    const msg = await harvestReview(q, it, false, h.fx);
    expect(msg).toBe('legacy coverage lineage unresolved: no origin');
    expect(it).toMatchObject({
      state: 'blocked',
      vendor_state: 'terminal',
      run: null,
      last_error: msg,
    });
    expect((q.backfill_reservations as Rec).att).toEqual({ terminal_at: iso() });
    expect(q.cooldown_until).toBe(iso(NOW + 60_000));
    expect(h.saved).toEqual(['save']);
    expect(h.calls).toContain('rm:/wt/r-1:wt/r-1:null');
    expect(it.attempts).toEqual([]);
  });

  it('any other lineage error aborts the harvest', async () => {
    const h = harness(cls(), {
      coverage: {
        ...harness().fx.coverage,
        legacyOrigins: () => {
          throw new Error('disk');
        },
      },
    });
    await expect(harvestReview({}, item({ kind: 'coverage' }), false, h.fx)).rejects.toThrow(
      'disk',
    );
  });

  it('a resolved coverage item settles its reservation and records legacy success', async () => {
    const h = harness(cls(), {
      readReviewText: async () => JSON.stringify({ type: 'complete', reviewedFiles: ['a.ts'] }),
    });
    const q: Queue = { backfill_reservations: { att: {} } };
    const it = item({ kind: 'coverage', attempt_id: 'att', coverage_source: 'legacy' });
    await harvestReview(q, it, false, h.fx);
    expect(it.vendor_state).toBe('terminal');
    expect((q.backfill_reservations as Rec).att).toEqual({ terminal_at: iso() });
    expect(h.calls).toContain('legacy-ok:a.ts');
  });

  it('an inherited object member is not a reservation', async () => {
    const q: Queue = { backfill_reservations: { att: {} } };
    for (const id of ['constructor', 'toString', '__proto__'])
      await harvestReview(q, item({ kind: 'coverage', attempt_id: id }), false, harness().fx);
    expect(q.backfill_reservations).toEqual({ att: {} });
  });

  it('an unknown or non-string attempt id leaves reservations untouched', async () => {
    const h = harness();
    const q: Queue = { backfill_reservations: { att: {} } };
    await harvestReview(q, item({ kind: 'coverage', attempt_id: 'missing' }), false, h.fx);
    await harvestReview(q, item({ kind: 'coverage', attempt_id: 5 }), false, harness().fx);
    expect(q.backfill_reservations).toEqual({ att: {} });
  });
});

describe('harvestReview numbers and truthiness', () => {
  it('reads retained JsonNumber leaves for failures and wait_seconds', async () => {
    const h = harness(
      cls({ outcome: 'rate_limited', counted: false, wait_seconds: JsonNumber.int(120) }),
    );
    const q: Queue = {};
    await harvestReview(q, item({ failures: JsonNumber.int(1) }), false, h.fx);
    expect(q.cooldown_until).toBe(iso(NOW + 120_000));
    const e = harness(cls({ outcome: 'error', counted: false, message: 'm' }));
    const it = item({ failures: JsonNumber.int(1) });
    await harvestReview({}, it, false, e.fx);
    expect(it.failures).toBe(2);
    expect(it.not_before).toBe(iso(NOW + 10 * 60_000));
  });

  it('a zero JsonNumber findings count is falsy, like Python 0', async () => {
    const h = harness(cls({ findings: JsonNumber.int(0) }));
    const it = item({ pr: 1 });
    await harvestReview({}, it, false, h.fx);
    expect(it.clean_review_pending).toBe(true);
    expect(h.calls).not.toContain('pr-review');
  });
});
