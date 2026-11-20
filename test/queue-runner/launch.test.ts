import { describe, expect, it } from 'vitest';
import {
  launch,
  UNIVERSAL_SCAN_CLASSES,
  type LaunchEffects,
  type LaunchPlan,
  type LaunchScanDecision,
} from '../../src/queue-runner/launch.js';
import { ReviewSpawnError } from '../../src/queue-runner/reviewLaunch.js';
import { ReviewCheckoutError } from '../../src/queue-runner/reviewPreparation.js';
import { StartAuthorRefused, type StartRecord } from '../../src/queue-runner/startOne.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const CLEAN: LaunchScanDecision = {
  ok: true,
  denylistHits: 0,
  gitleaksHits: 0,
  artifactPath: '/runs/x/secret-scan.json',
};

function plan(extra: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    label: 'full',
    base: BASE,
    head: HEAD,
    target: 'main',
    notes: [],
    cycle: 1,
    branch: 'feat/x',
    pr_head: HEAD,
    review_pin: BASE,
    range_policy: 'full-range-once-v1',
    ...extra,
  };
}

interface Harness {
  fx: LaunchEffects;
  calls: string[];
  metas: Record<string, unknown>[];
  events: { kind: string; data: Record<string, unknown> }[];
  saved: string[];
  scans: Parameters<LaunchEffects['scan']>[0][];
  queue: StartRecord;
}

function harness(
  over: Partial<LaunchEffects> = {},
  repos: Record<string, { clone: string; scanExtraClasses: string[] }> = {},
): Harness {
  const calls: string[] = [];
  const metas: Record<string, unknown>[] = [];
  const events: Harness['events'] = [];
  const saved: string[] = [];
  const scans: Harness['scans'] = [];
  const queue: StartRecord = { items: [], starts: [] };
  const fx: LaunchEffects = {
    nowIso: () => '2026-11-20T01:02:03Z',
    runStamp: () => '20261120T010203Z',
    itemRepo: (item) => String(item.repo ?? 'o/primary'),
    isPrimaryRepo: (repo) => repo === 'o/primary',
    repoConfig: (repo) => repos[repo] ?? null,
    onDemandClone: (repo) => {
      calls.push(`onDemandClone:${repo}`);
      return Promise.resolve(`/clones/${repo}`);
    },
    launchBand: () => 'background',
    allocateRun: (runId) => {
      calls.push(`allocate:${runId}`);
      return Promise.resolve(`/runs/${runId}`);
    },
    scan: (request) => {
      calls.push('scan');
      scans.push(request);
      return Promise.resolve(CLEAN);
    },
    scanBackfillContext: () => {
      calls.push('scanBackfillContext');
      return Promise.resolve(CLEAN);
    },
    writeBlockedReceipt: () => {
      calls.push('writeBlockedReceipt');
      return Promise.resolve('receipt-1');
    },
    checkout: ({ runId }) => {
      calls.push('checkout');
      return Promise.resolve({ path: `/wt/${runId}`, branch: `crq/${runId}` });
    },
    removeWorktree: (path) => {
      calls.push(`removeWorktree:${path}`);
      return Promise.resolve();
    },
    checkAuthor: () => {
      calls.push('checkAuthor');
    },
    grantAuthor: () => {
      calls.push('grantAuthor');
    },
    writeMeta: (_rdir, meta) => {
      calls.push('writeMeta');
      metas.push(meta);
      return Promise.resolve();
    },
    workStarted: () => {
      calls.push('workStarted');
      return Promise.resolve();
    },
    saveQueue: () => {
      calls.push('save');
      saved.push(String(queue.starts));
      return Promise.resolve();
    },
    spawn: () => {
      calls.push('spawn');
      return Promise.resolve(4242);
    },
    event: (kind, data) => {
      events.push({ kind, data });
      return Promise.resolve();
    },
    ...over,
  };
  return { fx, calls, metas, events, saved, scans, queue };
}

function item(extra: StartRecord = {}): StartRecord {
  return { id: 'pr-7', kind: 'open', pr: 7, state: 'pending', ...extra };
}

