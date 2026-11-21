// Differential run: the same queue and publication through Python's real
// `crq.new_item` / `repair_tick.finalize_publication` (the oracle,
// test/helpers/publicationEnrollOracle.py) and the TS `publicationNewItem`
// effect composed with `finalizePublication`. Final queue, item, record,
// publication, journal, body and the ordered effect log are compared as JSON
// text, so key order (what queue.json would hold) is part of the comparison, and
// a Python exception must coincide with a TS error of the same family.
// Fixtures only: every effect is in memory, `gh pr create` is a recorded argv,
// nothing touches Git, a forge, a provider, a real queue or an event log.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { filePublicationProvenance } from '../../src/adapters/crq/publicationProvenance.js';
import { FixPrBacklog } from '../../src/queue-runner/fixPrBacklog.js';
import {
  type FixPrRow,
  finalizePublication,
  type PublicationFinalizeEffects,
} from '../../src/queue-runner/publicationFinalize.js';
import { publicationNewItem } from '../../src/queue-runner/publicationEnroll.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';

const ORACLE = fileURLToPath(new URL('../helpers/publicationEnrollOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const SOURCE = fileURLToPath(
  new URL('../../src/queue-runner/publicationEnroll.ts', import.meta.url),
);

type Rec = Record<string, unknown>;
interface Outcome {
  error: string | null;
  out: Rec;
}

const NOW = '2026-11-22T00:00:00Z';
const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

function runOracle(cases: Rec[]): Outcome[] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '' },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

/** The exception family Python's oracle reports for a TS throw. */
function familyOf(e: unknown): string {
  return e instanceof PyError ? e.kind : (e as Error).name;
}

// --- new_item -------------------------------------------------------------

interface NewItemCase {
  name: string;
  q: Rec;
  fields: Rec;
  event_fails?: boolean;
}

async function tsNewItem(c: NewItemCase): Promise<Outcome> {
  const q = structuredClone(c.q);
  const log: unknown[] = [];
  const newItem = publicationNewItem({
    iso: () => NOW,
    event: async (id, reason) => {
      log.push(['event', id, reason]);
      if (c.event_fails) throw new PyError('OSError', 'events.jsonl is not writable');
    },
  });
  let error: string | null = null;
  try {
    await newItem(q, structuredClone(c.fields));
  } catch (e) {
    error = familyOf(e);
  }
  return { error, out: { q, log } };
}

async function expectNewItemParity(cases: NewItemCase[]): Promise<Outcome[]> {
  const python = runOracle(
    cases.map((c) => ({
      op: 'new_item',
      q: c.q,
      fields: c.fields,
      now: NOW,
      event_fails: c.event_fails ?? false,
    })),
  );
  const outcomes: Outcome[] = [];
  for (const [i, c] of cases.entries()) {
    const ts = await tsNewItem(c);
    expect(JSON.stringify(ts), c.name).toBe(JSON.stringify(python[i]));
    outcomes.push(python[i]!);
  }
  return outcomes;
}

const qOf = (o: Outcome) => o.out.q as { items: Rec[] };

