import { describe, expect, it } from 'vitest';
import { FixPrBacklog } from '../../src/queue-runner/fixPrBacklog.js';
import { isPyError, PyError } from '../../src/queue-runner/pyErrors.js';
import {
  finalizePublication,
  PR_CREATE_ATTEMPTS,
  REFUSE_FIX_PR_IDENTITY,
  type CreatePrRequest,
  type FixPrRow,
  type PublicationFinalizeEffects,
} from '../../src/queue-runner/publicationFinalize.js';
import { recoverPublication } from '../../src/queue-runner/publicationRecovery.js';

// Mirrors apps/crq-python/test_repair_backlog.py (PublishCapTest) and the
// finalize_publication half of test_repair_drain.py, then pins what those
// leave open: write ordering, the three exits that do and do not roll back,
// and the unique prepared-head requirement (#2290) and backlog cap (#2288).

type Rec = Record<string, unknown>;

interface Harness {
  readonly effects: PublicationFinalizeEffects;
  readonly calls: string[];
  readonly created: CreatePrRequest[];
  readonly writes: { jobId: unknown; text: string }[];
  readonly journals: Rec[];
  readonly saves: Rec[];
  readonly items: Rec[];
  readonly listed: Map<string, FixPrRow[]>;
  /** What `createPr` does; default lands a PR at `h<name>` for `crq/fix-run-<name>`. */
  createImpl: (request: CreatePrRequest) => void | Promise<void>;
}

function harness(): Harness {
  const calls: string[] = [];
  const created: CreatePrRequest[] = [];
  const writes: { jobId: unknown; text: string }[] = [];
  const journals: Rec[] = [];
  const saves: Rec[] = [];
  const items: Rec[] = [];
  const listed = new Map<string, FixPrRow[]>();
  const h: Harness = {
    calls,
    created,
    writes,
    journals,
    saves,
    items,
    listed,
    createImpl: (request) => {
      // Python's fixture numbers by len(created) after the append: the first PR is 101.
      // The created PR sits at the prepared head: branch 'crq/fix-run-<n>' pairs with head 'h<n>'.
      listed.set(request.head, [
        {
          number: 100 + created.length,
          url: 'u',
          state: 'OPEN',
          headRefOid: `h${request.head.slice('crq/fix-run-'.length)}`,
        },
      ]);
    },
    effects: {
      repo: 'o/r',
      iso: () => 'now',
      async listBranchPrs(branch) {
        calls.push('list');
        return listed.get(branch) ?? [];
      },
      async repairProvenance() {
        calls.push('provenance');
        return ['', 'Source run: `x`'];
      },
      async writeFixPrBody(jobId, text) {
        calls.push('write-body');
        writes.push({ jobId, text });
        return `/state/repair/${String(jobId)}/fix-pr.md`;
      },
      async writeJournal(_jobId, publication) {
        calls.push('write-journal');
        journals.push(structuredClone(publication));
      },
      async saveQueue(q) {
        calls.push('save');
        saves.push(structuredClone(q));
      },
      async createPr(request) {
        calls.push('create');
        created.push(request);
        await h.createImpl(request);
      },
      async newItem(q, fields) {
        calls.push('new-item');
        items.push(fields);
        (q.items as Rec[]).push(fields);
      },
    },
  };
  return h;
}

function parts(itemId: string, name: string) {
  const run = `run-${name}`;
  const item: Rec = { id: itemId, pr: 0, kind: 'merged', state: 'repairing' };
  const record: Rec = {
    jobs: [`job-${name}`],
    state: 'ready',
    verdicts: [{ job: `job-${name}`, verdict: 'FIXED', reason: 'ok' }],
  };
  const publication: Rec = {
    head: `h${name}`,
    target: 't',
    branch: `crq/fix-${run}`,
    commits: [`c-${name}`],
    open_pr: false,
  };
  return { item, run, record, publication };
}

async function finalize(
  h: Harness,
  backlog: FixPrBacklog,
  p: ReturnType<typeof parts>,
  q: Rec = { items: [] },
) {
  let thrown: unknown;
  try {
    await finalizePublication(h.effects, backlog, q, p.item, p.run, p.record, p.publication);
  } catch (e) {
    thrown = e;
  }
  return { q, thrown };
}

