// Seeded composed offline shadow of the S6 repair-harvest path: the TypeScript
// `repairHarvest` driving `publishRepair`, `finalizePublication`,
// `publicationNewItem` and `decideRepairCleanup` through its two effect seams
// (`publish` and `cleanupHarvested`), against Python's real
// `repair_tick.harvest` driving the real `publish`, `recover_publication`,
// `finalize_publication`, `crq.new_item` and `crq_repair.retain.cleanup_harvested`
// (apps/crq-python) via test/helpers/repairHarvestShadowOracle.py.
//
// Each scenario is a fixed synthetic queue plus files, replayed over several
// ticks with restarts between them. A restart is an in-memory queue JSON round
// trip and a fresh `FixPrBacklog` in the same process; it does not re-read
// `state/queue.json`. The world persists, and what recovery reads back from disk
// is the publication journal (`state/repair/<job>/publication.json`) plus the
// result, inbox and snapshot files. Per tick the queue and the journal/patch/
// body/queue files are snapshotted and compared as JSON text; the ordered effect
// log and the in-memory removal set are compared once over the whole run, and the
// first diverging effect is named.
//
// Offline and non-destructive by construction. Git, `gh`, the forge, the
// provider, the finding ledger and the worktree removal are all scripted in
// memory on BOTH sides: a push moves a ref in a dict, a PR create appends a
// row, and `git worktree remove` is only recorded and added to a removed set
// that the directory probe consults. No directory is ever deleted; the only
// disk is a throwaway tree: the inputs the layout writes (state, result, inbox
// and retained-snapshot files, empty worktree directories) and the journal/
// patch/body/queue files the real writers produce there. Nothing is bound into `tick` or the runtime, nothing
// is pushed, and nothing leaves the process.
//
// A second family of scenarios (the "durable restart" describe at the end) makes
// every restart a real process boundary instead. Python runs one separate
// `python3` process per segment; each reloads `state/queue.json` with the real
// `crq.load_queue` and the in-memory world from `world.json`, a scratch file
// outside `state/`. The TypeScript side is just as separate: each segment is a
// `node` child process that runs test/helpers/repairHarvestShadowTs.ts (native
// type stripping) against the built `dist/` modules, with a fresh effects world,
// backlog and reads built only from disk: the queue comes back through
// `loadQueueDocument` and the world from `world.json`. The in-process scenarios
// run the same helper against `src/`. A tick's
// `save_fail` makes the N-th queue save made through the harvest effect seam fail
// before writing (the tick-end write is not counted). A durable live tick
// also does what `crq.tick` does around `harvest`: an exception becomes
// `last_error` and the queue is saved at the end of the tick; a tick's `crash`
// is the process dying right after harvest, so neither happens.
//
// The last family composes #2307's backlog refresh into the same run: a backfill
// item whose creation the shared fix-PR backlog view holds, then releases. Each
// live tick does what `crq.tick` does around `harvest` (reset the view, read it
// once through the mocked open-PR listing and `events.jsonl` when a backfill repair
// is present, harvest, reset), on both sides.
//
// The last scenario is the one that is NOT parity: a swapped inbox row (#2313), where Python
// and the port deliberately differ. Each side runs the same four durable processes on its own
// and its actual ordered effects and queue are pinned separately, with no late-write policy.
//
// Out of scope here, pinned elsewhere: the fix-PR backlog accounting on its own
// (publicationBacklog.test.ts), the individual policy edges of harvest
// (repairHarvest.test.ts), of cleanup (repairCleanup.test.ts) and of enrollment
// (publicationEnroll.test.ts). The scenarios here are the cross-component ones.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileFixPrBacklogEffects } from '../../src/adapters/crq/fixPrBacklogSource.js';
import { filePublicationEffects } from '../../src/adapters/crq/publicationFiles.js';
import { loadQueueDocument } from '../../src/adapters/crq/queueEffects.js';
import { fileRepairHarvestReads } from '../../src/adapters/crq/repairHarvestReads.js';
import { toPlainJson } from '../../src/policy/crq/jsonValue.js';
import { receiptJsonDigest } from '../../src/policy/crq/pythonJson.js';
import {
  backfillRepairPresent,
  FixPrBacklog,
  refreshFixPrBacklog,
} from '../../src/queue-runner/fixPrBacklog.js';
import { finalizePublication } from '../../src/queue-runner/publicationFinalize.js';
import { publicationNewItem } from '../../src/queue-runner/publicationEnroll.js';
import { publishRepair } from '../../src/queue-runner/publicationPublish.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import { decideRepairCleanup, RETAINED_ARCHIVES } from '../../src/queue-runner/repairCleanup.js';
import { repairHarvest } from '../../src/queue-runner/repairHarvest.js';
import {
  putFile,
  runTs as runTsModule,
  sha,
  type Mods,
  type Outcome,
  type Rec,
  type Retained,
  type Spec,
  type Tick,
} from '../helpers/repairHarvestShadowTs.js';