describe('publicationNewItem matches crq.new_item (offline Python parity)', () => {
  it('builds the item as order, state, cycles, attempts, fields, notes, with why removed', async () => {
    const [fresh] = await expectNewItemParity([
      {
        name: 'fresh open PR',
        q: { items: [{ id: 'a', order: 4, kind: 'open' }] },
        fields: {
          id: 'pr5',
          pr: 5,
          kind: 'open',
          tier: 1,
          prior_cycles: 1,
          repair_origin: 'run-1',
          why: 'verified repair fix PR',
        },
      },
    ]);
    expect(qOf(fresh!).items[1]).toEqual({
      order: 5,
      state: 'pending',
      cycles: [],
      attempts: [],
      id: 'pr5',
      pr: 5,
      kind: 'open',
      tier: 1,
      prior_cycles: 0,
      repair_origin: 'run-1',
      notes: [`${NOW} auto-enrolled: verified repair fix PR`],
    });
    expect(Object.keys(qOf(fresh!).items[1]!)).toEqual([
      'order',
      'state',
      'cycles',
      'attempts',
      'id',
      'pr',
      'kind',
      'tier',
      'prior_cycles',
      'repair_origin',
      'notes',
    ]);
    expect(fresh!.out.log).toEqual([
      ['event', 'pr5', `${NOW} auto-enrolled: verified repair fix PR`],
    ]);
  });

  it('forces prior_cycles to 0 for kind open only, keeping its position in the fields', async () => {
    const out = await expectNewItemParity([
      {
        name: 'open overrides 5',
        q: { items: [] },
        fields: { id: 'a', prior_cycles: 5, kind: 'open', why: 'w' },
      },
      {
        name: 'open without prior_cycles appends it after the fields',
        q: { items: [] },
        fields: { id: 'a', why: 'w', kind: 'open' },
      },
      {
        name: 'delta keeps its value',
        q: { items: [] },
        fields: { id: 'a', prior_cycles: 5, kind: 'delta', why: 'w' },
      },
      {
        name: 'no kind keeps its value',
        q: { items: [] },
        fields: { id: 'a', prior_cycles: 5, why: 'w' },
      },
    ]);
    expect(qOf(out[0]!).items[0]!.prior_cycles).toBe(0);
    expect(Object.keys(qOf(out[1]!).items[0]!).slice(-4)).toEqual([
      'id',
      'kind',
      'prior_cycles',
      'notes',
    ]);
    expect(qOf(out[2]!).items[0]!.prior_cycles).toBe(5);
    expect(qOf(out[3]!).items[0]!.prior_cycles).toBe(5);
  });

  it('numbers the item one past the largest live order and ignores promotion items', async () => {
    const orders = (name: string, items: Rec[]): NewItemCase => ({
      name,
      q: { items },
      fields: { id: 'new', kind: 'open', why: 'w' },
    });
    const out = await expectNewItemParity([
      orders('empty queue', []),
      orders('largest wins', [
        { id: 'a', order: 3 },
        { id: 'b', order: 7 },
        { id: 'c', order: 2 },
      ]),
      orders('missing order counts as 0', [{ id: 'a' }]),
      orders('missing and negative orders', [{ id: 'a', order: -4 }, { id: 'b' }]),
      orders('all negative', [{ id: 'a', order: -4 }]),
      orders('promotion is not live', [
        { id: 'a', order: 3 },
        { id: 'p', kind: 'promotion', order: 99 },
      ]),
      orders('only a promotion', [{ id: 'p', kind: 'promotion', order: 99 }]),
      orders('bool order is an int', [{ id: 'a', order: true }]),
      orders('zero order', [{ id: 'a', order: 0 }]),
    ]);
    expect(out.map((o) => qOf(o).items.at(-1)!.order)).toEqual([1, 8, 1, 1, -3, 4, 1, 2, 1]);
  });

  it('is sticky: an existing live id of any kind or state is returned, nothing appended or logged', async () => {
    const sticky = (name: string, existing: Rec): NewItemCase => ({
      name,
      q: { items: [existing] },
      fields: { id: 'pr101', pr: 101, kind: 'open', why: 'w' },
    });
    const out = await expectNewItemParity([
      sticky('skipped item', { id: 'pr101', pr: 7, kind: 'delta', state: 'skipped', order: 2 }),
      sticky('done open item', { id: 'pr101', pr: 101, kind: 'open', state: 'done', order: 2 }),
      {
        name: 'int 1 equals true',
        q: { items: [{ id: true, order: 1 }] },
        fields: { id: 1, kind: 'open', why: 'w' },
      },
    ]);
    for (const o of out.slice(0, 2)) {
      expect(qOf(o).items).toHaveLength(1);
      expect(o.out.log).toEqual([]);
    }
    expect(qOf(out[2]!).items).toHaveLength(1);
    expect(out[2]!.out.log).toEqual([]);
  });

  it('a promotion item with the same id is not live and does not block', async () => {
    const [o] = await expectNewItemParity([
      {
        name: 'promotion twin',
        q: {
          items: [
            { id: 'pr101', kind: 'promotion', order: 50 },
            { id: 'other', order: 2 },
          ],
        },
        fields: { id: 'pr101', pr: 101, kind: 'open', tier: 1, why: 'w' },
      },
    ]);
    expect(qOf(o!).items).toHaveLength(3);
    expect(qOf(o!).items[2]!.order).toBe(3);
  });

  it('reads ids lazily to the first match: a later item without an id is not read, an earlier one is KeyError', async () => {
    const out = await expectNewItemParity([
      {
        name: 'match before the id-less item',
        q: { items: [{ id: 'a' }, { order: 1 }] },
        fields: { id: 'a', why: 'w' },
      },
      {
        name: 'id-less item before the match',
        q: { items: [{ order: 1 }, { id: 'a' }] },
        fields: { id: 'a', why: 'w' },
      },
      {
        name: 'id-less item and no match',
        q: { items: [{ order: 1 }] },
        fields: { id: 'a', why: 'w' },
      },
      {
        name: 'a promotion without an id is filtered first',
        q: { items: [{ kind: 'promotion' }] },
        fields: { id: 'a', why: 'w' },
      },
    ]);
    expect(out.map((o) => o.error)).toEqual([null, 'KeyError', 'KeyError', null]);
    expect(qOf(out[1]!).items).toHaveLength(2);
    expect(qOf(out[3]!).items).toHaveLength(2);
  });

  it('fails on a malformed queue the way Python does', async () => {
    const out = await expectNewItemParity([
      { name: 'items missing', q: {}, fields: { id: 'a', why: 'w' } },
      { name: 'non-dict entry', q: { items: [['a']] }, fields: { id: 'a', why: 'w' } },
      { name: 'string entry', q: { items: ['a'] }, fields: { id: 'a', why: 'w' } },
      { name: 'null entry', q: { items: [null] }, fields: { id: 'a', why: 'w' } },
    ]);
    expect(out.map((o) => o.error)).toEqual([
      'KeyError',
      'AttributeError',
      'AttributeError',
      'AttributeError',
    ]);
  });

  it('writes the event after the append, so a failing event keeps the item in the queue', async () => {
    const [o] = await expectNewItemParity([
      { name: 'event fails', q: { items: [] }, fields: { id: 'a', why: 'w' }, event_fails: true },
    ]);
    expect(o!.error).toBe('OSError');
    expect(qOf(o!).items).toHaveLength(1);
    expect(o!.out.log).toEqual([['event', 'a', `${NOW} auto-enrolled: w`]]);
  });

  it('an item with no id is appended and then fails reading it for the event', async () => {
    const [o] = await expectNewItemParity([
      { name: 'id-less fields', q: { items: [{ id: 'a' }] }, fields: { kind: 'open', why: 'w' } },
    ]);
    expect(o!.error).toBe('KeyError');
    expect(qOf(o!).items).toHaveLength(2);
    expect(o!.out.log).toEqual([]);
  });

  it('lets fields override the defaults in place and replaces notes, dropping why', async () => {
    const [o] = await expectNewItemParity([
      {
        name: 'overrides',
        q: { items: [{ id: 'a', order: 2 }] },
        fields: {
          state: 'blocked',
          order: 99,
          cycles: [1],
          notes: ['mine'],
          id: 'b',
          why: 'because',
        },
      },
      { name: 'no why', q: { items: [] }, fields: { id: 'c' } },
    ]);
    const item = qOf(o!).items[1]!;
    expect(item).toMatchObject({
      state: 'blocked',
      order: 99,
      cycles: [1],
      notes: [`${NOW} auto-enrolled: because`],
    });
    expect(item).not.toHaveProperty('why');
    expect(Object.keys(item).slice(0, 4)).toEqual(['order', 'state', 'cycles', 'attempts']);
  });
});