const backlogOf = (open: number | null, limit: number | null) => {
  const b = new FixPrBacklog();
  b.open = open;
  b.limit = limit;
  return b;
};

describe('finalizePublication: backfill backlog cap (#2288)', () => {
  it('one slot creates one backfill PR and holds the other untouched', async () => {
    const h = harness();
    const backlog = backlogOf(9, 10);
    const first = parts('backfill-finding-a', 'a');
    const second = parts('backfill-finding-b', 'b');
    const q: Rec = { items: [] };
    await finalize(h, backlog, first, q);
    const beforeRecord = structuredClone(second.record);
    const beforePublication = structuredClone(second.publication);
    const beforeQueue = structuredClone(q);
    const out = await finalize(h, backlog, second, q);
    expect(out.thrown).toBeUndefined();
    expect(h.created.map((c) => c.head)).toEqual(['crq/fix-run-a']);
    expect(backlog.open).toBe(10);
    expect(second.record.state).toBe('ready');
    expect(second.publication).not.toHaveProperty('pr_create_attempts');
    expect(second.publication).not.toHaveProperty('pr_create_pending');
    expect(second.record).not.toHaveProperty('fix_pr');
    // The hold restored every bookkeeping write: the record and queue are as before.
    expect(second.record).toEqual(beforeRecord);
    expect(second.publication).toEqual(beforePublication);
    expect(q).toEqual(beforeQueue);
  });

  it('holds backfill creation while the backlog is unread', async () => {
    const h = harness();
    const p = parts('backfill-finding-a', 'a');
    const out = await finalize(h, backlogOf(null, null), p);
    expect(out.thrown).toBeUndefined();
    expect(h.created).toEqual([]);
    expect(p.publication).not.toHaveProperty('pr_create_attempts');
  });

  it('reserves the slot before create and keeps it when the create times out', async () => {
    const h = harness();
    const backlog = backlogOf(8, 10);
    const seen: (number | null)[] = [];
    h.createImpl = () => {
      seen.push(backlog.open);
      throw new Error('TimeoutExpired');
    };
    const out = await finalize(h, backlog, parts('backfill-finding-a', 'a'));
    expect((out.thrown as Error).message).toBe('TimeoutExpired');
    expect(seen).toEqual([9]);
    expect(backlog.open).toBe(9);
  });

  it('releases the slot only when gh reports the create failed', async () => {
    const h = harness();
    const backlog = backlogOf(9, 10);
    h.createImpl = () => {
      throw new PyError('RuntimeError', 'gh pr create exit 1');
    };
    const out = await finalize(h, backlog, parts('backfill-finding-a', 'a'));
    expect(isPyError(out.thrown, 'RuntimeError')).toBe(true);
    expect(backlog.open).toBe(9);
  });

  it('creates a PR-review publication regardless of the cap, without touching it', async () => {
    const h = harness();
    const backlog = backlogOf(50, 10);
    const p = parts('pr77', 'p');
    const out = await finalize(h, backlog, p);
    expect(out.thrown).toBeUndefined();
    expect(h.created.map((c) => c.head)).toEqual(['crq/fix-run-p']);
    expect(p.publication.pr_create_attempts).toBe(1);
    expect(backlog.open).toBe(50);
  });

  it('does not release a slot it never reserved when a non-backfill create fails', async () => {
    const h = harness();
    const backlog = backlogOf(50, 10);
    h.createImpl = () => {
      throw new PyError('RuntimeError', 'gh pr create exit 1');
    };
    await finalize(h, backlog, parts('pr77', 'p'));
    expect(backlog.open).toBe(50);
  });
});