const ORACLE = fileURLToPath(new URL('../helpers/repairHarvestShadowOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
// The durable TypeScript side is this helper run as `node <helper>` against the built `dist/`.
const TS_CHILD = fileURLToPath(new URL('../helpers/repairHarvestShadowTs.ts', import.meta.url));
const DIST_CHECK = fileURLToPath(
  new URL('../../dist/queue-runner/repairHarvest.js', import.meta.url),
);

const SHA1 = 'a'.repeat(40);
const BASE = 'b0';
const J1 = 'crq-R-F1';
const J2 = 'crq-R-F2';
const ITEM = 'pr7';
const tree = (job: string, suffix = ''): string => `crq-repair-${ITEM}-${job}${suffix}`;

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

// --- the synthetic world ----------------------------------------------------

const STUB_REPAIR = `import builtins
def mechanical(config, wt, predecessor, commits, job_id, directory):
    builtins.SHADOW_LOG.append(['mechanical', wt.name, predecessor, list(commits), job_id, directory.name])
`;

/** One `retained-<token>/` snapshot written the way `retain()` does. */
function writeRetained(root: string, r: Retained, index: number): void {
  const contents = Object.fromEntries(
    RETAINED_ARCHIVES.map((name) => [name, `${name}:${String(index)}\n`]),
  );
  const manifest = {
    base: r.base,
    head: r.head,
    commits: [] as string[],
    untracked: [] as string[],
    sha256: Object.fromEntries(Object.entries(contents).map(([k, v]) => [k, sha(v)])),
  };
  const target = join(
    root,
    'state',
    'repair',
    r.job,
    'final',
    `retained-${receiptJsonDigest(manifest as unknown as never)}`,
  );
  mkdirSync(target, { recursive: true });
  for (const [name, body] of Object.entries(contents)) writeFileSync(join(target, name), body);
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest));
}

/** The spec with `{WT}` bound to this side's worktree root. */
function materialize(spec: Spec, root: string): Spec {
  return JSON.parse(JSON.stringify(spec).replaceAll('{WT}', join(root, 'wt'))) as Spec;
}

/** Lay out one side's throwaway tree. Both sides get byte-identical state. */
function layout(spec: Spec, durable = false): { root: string; spec: Spec } {
  const root = mkdtempSync(join(tmpdir(), 'repair-shadow-'));
  cleanups.push(root);
  const bound = materialize(spec, root);
  mkdirSync(join(root, 'wt'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'crq_repair.py'), STUB_REPAIR);
  for (const [rel, doc] of Object.entries(bound.files)) putFile(join(root, 'state'), rel, doc);
  // A durable run starts from a queue on disk; both sides get these exact bytes.
  if (durable)
    putFile(join(root, 'state'), 'queue.json', { items: [bound.item, ...(bound.extra ?? [])] });
  for (const name of Object.keys(bound.trees))
    mkdirSync(join(root, 'wt', name), { recursive: true });
  for (const [index, r] of (bound.retained ?? []).entries()) writeRetained(root, r, index);
  return { root, spec: bound };
}

// --- the Python side --------------------------------------------------------

function runPython(spec: Spec): { out: Outcome; root: string } {
  const { root, spec: bound } = layout(spec);
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ root, spec: bound }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  return { out: JSON.parse(stdout) as Outcome, root };
}