// --- finalize_publication composition ---------------------------------------

interface FinalizeCase {
  name: string;
  q: Rec;
  item: Rec;
  run: string;
  record: Rec;
  publication: Rec;
  repo: string;
  fix_pr_cycles: number | null;
  listed: FixPrRow[][];
  create: 'ok' | 'runtime' | 'timeout';
  backlog: [number, number] | null;
  event_fails: boolean;
  files: Record<string, string>;
}

const PR_ROW = {
  number: 101,
  url: 'https://github.com/o/r/pull/101',
  state: 'OPEN',
  headRefOid: 'h1',
};

function base(over: Partial<FinalizeCase> & { name: string }): FinalizeCase {
  return {
    q: { items: [] },
    item: { id: 'x', pr: 0, kind: 'merged', state: 'repairing' },
    run: 'run-1',
    record: {
      jobs: ['crq-a'],
      state: 'ready',
      verdicts: [{ job: 'crq-a', verdict: 'FIXED', reason: 'ok | x\ny' }],
    },
    publication: {
      head: 'h1',
      target: 't',
      branch: 'crq/fix-run-1',
      commits: ['c1'],
      open_pr: false,
    },
    repo: 'o/r',
    fix_pr_cycles: null,
    listed: [[], [PR_ROW]],
    create: 'ok',
    backlog: null,
    event_fails: false,
    files: { 'repair/inbox/crq-a.json': JSON.stringify({ finding: { id: 'F-1' }, pr: 21 }) },
    ...over,
  };
}