describe('launch: ordinary open', () => {
  it('reserves reviewing before the spawn and records the meta in Python key order', async () => {
    const h = harness();
    const it1 = item();
    h.queue.items = [it1];
    const runId = await launch(h.queue, it1, plan(), h.fx);
    expect(runId).toBe('pr-7-20261120T010203Z');
    expect(h.calls).toEqual([
      'allocate:pr-7-20261120T010203Z',
      'scan',
      'checkout',
      'writeMeta',
      'workStarted',
      'save',
      'spawn',
      'save',
    ]);
    expect(Object.keys(h.metas[0] as object)).toEqual([
      'run_id',
      'item_id',
      'pr',
      'kind',
      'repo',
      'workId',
      'label',
      'cycle',
      'base',
      'head',
      'pr_head',
      'review_pin',
      'target',
      'pr_branch',
      'worktree',
      'wt_branch',
      'dirty_diff',
      'range_policy',
      'band',
      'started_at',
      'cmd',
    ]);
    expect(h.metas[0]?.cmd).toEqual([
      'coderabbit',
      'review',
      '--agent',
      '--deep',
      '--committed',
      '--base-commit',
      BASE,
    ]);
    expect(h.metas[0]?.workId).toBe(`crq:${runId}`);
    expect(it1.state).toBe('reviewing');
    expect(it1.wait_reason).toBeNull();
    expect(it1.run).toEqual({
      run_id: runId,
      pid: 4242,
      started_at: '2026-11-20T01:02:03Z',
      band: 'background',
      launch_pending: false,
    });
    expect(h.queue.starts).toEqual(['2026-11-20T01:02:03Z']);
    // The first save already carried the start; the child pid came after.
    expect(h.saved[0]).toBe('2026-11-20T01:02:03Z');
    expect(h.events.map((e) => e.kind)).toEqual(['review_started']);
    expect(h.scans[0]).toMatchObject({ mode: 'range', clone: null, classes: null });
  });

  it('omits --committed when the plan has no range policy', async () => {
    const h = harness();
    await launch(h.queue, item(), plan({ range_policy: undefined }), h.fx);
    expect(h.metas[0]?.cmd).toEqual([
      'coderabbit',
      'review',
      '--agent',
      '--deep',
      '--base-commit',
      BASE,
    ]);
  });

  it('a secret-scan failure blocks the item, leaves the artifact and returns the run id', async () => {
    const h = harness({
      scan: () =>
        Promise.resolve({ ok: false, denylistHits: 2, gitleaksHits: 1, artifactPath: 'x' }),
    });
    const it1 = item();
    const runId = await launch(h.queue, it1, plan(), h.fx);
    expect(runId).toBe('pr-7-20261120T010203Z');
    expect(it1.state).toBe('blocked');
    expect(it1.last_error).toBe(
      'secret scan failed before upload: 2 denylist + 1 gitleaks hit(s) — see ' +
        '/runs/pr-7-20261120T010203Z/secret-scan.json',
    );
    expect(h.calls).not.toContain('checkout');
    expect(h.calls).not.toContain('spawn');
    expect(h.events).toEqual([{ kind: 'blocked', data: { item: 'pr-7', reason: it1.last_error } }]);
    expect(h.queue.starts).toEqual([]);
  });

  it('a checkout failure blocks a non-author item with the 300-char error', async () => {
    const h = harness({
      checkout: () => Promise.reject(new ReviewCheckoutError('x'.repeat(400))),
    });
    const it1 = item();
    const runId = await launch(h.queue, it1, plan(), h.fx);
    expect(runId).toBe('pr-7-20261120T010203Z');
    expect(it1.state).toBe('blocked');
    expect(String(it1.last_error)).toHaveLength(300);
    expect(String(it1.last_error).startsWith('review worktree checkout failed: xx')).toBe(true);
    expect(h.calls).toContain('save');
    expect(h.calls).not.toContain('spawn');
  });

  it('a non-checkout error from checkout propagates', async () => {
    const h = harness({ checkout: () => Promise.reject(new Error('disk')) });
    await expect(launch(h.queue, item(), plan(), h.fx)).rejects.toThrow('disk');
  });

  it('an open spawn failure re-raises after the reservation was saved', async () => {
    const h = harness({ spawn: () => Promise.reject(new ReviewSpawnError('EAGAIN')) });
    const it1 = item();
    await expect(launch(h.queue, it1, plan(), h.fx)).rejects.toBeInstanceOf(ReviewSpawnError);
    expect(it1.state).toBe('reviewing');
    expect((it1.run as Record<string, unknown>).launch_pending).toBe(true);
    expect(h.queue.starts).toHaveLength(1);
  });
});

