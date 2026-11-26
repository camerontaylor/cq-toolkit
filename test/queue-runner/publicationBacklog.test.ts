// Differential run of the offline fix-PR publication path (publish, recovery and
// finalize, without enrollment) over ONE shared backlog: `refreshFixPrBacklog` -> `publishRepair` (initial, or journal recovery
// when the job journal holds a publication) -> `finalizePublication`, composed over a single explicitly
// injected `FixPrBacklog`, against Python's real `refresh_fix_pr_backlog`,
// `publish`, `recover_publication` and `finalize_publication`
// (apps/crq-python/repair_tick.py) driven by test/helpers/publicationBacklogOracle.py.
//
// What the per-function suites cannot show is pinned here across ticks: the one
// refresh view that every publish in a tick reads, the slot reserved by a create
// and released only on a `gh` failure (not a timeout), the hold that leaves a
// pushed and journaled publication for the next tick's recovery, and #2291's
// legacy accounting (a backfill item's `revalidated-` retry branch counts, an
// ordinary item's does not). Every case is a synthetic world: Git, `gh`, the
// forge and the provider are scripted in memory on both sides, the only disk is
// a throwaway state tree, `newItem` is stubbed on both sides (enrollment is pinned
// by publicationEnroll.test.ts), and nothing here is bound into `tick` or the runtime.
// The final queue, the journal and backlog files, the ordered effect log and the
// backlog view after every publish are compared as JSON text.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileFixPrBacklogEffects } from '../../src/adapters/crq/fixPrBacklogSource.js';
import { filePublicationEffects } from '../../src/adapters/crq/publicationFiles.js';
import { FixPrBacklog, refreshFixPrBacklog } from '../../src/queue-runner/fixPrBacklog.js';
import {
  finalizePublication,
  type PublicationFinalizeEffects,
} from '../../src/queue-runner/publicationFinalize.js';
import {
  publishRepair,
  type PublicationPublishEffects,
} from '../../src/queue-runner/publicationPublish.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';