async function tsFinalize(c: FinalizeCase): Promise<Outcome> {
  const q = structuredClone(c.q);
  const item = structuredClone(c.item);
  const record = structuredClone(c.record);
  const publication = structuredClone(c.publication);
  const dir = await mkdtemp(join(tmpdir(), 'crq-enroll-'));
  cleanups.push(dir);
  const state = join(dir, 'state');
  for (const [rel, text] of Object.entries(c.files)) {
    await mkdir(dirname(join(state, rel)), { recursive: true });
    await writeFile(join(state, rel), text);
  }
  const provenance = filePublicationProvenance({ stateRoot: state, repo: c.repo });
  const log: unknown[] = [];
  let calls = 0;
  let body: string | null = null;
  let journal: Rec | null = null;
  const backlog = new FixPrBacklog();
  backlog.open = c.backlog?.[0] ?? null;
  backlog.limit = c.backlog?.[1] ?? null;
  const iso = () => NOW;
  const effects: PublicationFinalizeEffects = {
    repo: c.repo,
    ...(c.fix_pr_cycles === null ? {} : { fixPrCycles: c.fix_pr_cycles }),
    iso,
    async listBranchPrs(branch) {
      log.push(['list', branch]);
      return structuredClone(c.listed[Math.min(calls++, c.listed.length - 1)]!);
    },
    repairProvenance: (r, run) => provenance.repairProvenance(r, run),
    async writeFixPrBody(_jobId, text) {
      body = text;
      return '/body.md';
    },
    async writeJournal(_jobId, p) {
      journal = structuredClone(p);
    },
    async saveQueue(queue) {
      log.push(['save', structuredClone(queue)]);
    },
    async createPr(request) {
      log.push(['create', { base: request.base, head: request.head, title: request.title }]);
      if (c.create === 'runtime') throw new PyError('RuntimeError', 'gh pr create failed');
      if (c.create === 'timeout')
        throw Object.assign(new Error('timed out'), { name: 'TimeoutExpired' });
    },
    newItem: publicationNewItem({
      iso,
      event: async (id, reason) => {
        log.push(['event', id, reason]);
        if (c.event_fails) throw new PyError('OSError', 'events.jsonl is not writable');
      },
    }),
  };
  let error: string | null = null;
  try {
    await finalizePublication(effects, backlog, q, item, c.run, record, publication);
  } catch (e) {
    error = familyOf(e);
  }
  return {
    error,
    out: {
      q,
      item,
      record,
      publication,
      log,
      backlog: { open: backlog.open, limit: backlog.limit },
      body,
      journal,
    },
  };
}

/** Compare a finalize case across both implementations; returns Python's outcome. */
async function expectFinalizeParity(c: FinalizeCase): Promise<Outcome> {
  const [python] = runOracle([{ op: 'finalize', now: NOW, ...c }]);
  const ts = await tsFinalize(c);
  const canon = (o: Outcome) => {
    const out = o.out;
    return JSON.stringify([
      o.error,
      out.q,
      out.item,
      out.record,
      out.publication,
      out.log,
      out.backlog,
      out.body,
      out.journal,
    ]);
  };
  expect(canon(ts), c.name).toBe(canon(python!));
  return python!;
}

const events = (o: Outcome) => (o.out.log as unknown[][]).filter((e) => e[0] === 'event');
const items = (o: Outcome) => qOf(o).items;
const logKinds = (o: Outcome) => (o.out.log as unknown[][]).map((e) => e[0]);