/** One durable run: a separate `python3` process per segment, outcomes concatenated. */
function runPythonDurable(spec: Spec): { out: Outcome; root: string } {
  const { root, spec: bound } = layout(spec, true);
  const parts = segmentsOf(bound.ticks).map((segment) => {
    const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
      input: JSON.stringify({ root, spec: bound, segment }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    return JSON.parse(stdout) as Outcome;
  });
  return { out: joinSegments(parts), root };
}

/** A `restart` tick starts the next process; the first segment starts at tick 0. */
function segmentsOf(ticks: Tick[]): { ticks: Tick[]; offset: number }[] {
  const segments: { ticks: Tick[]; offset: number }[] = [];
  for (const [index, tick] of ticks.entries()) {
    if (segments.length === 0 || tick.restart) segments.push({ ticks: [], offset: index });
    segments.at(-1)!.ticks.push(tick);
  }
  return segments;
}

/** The effect log and ticks concatenate; the files and removals are the last process's view. */
function joinSegments(parts: Outcome[]): Outcome {
  const last = parts.at(-1)!;
  return {
    log: parts.flatMap((p) => p.log),
    ticks: parts.flatMap((p) => p.ticks),
    files: last.files,
    removed: last.removed,
  };
}

// --- the TypeScript side ----------------------------------------------------

/** The modules under test as vitest sees them: `src/`, in this process. */
const SRC: Mods = {
  PyError,
  FixPrBacklog,
  backfillRepairPresent,
  refreshFixPrBacklog,
  fileFixPrBacklogEffects,
  filePublicationEffects,
  loadQueueDocument,
  fileRepairHarvestReads,
  toPlainJson,
  finalizePublication,
  publicationNewItem,
  publishRepair,
  decideRepairCleanup,
  repairHarvest,
};

async function runTs(spec: Spec): Promise<{ out: Outcome; root: string }> {
  const { root, spec: bound } = layout(spec);
  const out = await runTsModule(SRC, {
    root,
    spec: bound,
    ticks: bound.ticks,
    offset: 0,
    durable: false,
  });
  return { out, root };
}

/**
 * One durable run: a separate `node` process per segment, each running the built
 * `dist/` modules. Nothing but the scratch tree is shared between them.
 */
function runTsDurable(spec: Spec): { out: Outcome; root: string } {
  if (!existsSync(DIST_CHECK)) throw new Error('dist is missing: run pnpm run build');
  const { root, spec: bound } = layout(spec, true);
  const parts = segmentsOf(bound.ticks).map((segment) => {
    const stdout = execFileSync(process.execPath, ['--no-warnings', TS_CHILD], {
      input: JSON.stringify({ root, spec: bound, durable: true, ...segment }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    return JSON.parse(stdout) as Outcome;
  });
  return { out: joinSegments(parts), root };
}

// --- the comparison ---------------------------------------------------------

const norm = (value: unknown, root: string): unknown =>
  JSON.parse(JSON.stringify(value).replaceAll(root, '<ROOT>')) as unknown;

/** Run one scenario on both sides; fail naming the first diverging piece. */
async function parity(spec: Spec, durable = false): Promise<Outcome> {
  const py = durable ? runPythonDurable(spec) : runPython(spec);
  const ts = durable ? runTsDurable(spec) : await runTs(spec);
  const a = norm(py.out, py.root) as Outcome;
  const b = norm(ts.out, ts.root) as Outcome;
  const at = a.log.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(b.log[i]));
  if (at !== -1 || a.log.length !== b.log.length) {
    const i = at === -1 ? Math.min(a.log.length, b.log.length) : at;
    expect({ at: i, py: a.log[i], ts: b.log[i] }).toEqual({ at: i, py: b.log[i], ts: a.log[i] });
  }
  expect(JSON.stringify(b.ticks)).toBe(JSON.stringify(a.ticks));
  expect(JSON.stringify(b.files)).toBe(JSON.stringify(a.files));
  expect(b.removed).toEqual(a.removed);
  return a;
}

// --- fixtures ---------------------------------------------------------------

function record(over: Rec = {}): Rec {
  return {
    state: 'queued',
    base: BASE,
    jobs: [J1],
    branch: 'fix-branch',
    open_pr: false,
    ...over,
  };
}

function item(over: Rec = {}, rec: Rec = {}): Rec {
  return {
    id: ITEM,
    pr: 0,
    kind: 'merged',
    state: 'repairing',
    repair_runs: { R: record(rec) },
    ...over,
  };
}

function fixed(job: string, over: Rec = {}): Rec {
  return {
    job,
    item: ITEM,
    verdict: 'FIXED',
    commits: [SHA1],
    attempts: [{ rung: 'A1' }],
    worktree: `{WT}/${tree(job)}`,
    repair_base: BASE,
    reason: 'fixed',
    ...over,
  };
}

function notFixed(job: string, over: Rec = {}): Rec {
  return {
    job,
    item: ITEM,
    verdict: 'NOT-FIXED',
    reason: 'nothing to change',
    worktree: `{WT}/${tree(job)}`,
    repair_base: BASE,
    ...over,
  };
}

function inbox(job: string, over: Rec = {}): Rec {
  return {
    job,
    item: ITEM,
    finding: { id: `f-${job}` },
    canonical_finding_id: `c-${job}`,
    ...over,
  };
}

/** `state/` files for one job: its result and its inbox row. */
function jobFiles(job: string, result: Rec, over: Rec = {}): Record<string, unknown> {
  return {
    [`repair/${job}/result.json`]: result,
    [`repair/inbox/${job}.json`]: inbox(job, over),
  };
}

const CLEAN = { head: 'h'.repeat(40), status: '' };
const HEAD = CLEAN.head;

function base(over: Partial<Spec> = {}): Spec {
  return {
    item: item(),
    files: jobFiles(J1, fixed(J1)),
    trees: { [tree(J1)]: CLEAN },
    retained: [{ job: J1, head: HEAD, base: BASE }],
    ticks: [{}, {}, { restart: true }],
    ...over,
  };
}

const OPEN_INFO = { state: 'OPEN', headRefName: 'fix-branch', headRefOid: 'target-open' };

function states(o: Outcome): string[] {
  return o.ticks.map(
    (t) => ((t.queue.items as Rec[])[0]!.repair_runs as Record<string, Rec>).R!.state as string,
  );
}

function removals(o: Outcome): string[] {
  return o.log.filter((e) => e[0] === 'wt-remove').map((e) => String(e[1]));
}

function count(o: Outcome, kind: string): number {
  return o.log.filter((e) => e[0] === kind).length;
}

// --- scenarios --------------------------------------------------------------

describe('S6 repair-harvest shadow: harvest -> publish -> finalize -> enroll -> cleanup', () => {
  it('publishes on the first tick, cleans up on the next, and a restart replays nothing', async () => {
    const o = await parity(base());
    expect(states(o)).toEqual(['published', 'published', 'published']);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    expect(count(o, 'event')).toBe(1);
    // The first tick harvests; cleanup only runs in the terminal branch after it.
    expect(removals(o)).toEqual([tree(J1)]);
    expect(o.log.findIndex((e) => e[0] === 'wt-remove')).toBeGreaterThan(
      o.log.findIndex((e) => e[0] === 'tick' && e[1] === 1),
    );
    expect(o.removed).toEqual([tree(J1)]);
  });

  it('a push failure is publish_failed; a restart recovers it from the journal without a second create', async () => {
    const o = await parity(
      base({ ticks: [{ push_fail: true }, { restart: true }, {}, { restart: true }] }),
    );
    expect(states(o)).toEqual(['publish_failed', 'published', 'published', 'published']);
    expect(count(o, 'push')).toBe(2);
    expect(count(o, 'create')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a create that timed out after landing is adopted on the restart, never created twice', async () => {
    const o = await parity(
      base({ ticks: [{ create: 'timeout-landed' }, { restart: true }, {}, { restart: true }] }),
    );
    expect(count(o, 'create')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a create that timed out and was lost is retried by the recovery of a later tick', async () => {
    const o = await parity(
      base({ ticks: [{ create: 'timeout-lost' }, { restart: true }, {}, { restart: true }] }),
    );
    expect(count(o, 'create')).toBeGreaterThanOrEqual(2);
  });

  it('repeated create failures across restarts end stale, and a stale run is still cleaned up', async () => {
    const o = await parity(
      base({
        ticks: [
          { create: 'runtime' },
          { restart: true, create: 'runtime' },
          { restart: true, create: 'runtime' },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(states(o).at(-1)).toBe('stale');
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a NOT-FIXED-only run publishes nothing and is cleaned up on the next tick', async () => {
    const o = await parity(
      base({
        files: jobFiles(J1, notFixed(J1)),
        retained: [{ job: J1, head: HEAD, base: BASE }],
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(states(o)).toEqual(['done', 'done', 'done']);
    expect(count(o, 'push')).toBe(0);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a dirty tree, a missing snapshot or a mismatched head each keep the tree across restarts', async () => {
    const dirty = await parity(
      base({
        trees: { [tree(J1)]: { head: HEAD, status: '?? stray.txt' } },
        ticks: [{}, {}, { restart: true }, { restart: true }],
      }),
    );
    expect(removals(dirty)).toEqual([]);
    expect(dirty.removed).toEqual([]);
    const missing = await parity(base({ retained: [], ticks: [{}, {}, { restart: true }] }));
    expect(removals(missing)).toEqual([]);
    const moved = await parity(
      base({
        retained: [{ job: J1, head: 'z'.repeat(40), base: BASE }],
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(removals(moved)).toEqual([]);
  });

  it('a legacy worktree name passes harvest and is then refused by cleanup (tree kept)', async () => {
    const legacy = `crq-repair-${ITEM}`;
    const o = await parity(
      base({
        files: jobFiles(J1, fixed(J1, { worktree: `{WT}/${legacy}` })),
        trees: { [legacy]: CLEAN },
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(states(o)[0]).toBe('published');
    expect(removals(o)).toEqual([]);
  });

  it('a two-job run cleans the base tree and the -A2 alternate of each verdict once', async () => {
    const o = await parity(
      base({
        item: item({}, { jobs: [J1, J2] }),
        files: {
          ...jobFiles(J1, fixed(J1)),
          ...jobFiles(J2, notFixed(J2, { worktree: `{WT}/${tree(J2, '-A2')}`, repair_base: BASE })),
        },
        trees: {
          [tree(J1)]: CLEAN,
          [tree(J2)]: CLEAN,
          [tree(J2, '-A2')]: CLEAN,
        },
        retained: [
          { job: J1, head: HEAD, base: BASE },
          { job: J2, head: HEAD, base: BASE },
        ],
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(removals(o).sort()).toEqual([tree(J1), tree(J2), tree(J2, '-A2')].sort());
  });

  it('a stale canonical delivery strands nothing: no publish, no cleanup, replay is a no-op', async () => {
    const o = await parity(
      base({
        ticks: [{ stale: { [J1]: 'value:canonical delivery mismatch' } }, { restart: true }, {}],
      }),
    );
    expect(states(o)[0]).toBe('stale');
    expect(count(o, 'push')).toBe(0);
    expect(removals(o)).toEqual([]);
  });

  it('a ledger write that fails late aborts the tick and the restart completes the same run', async () => {
    const o = await parity(
      base({
        ticks: [
          { outcome: { [J1]: 'os:ledger offline' } },
          { restart: true },
          {},
          { restart: true },
        ],
      }),
    );
    expect(o.ticks[0]!.error).toBe('OSError');
    expect(states(o)[0]).toBe('queued');
    expect(states(o)[1]).toBe('published');
    expect(count(o, 'push')).toBe(1);
  });

  it('a defective result becomes a terminal failure whose replay across restarts is compared effect for effect', async () => {
    await parity(
      base({
        files: jobFiles(J1, { job: J1, item: ITEM, verdict: 'BOGUS', reason: 'x' }),
        ticks: [{}, { restart: true }, { restart: true }],
      }),
    );
  });

  it('an open-PR run publishes without creating a PR, and a closed PR goes stale before any push', async () => {
    const open = await parity(
      base({
        item: item({ pr: 5, kind: 'open' }, { open_pr: true }),
        pr_info: OPEN_INFO,
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(count(open, 'create')).toBe(0);
    expect(states(open)[0]).toBe('published');
    const closed = await parity(
      base({
        item: item({ pr: 5, kind: 'open' }, { open_pr: true }),
        pr_info: { ...OPEN_INFO, state: 'MERGED' },
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(states(closed)[0]).toBe('stale');
    expect(count(closed, 'push')).toBe(0);
  });

  it('a failing HEAD read is a recorded cleanup message each tick, and the tree stays', async () => {
    const o = await parity(
      base({
        ticks: [
          {},
          { head_error: 'git rev-parse failed' },
          { restart: true, head_error: 'git rev-parse failed' },
        ],
      }),
    );
    const messages = o.ticks.flatMap((t) => t.messages ?? []);
    expect(messages.some((m) => m.startsWith(`repair cleanup ${J1}:`))).toBe(true);
    expect(removals(o)).toEqual([]);
  });

  it('a dry tick plans the harvest and touches nothing; the live tick then publishes', async () => {
    const o = await parity(base({ ticks: [{ dry: true }, {}, {}, { restart: true }] }));
    expect(o.ticks[0]!.messages).toEqual(['would harvest repair R']);
    expect(states(o)).toEqual(['queued', 'published', 'published', 'published']);
  });
});

// --- durable restarts -------------------------------------------------------

const durable = (spec: Spec): Promise<Outcome> => parity(spec, true);

/** `state/queue.json` as it stood when tick `index` ended (disk, not memory). */
function diskItem(o: Outcome, index: number): Rec {
  return (JSON.parse(o.ticks[index]!.files['queue.json']!) as { items: Rec[] }).items[0]!;
}

/** The run's state in that file. */
function diskState(o: Outcome, index: number): string {
  return (diskItem(o, index).repair_runs as Record<string, Rec>).R!.state as string;
}

const JOURNAL = `repair/${J1}/publication.json`;

describe('S6 repair-harvest shadow: durable restarts reload state/queue.json', () => {
  it('a clean publish across three processes performs each external effect once', async () => {
    const o = await durable(base({ ticks: [{}, { restart: true }, { restart: true }] }));
    expect(states(o)).toEqual(['published', 'published', 'published']);
    for (const kind of ['push', 'create', 'event', 'mark', 'wt-remove']) {
      expect(count(o, kind), kind).toBe(1);
    }
    expect(count(o, 'restart')).toBe(2);
    // What the next process starts from is what the last one persisted.
    expect([0, 1, 2].map((i) => diskState(o, i))).toEqual(['published', 'published', 'published']);
    // Only the first process publishes; the later ones reload a published run
    // and go straight to cleanup, which removes the tree once.
    expect(removals(o)).toEqual([tree(J1)]);
    expect(o.removed).toEqual([tree(J1)]);
    expect(Object.keys(o.files).sort()).toEqual(
      [JOURNAL, `repair/${J1}/publication.patch`, `repair/${J1}/fix-pr.md`, 'queue.json'].sort(),
    );
  });

  it('a dry tick never reaches harvest: no canonical or harvest effect, scratch unchanged, and the next process publishes once', async () => {
    // A `stale` directive would raise if harvest ran, so any error here means it was called.
    const o = await durable(
      base({
        ticks: [{ dry: true, stale: { [J1]: 'value:x' } }, { restart: true }, { restart: true }],
      }),
    );
    const next = o.log.findIndex((e) => e[0] === 'tick' && e[1] === 1);
    // The dry tick's whole effect log is its own bookkeeping: no canonical, mark, push or save.
    expect(o.log.slice(0, next).map((e) => e[0])).toEqual(['tick', 'backlog']);
    expect(o.ticks[0]).not.toHaveProperty('messages');
    expect(o.ticks[0]).not.toHaveProperty('error');
    // Scratch is as seeded: queue.json is the fixture and nothing else was written.
    expect(Object.keys(o.ticks[0]!.files)).toEqual(['queue.json']);
    expect(JSON.parse(o.ticks[0]!.files['queue.json']!)).toEqual(o.ticks[0]!.queue);
    expect(diskItem(o, 0)).not.toHaveProperty('last_error');
    // Only the two live ticks save at tick end, and the run then publishes once.
    expect(count(o, 'tick-save')).toBe(2);
    expect(diskState(o, 0)).toBe('queued');
    expect(states(o)).toEqual(['queued', 'published', 'published']);
    expect(count(o, 'canonical')).toBe(1);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a crash before the first queue save leaves queue.json untouched and the next process starts over', async () => {
    const o = await durable(
      base({
        ticks: [
          { save_fail: 1, crash: true },
          { restart: true },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(states(o)[0]).toBe('publish_failed');
    // In memory the run failed; on disk it never left its seeded state.
    expect(diskState(o, 0)).toBe('queued');
    expect(states(o).slice(1)).toEqual(['published', 'published', 'published']);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    // The ledger write is not suppressed: the second process re-harvests the run.
    expect(count(o, 'mark')).toBe(2);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a push that landed before the queue save was lost is adopted from the remote, never pushed twice', async () => {
    const o = await durable(
      base({
        ticks: [
          { save_fail: 2, crash: true },
          { restart: true },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    // The first save (`ready`) landed; the one after the push did not.
    expect(diskState(o, 0)).toBe('ready');
    expect(JOURNAL in o.ticks[0]!.files).toBe(true);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'ls-remote')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    expect(states(o).at(-1)).toBe('published');
  });

  it('a create that landed before the final queue save was lost is adopted; only the enrolment event repeats', async () => {
    const o = await durable(
      base({
        ticks: [
          { save_fail: 3, crash: true },
          { restart: true },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(diskState(o, 0)).toBe('ready');
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    // The PR is adopted by the second process, which enrols it again: Python's
    // `enrolled` event is a log line, not a deduplicated effect.
    expect(count(o, 'event')).toBe(2);
    expect(states(o).at(-1)).toBe('published');
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a ledger write that fails late is caught into last_error and saved; the next process completes the run once', async () => {
    const o = await durable(
      base({
        ticks: [{ outcome: { [J1]: 'os:ledger offline' } }, { restart: true }, { restart: true }],
      }),
    );
    expect(o.ticks[0]!.error).toBe('OSError');
    expect(diskState(o, 0)).toBe('queued');
    expect(diskItem(o, 0).last_error).toBe('repair harvest failed: ledger offline');
    expect(states(o).slice(1)).toEqual(['published', 'published']);
    expect(count(o, 'mark')).toBe(2);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
  });

  it('a create that timed out after landing is adopted by a later process, never created twice', async () => {
    const o = await durable(
      base({
        ticks: [
          { create: 'timeout-landed' },
          { restart: true },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(count(o, 'create')).toBe(1);
    expect(states(o).at(-1)).toBe('published');
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('repeated create failures across processes end stale, and the persisted counter survives each reload', async () => {
    const o = await durable(
      base({
        ticks: [
          { create: 'runtime' },
          { restart: true, create: 'runtime' },
          { restart: true, create: 'runtime' },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(states(o).at(-1)).toBe('stale');
    expect(diskState(o, 4)).toBe('stale');
    expect(count(o, 'push')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('the queue on disk is authoritative: an operator edit between processes beats the last in-memory state', async () => {
    const edited = { items: [item({}, { state: 'done' })] };
    const o = await durable(
      base({
        ticks: [
          { save_fail: 1, crash: true },
          { restart: true, files: { 'queue.json': edited } },
          { restart: true },
        ],
      }),
    );
    // Without the edit the second process would harvest and publish the queued run.
    expect(diskState(o, 0)).toBe('queued');
    expect(diskState(o, 1)).toBe('done');
    expect(count(o, 'push')).toBe(0);
    expect(count(o, 'create')).toBe(0);
  });

  it('a failed queue save is survivable: the tick persists publish_failed and the next process recovers from the journal', async () => {
    const o = await durable(
      base({ ticks: [{ save_fail: 1 }, { restart: true }, { restart: true }, { restart: true }] }),
    );
    expect(diskState(o, 0)).toBe('publish_failed');
    expect(JOURNAL in o.ticks[0]!.files).toBe(true);
    expect(states(o).slice(1)).toEqual(['published', 'published', 'published']);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a NOT-FIXED-only run is done on disk after one process and never publishes', async () => {
    const o = await durable(
      base({
        files: jobFiles(J1, notFixed(J1)),
        ticks: [{}, { restart: true }, { restart: true }],
      }),
    );
    expect(states(o)).toEqual(['done', 'done', 'done']);
    expect([0, 1, 2].map((i) => diskState(o, i))).toEqual(['done', 'done', 'done']);
    expect(count(o, 'push')).toBe(0);
    expect(count(o, 'mark')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });
});

// --- backfill backlog hold and release --------------------------------------

const BF = 'backfill-finding-a';
const bfTree = `crq-repair-${BF}-${J1}`;

/** `n` `review_started` events an hour ago: the limit is `n * 4 // 72`. */
const startsText = (n: number): string => {
  const at = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    Array.from({ length: n }, () => JSON.stringify({ at, event: 'review_started' })).join('\n') +
    '\n'
  );
};

/** One FIXED backfill run, a retained snapshot and a clean tree, with a limit of 2. */
function backfill(ticks: Tick[]): Spec {
  return base({
    item: item({ id: BF }),
    files: {
      ...jobFiles(J1, fixed(J1, { item: BF, worktree: `{WT}/${bfTree}` }), { item: BF }),
      'events.jsonl': startsText(36),
    },
    trees: { [bfTree]: CLEAN },
    ticks,
  });
}

const BACKLOG_FILE = 'repair/fix-pr-backlog.json';
const refreshes = (o: Outcome): unknown[] =>
  o.log.filter((e) => e[0] === 'refresh').map((e) => e[1]);

describe('S6 repair-harvest shadow: a backfill fix PR held by the shared backlog, then released', () => {
  it('holds on an unread view and on a full backlog, publishes once a slot frees, and re-reads each tick', async () => {
    const spec = backfill([
      // The listing fails: the view stays unread, so the run is pushed and journaled but held.
      { gh_open: 'fail', external: ['crq/fix-backfill-x1', 'crq/fix-backfill-x2'] },
      // Read again, but the two external backfill PRs fill the limit of 2: still held.
      { restart: true, external: ['crq/fix-backfill-x1', 'crq/fix-backfill-x2'] },
      // One of them closed: the freed slot is reserved, the PR created and the run enrolled.
      { restart: true, external: ['crq/fix-backfill-x2'] },
      // Our own open PR now counts toward the next view; cleanup takes the tree.
      { restart: true, external: ['crq/fix-backfill-x2'] },
    ]);
    for (const o of [await parity(spec), await durable(spec)]) {
      expect(refreshes(o)).toEqual([
        null,
        { open: 2, limit: 2 },
        { open: 1, limit: 2 },
        { open: 2, limit: 2 },
      ]);
      expect(states(o)).toEqual(['ready', 'ready', 'published', 'published']);
      // Pushed and journaled on the first tick, then only recovered: one push, one create.
      expect(count(o, 'push')).toBe(1);
      expect(count(o, 'create')).toBe(1);
      expect(count(o, 'event')).toBe(1);
      const created = o.log.findIndex((e) => e[0] === 'create');
      expect(o.log.findIndex((e) => e[0] === 'tick' && e[1] === 2)).toBeLessThan(created);
      expect(created).toBeLessThan(o.log.findIndex((e) => e[0] === 'tick' && e[1] === 3));
      // The reserved slot is visible at the end of the creating tick, then re-counted from the forge.
      expect(o.log.filter((e) => e[0] === 'backlog').map((e) => e[1])).toEqual([
        { open: null, limit: null },
        { open: 2, limit: 2 },
        { open: 2, limit: 2 },
        { open: 2, limit: 2 },
      ]);
      // The view file is not written by the failed read and follows the listing afterwards.
      expect(BACKLOG_FILE in o.ticks[0]!.files).toBe(false);
      expect([1, 2, 3].map((i) => JSON.parse(o.ticks[i]!.files[BACKLOG_FILE]!) as unknown)).toEqual(
        [
          { open: 2, limit: 2 },
          { open: 1, limit: 2 },
          { open: 2, limit: 2 },
        ],
      );
      expect(removals(o)).toEqual([bfTree]);
    }
  });
});

// --- a rejected (swapped) inbox across durable reloads -----------------------

/** One two-job run whose second job's inbox row names another job, then is rewritten. */
function swappedInbox(): Spec {
  return base({
    item: item({}, { jobs: [J1, J2] }),
    files: {
      ...jobFiles(J1, notFixed(J1)),
      ...jobFiles(J2, notFixed(J2), { job: 'crq-other', canonical_finding_id: 'FSWAP' }),
    },
    trees: { [tree(J1)]: CLEAN, [tree(J2)]: CLEAN },
    retained: [
      { job: J1, head: HEAD, base: BASE },
      { job: J2, head: HEAD, base: BASE },
    ],
    ticks: [
      {},
      { restart: true },
      // The inbox row is corrected on disk before the third process starts.
      { restart: true, files: { [`repair/inbox/${J2}.json`]: inbox(J2) } },
      { restart: true },
    ],
  });
}

/** The ordered effects that matter here, one short string each. */
function trail(o: Outcome): string[] {
  const keep = new Set(['tick', 'restart', 'canonical', 'mark', 'save', 'tick-save', 'wt-remove']);
  return o.log.flatMap((e) => {
    if (e[0] === 'cleanup') return [`cleanup:${String(e[2])}:${e[3] === true ? 'alt' : 'base'}`];
    if (!keep.has(String(e[0]))) return [];
    return [e.length > 1 && e[0] !== 'save' ? `${String(e[0])}:${String(e[1])}` : String(e[0])];
  });
}

const markPayloads = (o: Outcome): string[] =>
  o.log.filter((e) => e[0] === 'mark').map((e) => String(e[2]));

describe('S6 repair-harvest shadow: a rejected inbox replayed across durable reloads', () => {
  // Python and the port are NOT the same here, deliberately (#2313): Python trusts an inbox
  // row whose job id is foreign and finishes the run; the port refuses it as an invalid inbox.
  // This fixture records what each side actually does over one run of four real processes. It
  // settles nothing about a late finding write: a corrected inbox arrives, and neither side
  // reads it again.
  it('records each side separately: Python finishes the run on the foreign row, the port fails it, across reloads', () => {
    const spec = swappedInbox();
    const py = runPythonDurable(spec);
    const ts = runTsDurable(spec);
    const a = norm(py.out, py.root) as Outcome;
    const b = norm(ts.out, ts.root) as Outcome;

    // Python: tick 0 writes J1's outcome, then J2's result under the FOREIGN job id.
    expect(trail(a)).toEqual([
      'tick:0',
      'canonical:crq-R-F1',
      'mark:crq-R-F1',
      'canonical:crq-other',
      'mark:crq-other',
      'tick-save',
      'tick:1',
      'restart',
      'cleanup:crq-R-F1:base',
      'wt-remove:crq-repair-pr7-crq-R-F1',
      'cleanup:crq-R-F1:alt',
      'cleanup:crq-R-F2:base',
      'wt-remove:crq-repair-pr7-crq-R-F2',
      'cleanup:crq-R-F2:alt',
      'tick-save',
      'tick:2',
      'restart',
      'cleanup:crq-R-F1:base',
      'cleanup:crq-R-F1:alt',
      'cleanup:crq-R-F2:base',
      'cleanup:crq-R-F2:alt',
      'tick-save',
      'tick:3',
      'restart',
      'cleanup:crq-R-F1:base',
      'cleanup:crq-R-F1:alt',
      'cleanup:crq-R-F2:base',
      'cleanup:crq-R-F2:alt',
      'tick-save',
    ]);

    // The port: tick 0 writes J1, persists the terminal failure, then replays J1's outcome once.
    // Every later process replays J1 once more (its only effect), cleans J1, and never J2.
    expect(trail(b)).toEqual([
      'tick:0',
      'canonical:crq-R-F1',
      'mark:crq-R-F1',
      'save',
      'mark:crq-R-F1',
      'tick-save',
      'tick:1',
      'restart',
      'mark:crq-R-F1',
      'cleanup:crq-R-F1:base',
      'wt-remove:crq-repair-pr7-crq-R-F1',
      'cleanup:crq-R-F1:alt',
      'cleanup:crq-R-F2:base',
      'cleanup:crq-R-F2:alt',
      'tick-save',
      'tick:2',
      'restart',
      'mark:crq-R-F1',
      'cleanup:crq-R-F1:base',
      'cleanup:crq-R-F1:alt',
      'cleanup:crq-R-F2:base',
      'cleanup:crq-R-F2:alt',
      'tick-save',
      'tick:3',
      'restart',
      'mark:crq-R-F1',
      'cleanup:crq-R-F1:base',
      'cleanup:crq-R-F1:alt',
      'cleanup:crq-R-F2:base',
      'cleanup:crq-R-F2:alt',
      'tick-save',
    ]);

    // J1's outcome payload is the same on both sides, and the port repeats it byte for byte.
    const pyMarks = markPayloads(a);
    const tsMarks = markPayloads(b);
    expect(tsMarks).toHaveLength(5);
    expect(new Set(tsMarks).size).toBe(1);
    expect(tsMarks[0]).toBe(pyMarks[0]);
    // Python's second write is J2's own result, filed under the foreign id; the port has none.
    expect(JSON.parse(pyMarks[1]!)).toMatchObject({ job: J2, verdict: 'NOT-FIXED' });
    expect(pyMarks).toHaveLength(2);

    // The queue on disk after each process: Python is done, the port is terminally failed,
    // and a reload (and the corrected inbox) changes neither.
    expect(a.ticks.map((t) => runOf(t.files['queue.json']!).state)).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(b.ticks.map((t) => runOf(t.files['queue.json']!).state)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
    ]);
    for (const o of [a, b]) {
      expect(new Set(o.ticks.map((t) => t.files['queue.json'])).size).toBe(1);
    }
    expect(runOf(b.ticks[0]!.files['queue.json']!)).toMatchObject({
      error: 'repair job identity mismatch',
      verdicts: [
        { job: J1, verdict: 'NOT-FIXED' },
        {
          job: J2,
          verdict: 'FAILED',
          reason: 'invalid repair inbox: repair job identity mismatch',
        },
      ],
    });
    expect(
      (runOf(a.ticks[0]!.files['queue.json']!).verdicts as Rec[]).map((v) => v.verdict),
    ).toEqual(['NOT-FIXED', 'NOT-FIXED']);

    // Trees: Python's cleanup takes both; the port's refuses the rejected job's, every process.
    expect(removals(a)).toEqual([tree(J1), tree(J2)]);
    expect(a.removed).toEqual([tree(J1), tree(J2)]);
    expect(removals(b)).toEqual([tree(J1)]);
    expect(b.removed).toEqual([tree(J1)]);

    // Nothing external was done on either side: no push, no PR, no enrolment, no sibling decision,
    // and the corrected inbox never reaches a canonical check or a finding write.
    for (const o of [a, b]) {
      for (const kind of ['push', 'create', 'event', 'sibling'])
        expect(count(o, kind), kind).toBe(0);
    }
    expect(a.log.filter((e) => e[0] === 'canonical').map((e) => e[1])).toEqual([
      'crq-R-F1',
      'crq-other',
    ]);
    expect(b.log.filter((e) => e[0] === 'canonical').map((e) => e[1])).toEqual(['crq-R-F1']);
  });
});

/** The single run `R` of the first queue item in a `queue.json` text. */
function runOf(text: string): Rec {
  const doc = JSON.parse(text) as { items: Rec[] };
  return (doc.items[0]!.repair_runs as Record<string, Rec>).R!;
}