describe('finalizePublication: unique prepared-head PR (#2290)', () => {
  it('refuses an existing singleton PR at an unrelated head and records nothing', async () => {
    const h = harness();
    const p = parts('backfill-finding-a', 'a');
    h.listed.set('crq/fix-run-a', [{ number: 77, url: 'u', state: 'OPEN', headRefOid: 'other' }]);
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toMatchObject({ kind: 'ValueError' });
    expect((out.thrown as Error).message).toMatch(/prepared head mismatch/);
    expect(h.created).toEqual([]);
    expect(p.record).not.toHaveProperty('fix_pr');
    expect(h.items).toEqual([]);
  });

  it('refuses a created singleton PR listed at an unrelated head', async () => {
    const h = harness();
    const p = parts('backfill-finding-a', 'a');
    h.createImpl = () => {
      h.listed.set('crq/fix-run-a', [{ number: 78, url: 'u', state: 'OPEN', headRefOid: 'other' }]);
    };
    const out = await finalize(h, backlogOf(9, 10), p);
    expect((out.thrown as Error).message).toMatch(/prepared head mismatch/);
    expect(p.record).not.toHaveProperty('fix_pr');
    expect(h.items).toEqual([]);
  });

  it('refuses two PRs on the branch even when one is at the prepared head', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.listed.set('crq/fix-run-p', [
      { number: 1, url: 'u', state: 'CLOSED', headRefOid: 'hp' },
      { number: 2, url: 'u', state: 'OPEN', headRefOid: 'hp' },
    ]);
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toMatchObject({ kind: 'ValueError' });
    expect(h.created).toEqual([]);
  });

  it('keeps the bookkeeping when the identity check refuses (no rollback)', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.listed.set('crq/fix-run-p', [{ number: 1, url: 'u', state: 'OPEN', headRefOid: 'other' }]);
    const q: Rec = { items: [] };
    await finalize(h, backlogOf(0, 10), p, q);
    expect(p.record.publication).toBe(p.publication);
    expect(p.record.published_commits).toEqual(['c-p']);
    expect(q.repair_own_commits).toEqual(['c-p']);
    expect(p.record.state).toBe('ready');
    expect(p.item.state).toBe('repairing');
  });

  it('refuses when the create lands but the re-list is empty, recording and enrolling nothing', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    // gh pr create succeeded, yet the forge still lists no PR on the branch.
    h.createImpl = () => {};
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toMatchObject({
      kind: 'ValueError',
      message: REFUSE_FIX_PR_IDENTITY,
    });
    expect(h.calls).toEqual([
      'list',
      'provenance',
      'write-body',
      'write-journal',
      'save',
      'create',
      'list',
    ]);
    expect(p.record).not.toHaveProperty('fix_pr');
    expect(p.record.state).toBe('ready');
    expect(h.items).toEqual([]);
    // The pending journal and attempt stay, so the next tick sees the attempt counted.
    expect(p.publication).toMatchObject({ pr_create_pending: true, pr_create_attempts: 1 });
  });

  it('a KeyError, not a mismatch, when the sole PR row lacks headRefOid', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.listed.set('crq/fix-run-p', [{ number: 1 }]);
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toMatchObject({ kind: 'KeyError', message: "'headRefOid'" });
  });
});