describe('finalizePublication enrolls the fix PR through the real newItem effect', () => {
  it('create path: list, create, list, enroll (event before the final save), published', async () => {
    const o = await expectFinalizeParity(base({ name: 'fresh create' }));
    expect(o.error).toBeNull();
    expect(logKinds(o)).toEqual(['list', 'save', 'create', 'list', 'event', 'save']);
    expect(items(o)).toEqual([
      {
        order: 1,
        state: 'pending',
        cycles: [],
        attempts: [],
        id: 'pr101',
        pr: 101,
        kind: 'open',
        tier: 1,
        prior_cycles: 0,
        repair_origin: 'run-1',
        notes: [`${NOW} auto-enrolled: verified repair fix PR`],
      },
    ]);
    expect(events(o)).toEqual([['event', 'pr101', `${NOW} auto-enrolled: verified repair fix PR`]]);
    expect(o.out.item).toMatchObject({ state: 'done' });
    expect(o.out.record).toMatchObject({ state: 'published', fix_pr: PR_ROW });
    // The pre-create save does not yet hold the item; the last one does.
    const saves = (o.out.log as unknown[][])
      .filter((e) => e[0] === 'save')
      .map((e) => (e[1] as { items: Rec[] }).items.length);
    expect(saves).toEqual([0, 1]);
  });

  it('adopts a PR the branch already has: no create, still enrolled once', async () => {
    const o = await expectFinalizeParity(base({ name: 'adopt', listed: [[PR_ROW]] }));
    expect(logKinds(o)).toEqual(['list', 'event', 'save']);
    expect(items(o)).toHaveLength(1);
  });

  it('stores prior_cycles 0 whatever fix_pr_cycles is configured', async () => {
    for (const cycles of [0, 1, 2, 5, null]) {
      const o = await expectFinalizeParity(
        base({ name: `cycles ${String(cycles)}`, fix_pr_cycles: cycles, listed: [[PR_ROW]] }),
      );
      expect(items(o)[0]!.prior_cycles).toBe(0);
    }
  });

  it('numbers the new item after the live items, ignoring a retired promotion', async () => {
    const o = await expectFinalizeParity(
      base({
        name: 'order',
        listed: [[PR_ROW]],
        q: {
          items: [
            { id: 'a', pr: 1, kind: 'open', order: 6 },
            { id: 'old', pr: 2, kind: 'promotion', order: 40 },
          ],
        },
      }),
    );
    expect(items(o).at(-1)!.order).toBe(7);
  });

  it('does not enroll a PR that already has an open item, even a skipped or done one', async () => {
    for (const state of ['pending', 'skipped', 'done']) {
      const o = await expectFinalizeParity(
        base({
          name: `existing ${state}`,
          listed: [[PR_ROW]],
          q: { items: [{ id: 'mine', pr: 101, kind: 'open', state, order: 3 }] },
        }),
      );
      expect(events(o)).toEqual([]);
      expect(items(o)).toHaveLength(1);
      expect(o.out.record).toMatchObject({ state: 'published' });
    }
  });

  it('a same-id item of another kind is sticky: nothing is enrolled, no event, the record still publishes', async () => {
    const o = await expectFinalizeParity(
      base({
        name: 'sticky twin',
        listed: [[PR_ROW]],
        q: { items: [{ id: 'pr101', pr: 7, kind: 'delta', state: 'skipped', order: 2 }] },
      }),
    );
    expect(o.error).toBeNull();
    expect(events(o)).toEqual([]);
    expect(items(o)).toHaveLength(1);
    expect(o.out.record).toMatchObject({ state: 'published' });
    expect(o.out.item).toMatchObject({ state: 'done' });
  });

  it('a retired promotion with the same id does not block enrollment', async () => {
    const o = await expectFinalizeParity(
      base({
        name: 'promotion twin',
        listed: [[PR_ROW]],
        q: { items: [{ id: 'pr101', pr: 101, kind: 'promotion', order: 9 }] },
      }),
    );
    expect(items(o)).toHaveLength(2);
    expect(items(o)[1]).toMatchObject({ id: 'pr101', kind: 'open', order: 1 });
  });

  it('a failing event leaves the item queued but unsaved and the record unpublished', async () => {
    const o = await expectFinalizeParity(
      base({ name: 'event fails', listed: [[PR_ROW]], event_fails: true }),
    );
    expect(o.error).toBe('OSError');
    expect(items(o)).toHaveLength(1);
    expect(logKinds(o)).toEqual(['list', 'event']);
    expect(o.out.record).not.toMatchObject({ state: 'published' });
    expect(o.out.item).toMatchObject({ state: 'repairing' });
  });

  it('enrolls nothing on an open-PR publication, an exhausted create, or a refused identity', async () => {
    const openPr = await expectFinalizeParity(
      base({
        name: 'open pr',
        publication: {
          head: 'h1',
          target: 't',
          branch: 'crq/fix-run-1',
          commits: ['c1'],
          open_pr: true,
        },
        item: { id: 'x', pr: 21, kind: 'open', state: 'repairing' },
      }),
    );
    expect(logKinds(openPr)).toEqual(['save']);
    expect(items(openPr)).toEqual([]);
    const stale = await expectFinalizeParity(
      base({
        name: 'exhausted',
        publication: {
          head: 'h1',
          target: 't',
          branch: 'crq/fix-run-1',
          commits: ['c1'],
          open_pr: false,
          pr_create_pending: true,
          pr_create_attempts: 3,
        },
        listed: [[]],
      }),
    );
    expect(stale.out.record).toMatchObject({ state: 'stale' });
    expect(events(stale)).toEqual([]);
    for (const [name, rows] of [
      ['wrong head', [{ ...PR_ROW, headRefOid: 'other' }]],
      ['two PRs', [PR_ROW, { ...PR_ROW, number: 102 }]],
    ] as const) {
      const refused = await expectFinalizeParity(base({ name, listed: [[...rows]] }));
      expect(refused.error).toBe('ValueError');
      expect(events(refused)).toEqual([]);
      expect(items(refused)).toEqual([]);
    }
  });

  it('a create gh reports as failed enrolls nothing; the retry enrolls once and a re-run adds nothing', async () => {
    const first = await expectFinalizeParity(base({ name: 'create fails', create: 'runtime' }));
    expect(first.error).toBe('RuntimeError');
    expect(events(first)).toEqual([]);
    expect(first.out.journal).toMatchObject({ pr_create_pending: true, pr_create_attempts: 1 });

    // Next tick: the journal and record carry over, the PR now exists.
    const retry = base({
      name: 'retry',
      q: first.out.q as Rec,
      record: first.out.record as Rec,
      publication: first.out.publication as Rec,
      item: first.out.item as Rec,
      listed: [[PR_ROW]],
    });
    const second = await expectFinalizeParity(retry);
    expect(second.error).toBeNull();
    expect(events(second)).toHaveLength(1);
    expect(items(second)).toHaveLength(1);

    // A further run over the enrolled queue enrolls nothing more.
    const third = await expectFinalizeParity(
      base({
        name: 'idempotent re-run',
        q: second.out.q as Rec,
        record: second.out.record as Rec,
        publication: second.out.publication as Rec,
        item: second.out.item as Rec,
        listed: [[PR_ROW]],
      }),
    );
    expect(events(third)).toEqual([]);
    expect(items(third)).toHaveLength(1);
  });

  it('a create that times out may have landed: nothing enrolled this tick, a backfill slot stays taken', async () => {
    const backfill = { id: 'backfill-finding-a', pr: 0, kind: 'merged', state: 'repairing' };
    const timed = await expectFinalizeParity(
      base({ name: 'timeout', create: 'timeout', item: backfill, backlog: [1, 5] }),
    );
    expect(timed.error).toBe('TimeoutExpired');
    expect(timed.out.backlog).toEqual({ open: 2, limit: 5 });
    expect(events(timed)).toEqual([]);
    const failed = await expectFinalizeParity(
      base({ name: 'runtime on backfill', create: 'runtime', item: backfill, backlog: [1, 5] }),
    );
    expect(failed.out.backlog).toEqual({ open: 1, limit: 5 });
    const ok = await expectFinalizeParity(
      base({ name: 'backfill enrolls', item: backfill, backlog: [0, 1] }),
    );
    expect(ok.out.backlog).toEqual({ open: 1, limit: 1 });
    expect(events(ok)).toHaveLength(1);
    const held = await expectFinalizeParity(
      base({ name: 'backfill held', item: backfill, backlog: [1, 1] }),
    );
    expect(held.error).toBeNull();
    expect(events(held)).toEqual([]);
    expect(items(held)).toEqual([]);
  });

  it('a malformed live item fails the enrollment check the way Python does', async () => {
    const noPr = await expectFinalizeParity(
      base({ name: 'live item without pr', listed: [[PR_ROW]], q: { items: [{ id: 'a' }] } }),
    );
    expect(noPr.error).toBe('KeyError');
    expect(events(noPr)).toEqual([]);
  });
});

describe('composition boundaries', () => {
  it('is assignable to the finalize effect declaration and imports only its two peers', async () => {
    const newItem: PublicationFinalizeEffects['newItem'] = publicationNewItem({
      iso: () => NOW,
      event: async () => undefined,
    });
    expect(typeof newItem).toBe('function');
    const source = await readFile(SOURCE, 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./pyErrors.js', './repairBackfill.js']);
  });

  it('writes the enrolled event only through the injected effect', async () => {
    const seen: unknown[][] = [];
    const q: Rec = { items: [] };
    await publicationNewItem({
      iso: () => NOW,
      event: async (id, reason) => void seen.push([id, reason]),
    })(q, {
      id: 'pr9',
      pr: 9,
      kind: 'open',
      why: 'w',
    });
    expect(seen).toEqual([['pr9', `${NOW} auto-enrolled: w`]]);
    expect(q.items).toHaveLength(1);
  });
});