const ORACLE = fileURLToPath(new URL('../helpers/publicationBacklogOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));

type Rec = Record<string, unknown>;
type Mode = 'ok' | 'runtime' | 'timeout-landed' | 'timeout-lost';
type Entry = unknown[];

interface Tick {
  gh_open?: 'ok' | 'fail';
  refresh?: boolean;
  external_open?: string[];
  external_close?: string[];
  close?: string[];
  create?: Record<string, Mode>;
  push_fail?: string[];
  publish: string[];
}

interface Case {
  name: string;
  /** `review_started` events in the last hours; `null` is no `events.jsonl`. */
  starts: number | null;
  external: string[];
  pubs: Record<string, { item: number; run: string }>;
  ticks: Tick[];
}

interface Outcome {
  log: Entry[];
  q: Rec;
  files: Record<string, string>;
}

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

// --- the synthetic queue ----------------------------------------------------

function record(job: string, over: Rec = {}): Rec {
  return {
    jobs: [job],
    base: 'base-sha',
    open_pr: false,
    branch: 'fix-branch',
    state: 'ready',
    verdicts: [{ job, verdict: 'FIXED', reason: 'ok' }],
    ...over,
  };
}

function item(id: string, pr: number, kind: string, runs: Record<string, Rec>): Rec {
  return { id, pr, kind, state: 'repairing', repair_runs: runs };
}

/** Fresh every call: both implementations mutate their queue in place. */
function makeQueue(): Rec {
  return {
    items: [
      item('backfill-finding-a', 0, 'merged', { 'run-a': record('crq-a') }),
      item('backfill-finding-b', 0, 'merged', { 'run-b': record('crq-b') }),
      // A prepared retry keeps the counted backfill branch prefix (#2288).
      item('backfill-finding-c', 0, 'merged', { 'revalidated-c': record('crq-c') }),
      item('pr7', 0, 'merged', { 'run-p': record('crq-p') }),
      // #2291: an older backfill retry whose branch has the ordinary prefix.
      item('backfill-finding-old', 0, 'merged', {
        'revalidated-old': record('crq-old', { state: 'published' }),
      }),
      // ...but the same run name on an ordinary item is not backfill-owned.
      item('pr9', 0, 'merged', { 'revalidated-z': record('crq-z', { state: 'published' }) }),
      item('pr5', 5, 'open', { 'run-o': record('crq-o', { open_pr: true }) }),
    ],
  };
}

const PUBS = {
  a: { item: 0, run: 'run-a' },
  b: { item: 1, run: 'run-b' },
  c: { item: 2, run: 'revalidated-c' },
  p: { item: 3, run: 'run-p' },
  o: { item: 6, run: 'run-o' },
};

// --- the Python side --------------------------------------------------------

const eventsText = (starts: number | null): string | null => {
  if (starts === null) return null;
  const at = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    Array.from({ length: starts }, () => JSON.stringify({ at, event: 'review_started' })).join(
      '\n',
    ) + '\n'
  );
};

function runOracle(cases: Case[]): Outcome[] {
  const payload = cases.map((c) => ({
    queue: makeQueue(),
    events: eventsText(c.starts),
    external: c.external,
    pubs: c.pubs,
    ticks: c.ticks.map((t) => ({ create: {}, push_fail: [], ...t })),
  }));
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases: payload }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

// --- the TypeScript side ----------------------------------------------------

const familyOf = (e: unknown): string => (e instanceof PyError ? e.kind : (e as Error).name);

interface PrRow {
  number: number;
  url: string;
  state: string;
  headRefOid: string;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

async function tsRun(c: Case): Promise<Outcome> {
  const q = makeQueue();
  const items = q.items as Rec[];
  const dir = await mkdtemp(join(tmpdir(), 'crq-backlog-'));
  cleanups.push(dir);
  const stateRoot = join(dir, 'root', 'state');
  await mkdir(stateRoot, { recursive: true });
  const text = eventsText(c.starts);
  if (text !== null) await writeFile(join(stateRoot, 'events.jsonl'), text);
  for (const spec of Object.values(c.pubs)) {
    const runs = items[spec.item]!.repair_runs as Record<string, Rec>;
    const job = (runs[spec.run]!.jobs as string[])[0]!;
    await mkdir(join(stateRoot, 'repair', job), { recursive: true });
  }

  const log: Entry[] = [];
  const world = {
    prs: new Map<string, PrRow[]>(),
    remote: new Map<string, string>(),
    external: [...c.external],
    n: 0,
  };
  const cur = { run: '', name: '', picked: false, tick: {} as Tick };
  const files = filePublicationEffects({ stateRoot });
  const saveQueue = async (queue: Rec): Promise<void> => {
    log.push(['save', structuredClone(queue)]);
    await files.saveQueue(queue);
  };

  /** The one shared view, owned here and handed to the refresh and to finalize. */
  const backlog = new FixPrBacklog();
  const refreshEffects = fileFixPrBacklogEffects({
    stateRoot,
    async listOpenPrs() {
      log.push(['list-open']);
      if (cur.tick.gh_open === 'fail') throw new PyError('RuntimeError', 'gh pr list failed');
      const rows: Rec[] = world.external.map((headRefName) => ({ headRefName }));
      for (const [branch, prs] of world.prs) {
        for (const pr of prs) if (pr.state === 'OPEN') rows.push({ headRefName: branch });
      }
      return rows;
    },
  });

  const listBranchPrs = async (branch: string): Promise<PrRow[]> => {
    log.push(['list', branch]);
    return structuredClone(world.prs.get(branch) ?? []);
  };
  const finalizeEffects: PublicationFinalizeEffects = {
    repo: 'o/r',
    iso: () => 'now',
    listBranchPrs,
    repairProvenance: async () => [],
    writeFixPrBody: (job, body) => files.writeFixPrBody(job, body),
    writeJournal: (job, publication) => files.writeJournal(job, publication),
    saveQueue,
    async createPr(request) {
      const mode = cur.tick.create?.[cur.name] ?? 'ok';
      log.push(['create', request.head, mode]);
      if (mode === 'runtime') throw new PyError('RuntimeError', 'gh pr create failed');
      if (mode !== 'timeout-lost') {
        world.n += 1;
        const rows = world.prs.get(request.head) ?? [];
        rows.push({
          number: 100 + world.n,
          url: `u${world.n}`,
          state: 'OPEN',
          headRefOid: `head-${cur.run}`,
        });
        world.prs.set(request.head, rows);
      }
      if (mode.startsWith('timeout')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutExpired' });
      }
    },
    async newItem(_queue, fields) {
      log.push(['new-item', fields.id]);
    },
  };

  const publishEffects = (p: {
    q: Rec;
    item: Rec;
    run: string;
    rec: Rec;
  }): PublicationPublishEffects => ({
    iso: () => 'now',
    readJournal: (job) => files.readJournal(job),
    async revParseDefaultRef() {
      return 'target-main';
    },
    async prInfo(pr) {
      log.push(['pr-info', pr]);
      return { state: 'OPEN', headRefName: 'fix-branch', headRefOid: 'target-open' };
    },
    async isAncestor(older, newer) {
      log.push(['ancestor', older, newer]);
      return true;
    },
    async makeWorktree(name, sha) {
      log.push(['worktree', name, sha]);
      return { path: `/wt/${name}`, branch: `wtb-${name}` };
    },
    async removeWorktree() {
      log.push(['remove-worktree']);
    },
    async revParseHead() {
      return cur.picked ? `head-${cur.run}` : `base-${cur.run}`;
    },
    async cherryPick() {
      cur.picked = true;
    },
    async verifyCherryPickHead() {
      throw new PyError('RuntimeError', 'no CHERRY_PICK_HEAD');
    },
    async conflictedFiles() {
      return '';
    },
    async stagedFiles() {
      return '';
    },
    async revListSince() {
      return [`claim-${cur.run}`];
    },
    async verify(_wt, before, claims, job) {
      log.push(['verify', before, [...claims], job]);
    },
    async diffSince() {
      return `diff-${cur.run}`;
    },
    writePatch: (job, body) => files.writePatch(job, body),
    async hackDetector(_wt, diff) {
      log.push(['hack', diff]);
    },
    async secretScan(_job, target, head) {
      log.push(['secret-scan', target, head]);
      return true;
    },
    async updateRef(ref, sha) {
      log.push(['update-ref', ref, sha]);
    },
    writeJournal: (job, publication) => files.writeJournal(job, publication),
    saveQueue,
    async push(branch, expected, sha) {
      log.push(['push', branch, expected, sha]);
      if (cur.tick.push_fail?.includes(cur.name)) {
        throw new PyError('RuntimeError', 'git push failed: network');
      }
      world.remote.set(branch, sha);
    },
    async lsRemoteHeads(branch) {
      log.push(['ls-remote', branch]);
      const sha = world.remote.get(branch);
      return sha === undefined ? '' : `${sha}\trefs/heads/${branch}`;
    },
    listBranchPrs,
    finalize: (publication) =>
      finalizePublication(finalizeEffects, backlog, p.q, p.item, p.run, p.rec, publication),
  });

  for (const [index, tick] of c.ticks.entries()) {
    cur.tick = tick;
    log.push(['tick', index]);
    backlog.reset();
    for (const branch of tick.close ?? []) {
      for (const pr of world.prs.get(branch) ?? []) pr.state = 'MERGED';
    }
    world.external = world.external.filter((b) => !tick.external_close?.includes(b));
    world.external.push(...(tick.external_open ?? []));
    if (tick.refresh ?? true) {
      const view = await refreshFixPrBacklog(
        backlog,
        refreshEffects,
        q as { items?: readonly Rec[] },
      );
      log.push(['refresh', view === null ? null : { open: view.open, limit: view.limit }]);
      let doc: Rec | null = null;
      try {
        doc = JSON.parse(
          await readFile(join(stateRoot, 'repair', 'fix-pr-backlog.json'), 'utf8'),
        ) as Rec;
        delete doc.at;
      } catch {
        doc = null;
      }
      log.push(['file', doc]);
    }
    for (const name of tick.publish) {
      const spec = c.pubs[name]!;
      const it = items[spec.item]!;
      const rec = (it.repair_runs as Record<string, Rec>)[spec.run]!;
      const fixed = [
        {
          job: (rec.jobs as string[])[0],
          verdict: 'FIXED',
          reason: 'ok',
          commits: [`src-${spec.run}`],
        },
      ];
      Object.assign(cur, { run: spec.run, name, picked: false });
      log.push(['publish', name]);
      let error: string | null = null;
      try {
        await publishRepair(
          publishEffects({ q, item: it, run: spec.run, rec }),
          q,
          it,
          spec.run,
          rec,
          fixed,
        );
      } catch (e) {
        error = familyOf(e);
      }
      log.push([
        'result',
        name,
        error,
        rec.state ?? null,
        { open: backlog.open, limit: backlog.limit },
      ]);
    }
    backlog.reset();
    log.push(['reset', { open: backlog.open, limit: backlog.limit }]);
  }

  const out: Record<string, string> = {};
  for (const path of (await listFiles(stateRoot)).sort()) {
    const name = path.split('/').at(-1)!;
    if (!['publication.json', 'queue.json', 'fix-pr-backlog.json'].includes(name)) continue;
    let body = await readFile(path, 'utf8');
    if (name === 'fix-pr-backlog.json') {
      const doc = JSON.parse(body) as Rec;
      delete doc.at;
      body = JSON.stringify(doc);
    }
    out[relative(stateRoot, path)] = body;
  }
  return { log, q, files: out };
}

const canon = (o: Outcome): string =>
  JSON.stringify([o.log, o.q, Object.fromEntries(Object.entries(o.files).sort())]);

/** Run one case on both sides, require identical outcomes, return Python's. */
async function parity(c: Case): Promise<Outcome> {
  const [python] = runOracle([c]);
  const ts = await tsRun(c);
  // Name the first diverging effect instead of dumping two whole transcripts.
  const at = ts.log.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(python!.log[i]));
  expect(
    at === -1 ? null : { at, ts: ts.log[at], py: python!.log[at] },
    `${c.name}: first diverging log entry`,
  ).toBeNull();
  expect(ts.log.length, `${c.name}: log length`).toBe(python!.log.length);
  expect(JSON.stringify(ts.q), `${c.name}: final queue`).toBe(JSON.stringify(python!.q));
  expect(Object.keys(ts.files).sort(), `${c.name}: file names`).toEqual(
    Object.keys(python!.files).sort(),
  );
  for (const [name, text] of Object.entries(python!.files)) {
    expect(ts.files[name], `${c.name}: ${name}`).toBe(text);
  }
  expect(canon(ts), c.name).toBe(canon(python!));
  return python!;
}

const creates = (o: Outcome): string[] =>
  o.log.filter((e) => e[0] === 'create').map((e) => `${e[1] as string}:${e[2] as string}`);
const pushes = (o: Outcome): string[] =>
  o.log.filter((e) => e[0] === 'push').map((e) => e[1] as string);
const views = (o: Outcome): unknown[] => o.log.filter((e) => e[0] === 'refresh').map((e) => e[1]);
const results = (o: Outcome): string[] =>
  o.log
    .filter((e) => e[0] === 'result')
    .map((e) => `${e[1] as string}:${(e[2] as string | null) ?? 'ok'}:${e[3] as string}`);
const runState = (o: Outcome, index: number, run: string): unknown =>
  (((o.q.items as Rec[])[index]!.repair_runs as Record<string, Rec>)[run] as Rec).state;

describe('publication over one shared FixPrBacklog (Python parity)', () => {
  it('shares one refreshed slot across initial publish, held recovery and finalize', async () => {
    const out = await parity({
      name: 'shared slot across ticks',
      starts: 36, // limit 36 * 4 // 72 = 2
      external: ['crq/fix-revalidated-old', 'crq/fix-revalidated-z', 'crq/fix-misc'],
      pubs: PUBS,
      ticks: [
        { publish: ['a', 'b', 'c', 'p'] },
        // a's own PR now counts: 1 legacy + 1 = 2 = limit, so b and c stay held.
        { publish: ['b', 'c'] },
        {
          close: ['crq/fix-backfill-run-a'],
          external_close: ['crq/fix-revalidated-old'],
          publish: ['b', 'c'],
        },
      ],
    });
    // Only the legacy backfill retry branch is counted: open 1 of limit 2, not 3.
    expect(views(out)).toEqual([
      { open: 1, limit: 2 },
      { open: 2, limit: 2 },
      { open: 0, limit: 2 }, // a's PR and the legacy branch closed; ordinary run-p never counts
    ]);
    // a takes the one free slot, p is never capped, b and c wait for tick 2.
    expect(creates(out)).toEqual([
      'crq/fix-backfill-run-a:ok',
      'crq/fix-run-p:ok',
      'crq/fix-backfill-run-b:ok',
      'crq/fix-backfill-revalidated-c:ok',
    ]);
    // b and c were pushed and journaled on tick 0 and only recovered afterwards.
    expect(pushes(out)).toEqual([
      'crq/fix-backfill-run-a',
      'crq/fix-backfill-run-b',
      'crq/fix-backfill-revalidated-c',
      'crq/fix-run-p',
    ]);
    expect(results(out)).toEqual([
      'a:ok:published',
      'b:ok:ready',
      'c:ok:ready',
      'p:ok:published',
      'b:ok:ready',
      'c:ok:ready',
      'b:ok:published',
      'c:ok:published',
    ]);
  });

  it('reserves before create, releases only on a gh failure and re-reads on the next tick', async () => {
    const out = await parity({
      name: 'slot accounting under create failures',
      starts: 54, // limit 3
      external: [],
      pubs: PUBS,
      ticks: [
        { create: { a: 'runtime', b: 'timeout-landed', c: 'ok' }, publish: ['a', 'b', 'c'] },
        { publish: ['a', 'b'] },
      ],
    });
    expect(results(out).slice(0, 3)).toEqual([
      'a:RuntimeError:ready',
      'b:TimeoutExpired:ready',
      'c:ok:published',
    ]);
    const after = out.log.filter((e) => e[0] === 'result').map((e) => e[4]);
    expect(after.slice(0, 3)).toEqual([
      { open: 0, limit: 3 }, // released: gh reported the create failed
      { open: 1, limit: 3 }, // kept: the create may have landed
      { open: 2, limit: 3 },
    ]);
    // Tick 1 recounts from the forge: b's and c's PRs, then a recovers and creates.
    expect(views(out)[1]).toEqual({ open: 2, limit: 3 });
    expect(creates(out)).toEqual([
      'crq/fix-backfill-run-a:runtime',
      'crq/fix-backfill-run-b:timeout-landed',
      'crq/fix-backfill-revalidated-c:ok',
      'crq/fix-backfill-run-a:ok',
    ]);
    expect(results(out).slice(3)).toEqual(['a:ok:published', 'b:ok:published']);
  });

  it('an unread view (failed or skipped refresh) holds backfill but never ordinary PRs', async () => {
    const out = await parity({
      name: 'unread backlog',
      starts: 18, // limit 1
      external: [],
      pubs: PUBS,
      ticks: [
        { gh_open: 'fail', publish: ['a', 'p'] },
        { refresh: false, publish: ['a'] },
        { publish: ['a'] },
      ],
    });
    expect(views(out)).toEqual([null, { open: 0, limit: 1 }]);
    expect(creates(out)).toEqual(['crq/fix-run-p:ok', 'crq/fix-backfill-run-a:ok']);
    expect(results(out)).toEqual(['a:ok:ready', 'p:ok:published', 'a:ok:ready', 'a:ok:published']);
    // A failed refresh writes no file; only the healthy tick does.
    expect(out.files['repair/fix-pr-backlog.json']).toBe(JSON.stringify({ open: 0, limit: 1 }));
  });

  it('no events file is a zero limit: backfill is pushed and journaled but held, an open-PR run is not', async () => {
    const out = await parity({
      name: 'zero limit',
      starts: null,
      external: [],
      pubs: PUBS,
      ticks: [{ publish: ['a', 'o'] }],
    });
    expect(views(out)).toEqual([{ open: 0, limit: 0 }]);
    expect(creates(out)).toEqual([]);
    expect(pushes(out)).toEqual(['crq/fix-backfill-run-a', 'fix-branch']);
    expect(results(out)).toEqual(['a:ok:ready', 'o:ok:published']);
    expect(out.files['repair/crq-a/publication.json']).toBeDefined();
  });

  it('a push that failed before any create is recovered under a slot freed by the next refresh', async () => {
    const out = await parity({
      name: 'push failure then recovery',
      starts: 36, // limit 2
      external: ['crq/fix-backfill-x1', 'crq/fix-backfill-x2'],
      pubs: PUBS,
      ticks: [
        { push_fail: ['a'], publish: ['a'] },
        { external_close: ['crq/fix-backfill-x1'], publish: ['a'] },
      ],
    });
    expect(views(out)).toEqual([
      { open: 2, limit: 2 },
      { open: 1, limit: 2 },
    ]);
    expect(results(out)).toEqual(['a:RuntimeError:ready', 'a:ok:published']);
    // The first push failed on a new branch (lease ''); recovery pushes the journaled head.
    expect(out.log.filter((e) => e[0] === 'push')).toEqual([
      ['push', 'crq/fix-backfill-run-a', '', 'head-run-a'],
      ['push', 'crq/fix-backfill-run-a', '', 'head-run-a'],
    ]);
    expect(creates(out)).toEqual(['crq/fix-backfill-run-a:ok']);
    expect(runState(out, 0, 'run-a')).toBe('published');
  });

  it("#2291 legacy accounting: a backfill item's revalidated retry branch counts, an ordinary item's does not", async () => {
    const out = await parity({
      name: 'legacy accounting',
      starts: 18, // limit 1
      external: ['crq/fix-revalidated-old'],
      pubs: PUBS,
      ticks: [
        { publish: ['c'] },
        {
          external_close: ['crq/fix-revalidated-old'],
          external_open: ['crq/fix-revalidated-z'],
          publish: ['c'],
        },
      ],
    });
    // Tick 0: the legacy branch fills the one slot. Tick 1: its removal frees it
    // and the lookalike on the ordinary pr9 is not counted.
    expect(views(out)).toEqual([
      { open: 1, limit: 1 },
      { open: 0, limit: 1 },
    ]);
    expect(creates(out)).toEqual(['crq/fix-backfill-revalidated-c:ok']);
    expect(results(out)).toEqual(['c:ok:ready', 'c:ok:published']);
  });
});