describe('finalizePublication: adopting or creating the fix PR', () => {
  it('adopts an existing PR at the prepared head without creating one', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    const pr = { number: 5, url: 'u', state: 'OPEN', headRefOid: 'hp' };
    h.listed.set('crq/fix-run-p', [pr]);
    const q: Rec = { items: [] };
    const out = await finalize(h, backlogOf(0, 10), p, q);
    expect(out.thrown).toBeUndefined();
    expect(h.created).toEqual([]);
    expect(h.calls).toEqual(['list', 'new-item', 'save']);
    expect(p.record).toMatchObject({ state: 'published', fix_pr: pr });
    expect(p.item.state).toBe('done');
    expect(h.items).toEqual([
      {
        id: 'pr5',
        pr: 5,
        kind: 'open',
        tier: 1,
        prior_cycles: 1,
        repair_origin: 'run-p',
        why: 'verified repair fix PR',
      },
    ]);
  });

  it('does not enroll a PR that already has an open item', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.listed.set('crq/fix-run-p', [{ number: 5, url: 'u', state: 'OPEN', headRefOid: 'hp' }]);
    const q: Rec = { items: [{ pr: 5, kind: 'open' }] };
    await finalize(h, backlogOf(0, 10), p, q);
    expect(h.calls).toEqual(['list', 'save']);
    expect(p.record.state).toBe('published');
  });

  it('enrolls when the matching number is not an open item (kind or number differ)', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.listed.set('crq/fix-run-p', [{ number: 5, url: 'u', state: 'OPEN', headRefOid: 'hp' }]);
    const q: Rec = {
      items: [
        { pr: 5, kind: 'merged' },
        { pr: 6, kind: 'open' },
      ],
    };
    await finalize(h, backlogOf(0, 10), p, q);
    expect(h.items).toHaveLength(1);
  });

  it('prior_cycles is 2 minus the configured fix_pr_cycles', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.listed.set('crq/fix-run-p', [{ number: 5, url: 'u', state: 'OPEN', headRefOid: 'hp' }]);
    await finalizePublication(
      { ...h.effects, fixPrCycles: 2 },
      backlogOf(0, 10),
      { items: [] },
      p.item,
      p.run,
      p.record,
      p.publication,
    );
    expect(h.items[0]!.prior_cycles).toBe(0);
  });

  it('writes in order: list, provenance, body, journal, save, create, list, enroll, save', async () => {
    const h = harness();
    const p = parts('backfill-finding-a', 'a');
    const out = await finalize(h, backlogOf(9, 10), p);
    expect(out.thrown).toBeUndefined();
    expect(h.calls).toEqual([
      'list',
      'provenance',
      'write-body',
      'write-journal',
      'save',
      'create',
      'list',
      'new-item',
      'save',
    ]);
    // The journal and the first save carry the pending create and its attempt
    // before any forge mutation.
    expect(h.journals[0]).toMatchObject({ pr_create_pending: true, pr_create_attempts: 1 });
    expect((h.saves[0]!.items as Rec[]).length).toBe(0);
    expect(h.saves[0]!.repair_own_commits).toEqual(['c-a']);
    expect(h.created[0]).toEqual({
      base: 'main',
      head: 'crq/fix-run-a',
      title: 'fix: Address CodeRabbit findings from run-a',
      bodyFile: '/state/repair/job-a/fix-pr.md',
    });
    expect(p.record).toMatchObject({ state: 'published', published_commits: ['c-a'] });
    expect(p.record.fix_pr).toMatchObject({ number: 101 });
    expect(p.item.state).toBe('done');
    expect(h.saves.at(-1)!.items).toEqual([expect.objectContaining({ id: 'pr101', pr: 101 })]);
  });

  it('renders the body table, escaping pipes and newlines in reasons', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    p.record.verdicts = [
      { job: 'j1', verdict: 'FIXED', reason: 'a|b\nc' },
      { job: 'j2', verdict: 'FIXED', reason: 'ok' },
    ];
    await finalize(h, backlogOf(0, 10), p);
    expect(h.writes).toEqual([
      {
        jobId: 'job-p',
        text:
          'Verified CodeRabbit repairs from run-p\n\n| finding | verdict | reason |\n|---|---|---|\n' +
          '| j1 | FIXED | a\\|b c |\n| j2 | FIXED | ok |\n\nSource run: `x`\n',
      },
    ]);
  });

  it('stops a branch with no PR after the attempt limit, keeping the bookkeeping', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    p.publication.pr_create_attempts = PR_CREATE_ATTEMPTS;
    const q: Rec = { items: [] };
    const out = await finalize(h, backlogOf(0, 10), p, q);
    expect(out.thrown).toBeUndefined();
    expect(h.calls).toEqual(['list']);
    expect(p.record.state).toBe('stale');
    expect(p.record.error).toBe(
      'fix PR creation never completed after 3 attempts; reconcile the PR for crq/fix-run-p manually',
    );
    // Unlike the hold, the stale mark leaves the published bookkeeping behind.
    expect(p.record.publication).toBe(p.publication);
    expect(p.record.published_commits).toEqual(['c-p']);
    expect(q.repair_own_commits).toEqual(['c-p']);
    expect(p.item.state).toBe('repairing');
  });

  it('counts each attempt: two prior attempts allow a third', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    p.publication.pr_create_attempts = 2;
    await finalize(h, backlogOf(0, 10), p);
    expect(p.publication.pr_create_attempts).toBe(3);
    expect(h.created).toHaveLength(1);
  });

  it('a failed create leaves the pending journal and a saved queue, no fix_pr', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.createImpl = () => {
      throw new PyError('RuntimeError', 'gh pr create exit 1');
    };
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(isPyError(out.thrown, 'RuntimeError')).toBe(true);
    expect(h.calls).toEqual([
      'list',
      'provenance',
      'write-body',
      'write-journal',
      'save',
      'create',
    ]);
    expect(p.publication).toMatchObject({ pr_create_pending: true, pr_create_attempts: 1 });
    expect(p.record).not.toHaveProperty('fix_pr');
    expect(p.record.state).toBe('ready');
  });
});