describe('launch: foreign repos and scan classes', () => {
  const repos = { 'o/other': { clone: '/clones/other', scanExtraClasses: ['class:extra'] } };

  it('a configured foreign open item scans in its clone with universal + extra classes', async () => {
    const h = harness({}, repos);
    await launch(h.queue, item({ repo: 'o/other' }), plan(), h.fx);
    expect(h.scans[0]).toMatchObject({
      clone: '/clones/other',
      classes: [...UNIVERSAL_SCAN_CLASSES, 'class:extra'],
    });
  });

  it('an unconfigured foreign open item is a hard error before any scan', async () => {
    const h = harness();
    await expect(launch(h.queue, item({ repo: 'o/nope' }), plan(), h.fx)).rejects.toThrow(
      'open item names an unconfigured repo: o/nope',
    );
    expect(h.calls).not.toContain('scan');
  });

  it('an unconfigured local-review uses an on-demand clone with universal classes only', async () => {
    const h = harness();
    const it1 = item({
      kind: 'local-review',
      repo: 'o/nope',
      profile: { flags: ['--plain', '--x'] },
    });
    await launch(h.queue, it1, plan(), h.fx);
    expect(h.scans[0]).toMatchObject({
      clone: '/clones/o/nope',
      classes: UNIVERSAL_SCAN_CLASSES,
    });
    expect(h.metas[0]?.cmd).toEqual(['coderabbit', 'review', '--plain', '--x']);
    expect(h.metas[0]?.profile).toEqual({ flags: ['--plain', '--x'] });
  });

  it('push items use the projection scan in the configured clone; unconfigured is an error', async () => {
    const h = harness({}, repos);
    const push = item({
      kind: 'push-current',
      repo: 'o/other',
      subject: { base: BASE, head: HEAD },
    });
    await launch(h.queue, push, plan(), h.fx);
    expect(h.scans[0]).toMatchObject({ mode: 'projection', clone: '/clones/other' });
    expect(h.metas[0]?.push).toEqual({ base: BASE, head: HEAD, target: 'main' });
    const bad = harness();
    await expect(
      launch(bad.queue, item({ kind: 'push-current', repo: 'o/nope' }), plan(), bad.fx),
    ).rejects.toThrow('push item names an unconfigured repo: o/nope');
  });
});