describe('finalizePublication: bookkeeping', () => {
  it('dedupes repair_own_commits, including a repeat inside the same publication', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    p.publication.commits = ['x', 'y', 'x', 'z'];
    p.publication.open_pr = true;
    const q: Rec = { items: [], repair_own_commits: ['y'] };
    await finalize(h, backlogOf(0, 10), p, q);
    expect(q.repair_own_commits).toEqual(['y', 'x', 'z']);
    expect(p.record.published_commits).toEqual(['x', 'y', 'x', 'z']);
  });

  it('records the same-PR publication with no forge call', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    p.item.pr = 42;
    p.publication.open_pr = true;
    p.publication.head = 'H';
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toBeUndefined();
    expect(h.calls).toEqual(['save']);
    expect(p.item.last_push).toEqual({ sha: 'H', shas: ['c-p'], at: 'now' });
    expect(p.record.fix_pr).toEqual({ number: 42, url: 'https://github.com/o/r/pull/42' });
    expect(p.record.state).toBe('published');
    expect(p.item.state).toBe('done');
  });

  it('applies the hold only on the branch arm: an open PR ignores the backlog', async () => {
    const h = harness();
    const p = parts('backfill-finding-a', 'a');
    p.publication.open_pr = true;
    await finalize(h, backlogOf(null, null), p);
    expect(p.record.state).toBe('published');
  });

  it('restores an absent repair_own_commits key, and an existing one, on hold', async () => {
    const h = harness();
    const p = parts('backfill-finding-a', 'a');
    const q: Rec = { items: [] };
    await finalize(h, backlogOf(null, null), p, q);
    expect(q).not.toHaveProperty('repair_own_commits');
    expect(p.record).not.toHaveProperty('publication');
    expect(p.record).not.toHaveProperty('published_commits');

    const p2 = parts('backfill-finding-b', 'b');
    const prior = { id: 'old' };
    p2.record.publication = prior;
    p2.record.published_commits = ['old'];
    const q2: Rec = { items: [], repair_own_commits: ['old', 'older'] };
    await finalize(h, backlogOf(null, null), p2, q2);
    expect(p2.record.publication).toBe(prior);
    expect(p2.record.published_commits).toEqual(['old']);
    expect(q2.repair_own_commits).toEqual(['old', 'older']);
  });

  it('a missing journal field is a KeyError after record.publication is already set', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    delete p.publication.branch;
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toMatchObject({ kind: 'KeyError', message: "'branch'" });
    expect(p.record.publication).toBe(p.publication);
    expect(h.calls).toEqual([]);
  });

  it('an open-PR publication on an item without pr is a KeyError after last_push is set', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    delete p.item.pr;
    p.publication.open_pr = true;
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toMatchObject({ kind: 'KeyError', message: "'pr'" });
    expect(p.item).toHaveProperty('last_push');
    expect(h.calls).toEqual([]);
  });

  it('a non-string verdict reason is an AttributeError before anything is written', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    p.record.verdicts = [{ job: 'j', verdict: 'FIXED', reason: 5 }];
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toMatchObject({ kind: 'AttributeError' });
    expect(h.calls).toEqual(['list']);
  });

  it('an empty jobs list is an IndexError after the provenance read, before any write', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    p.record.jobs = [];
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toMatchObject({ kind: 'IndexError' });
    expect(h.calls).toEqual(['list', 'provenance']);
  });
});