describe('launch: receipts, backfill, merged, author', () => {
  it('a blocked receipt writes the blocked-secret-scan receipt and saves', async () => {
    const h = harness({
      scan: () =>
        Promise.resolve({ ok: false, denylistHits: 1, gitleaksHits: 0, artifactPath: '' }),
    });
    const it1 = item({ kind: 'merged-current', capture: { c: 1 }, subject: { base: BASE } });
    await launch(h.queue, it1, plan(), h.fx);
    expect(it1.state).toBe('blocked');
    expect(it1.receipt_id).toBe('receipt-1');
    expect(h.calls.slice(-2)).toEqual(['writeBlockedReceipt', 'save']);
  });

  it('receipt meta carries capture and source and uses the projection scan', async () => {
    const h = harness();
    await launch(
      h.queue,
      item({ kind: 'merged-current', capture: { c: 1 }, subject: { base: BASE } }),
      plan(),
      h.fx,
    );
    expect(h.scans[0]?.mode).toBe('projection');
    expect(h.metas[0]).toMatchObject({ capture: { c: 1 }, source: { base: BASE } });
    expect(h.metas[0]?.cmd).toContain('--committed');
  });

  it('backfill scans the synthetic context only after a clean main scan', async () => {
    const h = harness();
    await launch(
      h.queue,
      item({
        kind: 'backfill',
        subject_id: 's',
        job_id: 'j',
        attempt_id: 'a',
        target: 't',
        scope_digest: 'd',
      }),
      plan(),
      h.fx,
    );
    expect(h.calls.indexOf('scanBackfillContext')).toBe(h.calls.indexOf('scan') + 1);
    expect(h.metas[0]?.backfill).toEqual({
      subject_id: 's',
      job_id: 'j',
      attempt_id: 'a',
      target: 't',
      scope_digest: 'd',
    });
    const blocked = harness({
      scan: () =>
        Promise.resolve({ ok: false, denylistHits: 1, gitleaksHits: 0, artifactPath: '' }),
    });
    await launch(blocked.queue, item({ kind: 'backfill' }), plan(), blocked.fx);
    expect(blocked.calls).not.toContain('scanBackfillContext');
  });

  it('merged meta records the measure paths and coverage fields', async () => {
    const h = harness();
    await launch(
      h.queue,
      item({
        kind: 'merged',
        measure: { synthetic_paths: 3, merge_queue: 'tip' },
        coverage_sha: 'c',
        coverage_paths: ['p'],
      }),
      plan(),
      h.fx,
    );
    expect(h.metas[0]).toMatchObject({
      planned_paths: 3,
      reviewed_tip: 'tip',
      coverage_sha: 'c',
      coverage_paths: ['p'],
    });
  });

  it('an author launch checks first, grants before reservation and spawn failure is terminal', async () => {
    const h = harness({ spawn: () => Promise.reject(new ReviewSpawnError('E'.repeat(300))) });
    const author = item({
      kind: 'author',
      author: { request_id: 'r', base: BASE, head: HEAD, target: 'main', cycle: 2, extra: 1 },
    });
    await launch(h.queue, author, plan(), h.fx);
    expect(h.calls[0]).toBe('checkAuthor');
    expect(h.calls.indexOf('grantAuthor')).toBeLessThan(h.calls.indexOf('writeMeta'));
    expect(h.metas[0]?.author).toEqual({
      request_id: 'r',
      base: BASE,
      head: HEAD,
      target: 'main',
      cycle: 2,
    });
    expect(author.state).toBe('author_failed');
    expect(String(author.last_error).startsWith('author spawn failed (no retry): EEE')).toBe(true);
    expect(String(author.last_error)).toHaveLength(300);
    const run = author.run as Record<string, unknown>;
    expect(run).toMatchObject({
      pid: null,
      launch_pending: false,
      spawn_failed_at: '2026-11-20T01:02:03Z',
    });
    expect(String(run.error)).toHaveLength(200);
    expect(h.events.map((e) => e.kind)).toEqual(['spawn_failed']);
  });

  it('persists a terminal spawn failure before the event can reject', async () => {
    const savesAtEvent: number[] = [];
    const h: Harness = harness({
      spawn: () => Promise.reject(new ReviewSpawnError('boom')),
      event: () => {
        savesAtEvent.push(h.calls.filter((c) => c === 'save').length);
        return Promise.reject(new Error('event write failed'));
      },
    });
    const lr = item({ kind: 'local-review', profile: { flags: [] } });
    await expect(launch(h.queue, lr, plan(), h.fx)).rejects.toThrow('event write failed');
    expect(lr.state).toBe('failed');
    // The reservation save plus the terminal save, both before the event.
    expect(savesAtEvent).toEqual([2]);
  });

  it('a local-review spawn failure ends failed', async () => {
    const h = harness({ spawn: () => Promise.reject(new ReviewSpawnError('boom')) });
    const lr = item({ kind: 'local-review', profile: { flags: [] } });
    await launch(h.queue, lr, plan(), h.fx);
    expect(lr.state).toBe('failed');
    expect(lr.last_error).toBe('local-review spawn failed (no retry): boom');
  });

  it('a refused grant removes the prepared worktree and re-raises', async () => {
    const h = harness({
      grantAuthor: () => {
        throw new StartAuthorRefused('lease expired');
      },
    });
    const author = item({ kind: 'author', author: {} });
    await expect(launch(h.queue, author, plan(), h.fx)).rejects.toBeInstanceOf(StartAuthorRefused);
    expect(h.calls).toContain('removeWorktree:/wt/pr-7-20261120T010203Z');
    expect(h.calls).not.toContain('writeMeta');
    expect(h.queue.starts).toEqual([]);
  });

  it('an author checkout failure is an author refusal, not a block', async () => {
    const h = harness({ checkout: () => Promise.reject(new ReviewCheckoutError('nope')) });
    const author = item({ kind: 'author', author: {} });
    await expect(launch(h.queue, author, plan(), h.fx)).rejects.toThrow(
      'author head cannot be checked out',
    );
    expect(author.state).toBe('pending');
  });

  it('an author scan failure flags the lease and saves', async () => {
    const h = harness({
      scan: () =>
        Promise.resolve({ ok: false, denylistHits: 1, gitleaksHits: 0, artifactPath: '' }),
    });
    const author = item({ kind: 'author', author_lease: {}, author: {} });
    await launch(h.queue, author, plan(), h.fx);
    expect((author.author_lease as Record<string, unknown>).secret_scan_blocked).toBe(true);
    expect(h.calls).toContain('save');
    expect(author.state).toBe('blocked');
  });

  it('a failed work-started append never fails the launch', async () => {
    const h = harness({ workStarted: () => Promise.reject(new Error('ledger down')) });
    const it1 = item();
    await launch(h.queue, it1, plan(), h.fx);
    expect(it1.state).toBe('reviewing');
  });
});