// Documented narrowings (module header, docs/crq/tick-slot-missing-effects.md
// S6-i): where Python would carry on with a value the queue never holds, the
// port refuses loudly instead of guessing. Pinning them means loosening one is
// a deliberate edit, not a silent drift from Python's `str()` and iteration.
describe('finalizePublication: documented input narrowings', () => {
  it.each([
    ['a float', 1.5],
    ['a bool', true],
    ['None', null],
  ])('refuses %s as the open-PR number, before fix_pr is recorded', async (_name, pr) => {
    const h = harness();
    const p = parts('pr77', 'p');
    p.item.pr = pr;
    p.publication.open_pr = true;
    const out = await finalize(h, backlogOf(0, 10), p);
    expect(out.thrown).toBeInstanceOf(Error);
    expect(out.thrown).not.toBeInstanceOf(PyError);
    expect((out.thrown as Error).message).toBe('unsupported PR number representation');
    expect(p.record).not.toHaveProperty('fix_pr');
    expect(p.record.state).toBe('ready');
    expect(h.calls).toEqual([]);
  });

  it('refuses a non-integer listed PR number when enrolling, before the item exists', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.listed.set(p.publication.branch as string, [
      { number: 1.5, url: 'u', state: 'OPEN', headRefOid: 'hp' },
    ]);
    const out = await finalize(h, backlogOf(0, 10), p);
    expect((out.thrown as Error).message).toBe('unsupported PR number representation');
    expect(h.items).toEqual([]);
    expect(h.saves).toEqual([]);
    expect(p.record.state).toBe('ready');
  });

  it('accepts integral numbers in every shape the queue can hold', async () => {
    for (const [pr, text] of [
      [7, '7'],
      [7n, '7'],
      ['7', '7'],
      [{ kind: 'int', integer: 7n }, '7'],
    ] as const) {
      const h = harness();
      const p = parts('pr77', 'p');
      p.item.pr = pr;
      p.publication.open_pr = true;
      const out = await finalize(h, backlogOf(0, 10), p);
      expect(out.thrown).toBeUndefined();
      expect(p.record.fix_pr).toEqual({ number: pr, url: `https://github.com/o/r/pull/${text}` });
    }
  });

  it('a non-list commits is a TypeError after record.publication is set, with nothing else touched', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    // Python would iterate this string and own each character as a commit.
    p.publication.commits = 'abc';
    const q: Rec = { items: [], repair_own_commits: ['x'] };
    const out = await finalize(h, backlogOf(0, 10), p, q);
    expect(out.thrown).toBeInstanceOf(TypeError);
    expect((out.thrown as Error).message).toBe('commits must be a list');
    expect(p.record.publication).toBe(p.publication);
    expect(p.record).not.toHaveProperty('published_commits');
    expect(q.repair_own_commits).toEqual(['x']);
    expect(h.calls).toEqual([]);
  });

  it('a non-list repair_own_commits is a TypeError before the record is read for state', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    const q: Rec = { items: [], repair_own_commits: 'abc' };
    const out = await finalize(h, backlogOf(0, 10), p, q);
    expect(out.thrown).toBeInstanceOf(TypeError);
    expect((out.thrown as Error).message).toBe('repair_own_commits must be a list');
    expect(p.record).not.toHaveProperty('publication');
    expect(q.repair_own_commits).toBe('abc');
    expect(h.calls).toEqual([]);
  });
});

describe('recoverPublication composed with finalizePublication', () => {
  it('finalizes the recovered publication through the injected finalize effect', async () => {
    const h = harness();
    const p = parts('pr77', 'p');
    h.listed.set('crq/fix-run-p', [{ number: 9, url: 'u', state: 'OPEN', headRefOid: 'hp' }]);
    const q: Rec = { items: [] };
    await recoverPublication(
      {
        async lsRemoteHeads() {
          return '';
        },
        async prInfo() {
          throw new Error('no pr_info on the branch arm');
        },
        async listBranchPrs(branch) {
          return (h.listed.get(branch) ?? []).map((r) => ({ headRefOid: r.headRefOid }));
        },
        async isAncestor() {
          return false;
        },
        async push() {
          throw new Error('nothing to push');
        },
        finalize: () =>
          finalizePublication(
            h.effects,
            backlogOf(0, 10),
            q,
            p.item,
            p.run,
            p.record,
            p.publication,
          ),
      },
      p.item,
      p.record,
      p.publication,
    );
    expect(p.record).toMatchObject({ state: 'published', fix_pr: { number: 9 } });
    expect(p.item.state).toBe('done');
    expect(h.created).toEqual([]);
  });
});
