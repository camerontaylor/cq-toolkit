import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileRepairBackfillEffects } from '../../src/adapters/crq/repairBackfillSource.js';
import { JsonNumber } from '../../src/policy/crq/jsonValue.js';
import {
  pyEq,
  repairArchiveLegacy,
  repairBackfill,
  repairEnqueue,
  truthy,
  type Queue,
  type RepairBackfillEffects,
  type SourcedFinding,
} from '../../src/queue-runner/repairBackfill.js';

const PYTHON_DIR = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const ISO = '2026-11-20T00:00:00Z';
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Spec {
  readonly mode: 'enqueue' | 'backfill' | 'archive';
  readonly queue: { items: Array<Record<string, unknown>> } & Record<string, unknown>;
  /** Index of the item `enqueue` runs for. */
  readonly itemIndex?: number;
  readonly meta?: Record<string, unknown>;
  /** Files under the state root (`repair/inbox/x.json`, `receipts/y.json`). */
  readonly state?: Record<string, unknown>;
  /** `runs/<run>/meta.json` (object) and `review` (any text) per run. */
  readonly runs?: Record<string, { meta?: unknown; review?: string }>;
  readonly ledger?: string[];
  /** `c.git(*args)` answers keyed by `args.join(' ')`; anything else raises. */
  readonly git?: Record<string, string>;
  /** `findings()` rows per run (a list of `{finding, source}`). */
  readonly findings?: Record<string, SourcedFinding[]>;
  readonly mergedCurrent?: boolean;
  readonly maxRounds?: number;
}

const PY = `
import sys, json, pathlib
sys.path.insert(0, sys.argv[1])
import repair_tick
root = pathlib.Path(sys.argv[2])
spec = json.loads(sys.argv[3])
class C: pass
c = C()
c.REPO = 'o/r'; c.STATE = root / 'state'; c.RUNS = root / 'runs'; c.LEDGER = root / 'ledger'
c.CONFIG = {'repair': {'merged_current': {'enabled': bool(spec.get('mergedCurrent'))}}}
if 'maxRounds' in spec: c.CONFIG['repair']['max_rounds_per_pin'] = spec['maxRounds']
c.item_repo = lambda item: item.get('repo') or c.REPO
c.iso = lambda: ${JSON.stringify(ISO)}
def git(*args):
    return spec['git'][' '.join(args)]
c.git = git
def fake_findings(path, *, provenance=False):
    run = pathlib.Path(path).parent.relative_to(c.RUNS).as_posix()
    out = []
    for row in spec.get('findings', {}).get(run, []):
        f = dict(row['finding'])
        if provenance: f['_source'] = dict(row['source'])
        out.append(f)
    return out
repair_tick.findings = fake_findings
q = spec['queue']
result = {}
try:
    if spec['mode'] == 'enqueue':
        result['ret'] = repair_tick.enqueue(c, q, q['items'][spec['itemIndex']], spec['meta'], root / 'runs' / spec['meta'].get('run_id', 'x'))
    elif spec['mode'] == 'backfill':
        repair_tick.backfill(c, q)
    else:
        repair_tick.archive_legacy(c, q)
except Exception as e:
    result['error'] = True
result['queue'] = q
print(json.dumps(result))
`;

function layout(root: string, spec: Spec): void {
  for (const [rel, doc] of Object.entries(spec.state ?? {})) {
    const path = join(root, 'state', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc));
  }
  for (const [run, files] of Object.entries(spec.runs ?? {})) {
    const dir = join(root, 'runs', run);
    mkdirSync(dir, { recursive: true });
    if (files.meta !== undefined) writeFileSync(join(dir, 'meta.json'), JSON.stringify(files.meta));
    if (files.review !== undefined) writeFileSync(join(dir, 'review.ndjson'), files.review);
  }
  mkdirSync(join(root, 'ledger'), { recursive: true });
  for (const name of spec.ledger ?? []) writeFileSync(join(root, 'ledger', name), name);
}

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

interface Outcome {
  readonly ret?: boolean | undefined;
  readonly error: boolean;
  readonly queue: string;
  readonly files: Record<string, string>;
}

function runPython(spec: Spec): Outcome {
  const root = mkdtempSync(join(tmpdir(), 'repair-bf-py-'));
  dirs.push(root);
  layout(root, spec);
  const out = JSON.parse(
    execFileSync('python3', ['-I', '-c', PY, PYTHON_DIR, root, JSON.stringify(spec)], {
      encoding: 'utf8',
    }),
  ) as { ret?: boolean; error?: boolean; queue: unknown };
  return {
    ret: out.ret,
    error: out.error === true,
    queue: JSON.stringify(out.queue),
    files: tree(root),
  };
}

async function runTs(spec: Spec): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'repair-bf-ts-'));
  dirs.push(root);
  layout(root, spec);
  const q = JSON.parse(JSON.stringify(spec.queue)) as Queue;
  const fx = fileRepairBackfillEffects({
    stateRoot: join(root, 'state'),
    runsRoot: join(root, 'runs'),
    ledgerRoot: join(root, 'ledger'),
    primaryRepo: 'o/r',
    defaultRef: 'origin/main',
    mergedCurrentEnabled: spec.mergedCurrent === true,
    maxRoundsPerPin: spec.maxRounds ?? 2,
    iso: () => ISO,
    async git(...args) {
      const key = args.join(' ');
      if (!Object.hasOwn(spec.git ?? {}, key)) throw new Error(`unexpected git ${key}`);
      return (spec.git as Record<string, string>)[key] as string;
    },
    async findings(run) {
      return JSON.parse(JSON.stringify(spec.findings?.[run] ?? [])) as SourcedFinding[];
    },
  });
  let ret: boolean | undefined;
  let error = false;
  try {
    if (spec.mode === 'enqueue') {
      ret = await repairEnqueue(
        q,
        q.items[spec.itemIndex as number] as Record<string, unknown>,
        JSON.parse(JSON.stringify(spec.meta)),
        fx,
      );
    } else if (spec.mode === 'backfill') {
      await repairBackfill(q, fx);
    } else {
      await repairArchiveLegacy(q, fx);
    }
  } catch {
    error = true;
  }
  return { ret, error, queue: JSON.stringify(q), files: tree(root) };
}

async function same(spec: Spec): Promise<Outcome> {
  const py = runPython(spec);
  const ts = await runTs(spec);
  expect(ts.error).toBe(py.error);
  expect(ts.ret).toBe(py.ret);
  expect(JSON.parse(ts.queue)).toEqual(JSON.parse(py.queue));
  expect(ts.queue).toBe(py.queue);
  // Same artifact files with the same bytes (inbox jobs, archived ledger).
  expect(ts.files).toEqual(py.files);
  return py;
}

const F1 = { severity: 'major', path: 'a.ts', line: 3, body: 'fix a' };
const F2 = { severity: 'critical', path: 'b.ts', line: null, body: 'fix b' };
const rows = (...f: Array<Record<string, unknown>>): SourcedFinding[] =>
  f.map((finding, n) => ({ finding, source: { id: `x${n + 1}`, finding_number: n + 1 } }));
const META = { run_id: 'r1', base: 'b0', head: 'h0', pr_branch: 'feat/x', cycle: 4 };
const openItem = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pr-5',
  kind: 'open',
  pr: 5,
  cycles: [{ run_id: 'r1', findings: 2 }],
  ...extra,
});
const GIT = {
  'rev-list b0..h0': '',
  'diff b0 h0': 'DIFF',
  'rev-parse origin/main': 'tip0',
};

describe('repairEnqueue vs the real repair_tick.enqueue', () => {
  const enqueue = (over: Partial<Spec> = {}): Spec => ({
    mode: 'enqueue',
    queue: { items: [openItem()] },
    itemIndex: 0,
    meta: META,
    git: GIT,
    findings: { r1: rows(F1, F2) },
    ...over,
  });

  it('queues an open-PR repair record and one inbox job per finding', async () => {
    const out = await same(enqueue());
    expect(out.ret).toBe(true);
    expect(Object.keys(out.files)).toEqual([
      'state/repair/inbox/crq-r1-F1.json',
      'state/repair/inbox/crq-r1-F2.json',
    ]);
  });

  it('uses the default-branch tip as base for a non-PR item', async () => {
    await same(enqueue({ queue: { items: [openItem({ kind: 'main' })] } }));
  });

  it('uses meta.pr_head over head for an open PR', async () => {
    await same(
      enqueue({
        meta: { ...META, pr_head: 'p0' },
        git: { ...GIT, 'rev-list b0..p0': '' },
      }),
    );
  });

  it('adopts the base of a stale inbox job for the same finding', async () => {
    await same(
      enqueue({
        queue: { items: [openItem({ kind: 'main' })] },
        state: {
          'repair/inbox/crq-r1-F1.json': {
            job: 'crq-r1-F1',
            finding: F1,
            repair_base: 'old-tip',
            source: { id: 'kept' },
          },
        },
      }),
    );
  });

  it('rebinds an orphaned job with a different base that never ran, keeps one that ran', async () => {
    const stale = { job: 'crq-r1-F1', finding: F1, repair_base: 'old', source: { id: 's' } };
    await same(enqueue({ state: { 'repair/inbox/crq-r1-F1.json': stale } }));
    await same(
      enqueue({
        state: {
          'repair/inbox/crq-r1-F1.json': stale,
          'repair/crq-r1-F1/result.json': { verdict: 'FIXED' },
        },
      }),
    );
  });

  it('raises on a present inbox file that is not a JSON object (as Python does)', async () => {
    await same(enqueue({ state: { 'repair/inbox/crq-r1-F1.json': null } })); // JSON null
    await same(enqueue({ state: { 'repair/inbox/crq-r1-F1.json': [1] } })); // an array
    await same(enqueue({ state: { 'repair/inbox/crq-r1-F1.json': 'nul' } })); // malformed text
  });

  it('backfills a missing source onto an existing job without a second record', async () => {
    const existing = { jobs: ['crq-r1-F1', 'crq-r1-F2'], state: 'ready', pin: 'b0' };
    await same(
      enqueue({
        queue: { items: [openItem({ repair_runs: { r1: existing } })] },
        state: {
          'repair/inbox/crq-r1-F1.json': { job: 'crq-r1-F1', finding: F1 },
          'repair/inbox/crq-r1-F2.json': { job: 'crq-r1-F2', finding: F2, source: { id: 'has' } },
        },
      }),
    );
  });

  it('an existing record reports whether it is still drainable', async () => {
    for (const state of ['queued', 'ready', 'publish_failed', 'published', 'done', 'failed']) {
      await same(
        enqueue({
          queue: { items: [openItem({ repair_runs: { r1: { jobs: [], state } } })] },
        }),
      );
    }
  });

  it('refuses local-review items, metas and cycles; foreign repos; no findings', async () => {
    await same(enqueue({ queue: { items: [openItem({ kind: 'local-review' })] } }));
    await same(enqueue({ meta: { ...META, kind: 'local-review' } }));
    await same(
      enqueue({
        queue: { items: [openItem({ cycles: [{ source: 'local-review', run_id: 'r1' }] })] },
      }),
    );
    await same(enqueue({ queue: { items: [openItem({ repo: 'O/OTHER' })] } }));
    await same(enqueue({ findings: { r1: [] } }));
    // a same-repo item written in a different case still counts as primary
    await same(enqueue({ queue: { items: [openItem({ repo: 'O/R' })] } }));
  });

  it('refuses an own-range review and stops at the per-pin round ceiling', async () => {
    await same(
      enqueue({
        queue: { items: [openItem()], repair_own_commits: ['c1', 'c2'] },
        git: { ...GIT, 'rev-list b0..h0': 'c1\nc2' },
      }),
    );
    await same(
      enqueue({
        queue: { items: [openItem()], repair_own_commits: ['c1'] },
        git: { ...GIT, 'rev-list b0..h0': 'c1\nc2' },
      }),
    );
    const done = (run: string): Record<string, unknown> => ({
      jobs: [],
      state: 'done',
      pin: 'b0',
      run,
    });
    const out = await same(
      enqueue({
        queue: {
          items: [
            openItem({ repair_runs: { z1: done('z1'), z2: done('z2') }, id: 'pr-5-delta' }),
            openItem(),
          ],
        },
        itemIndex: 1,
      }),
    );
    expect(out.ret).toBe(false);
    expect(out.queue).toContain('repair round ceiling reached; needs human');
    await same(
      enqueue({
        maxRounds: 3,
        queue: {
          items: [openItem({ repair_runs: { z1: done('z1'), z2: done('z2') } }), openItem()],
        },
        itemIndex: 1,
      }),
    );
  });

  it('notes a recurrence from an earlier NOT-FIXED verdict and ties blockers to jobs', async () => {
    const verdict = (path: string, severity: string, verdict: string) => ({
      verdict,
      finding: { path, severity },
    });
    await same(
      enqueue({
        queue: {
          items: [
            openItem({
              blocking: [
                { run: 'r1', run_finding: 2 },
                { run: 'other', run_finding: 1 },
              ],
              repair_runs: {
                old: {
                  jobs: [],
                  state: 'done',
                  pin: 'zzz',
                  verdicts: [
                    verdict('a.ts', 'major', 'NOT-FIXED'),
                    verdict('a.ts', 'major', 'FIXED'),
                    verdict('b.ts', 'minor', 'NOT-FIXED'),
                  ],
                },
              },
            }),
          ],
        },
      }),
    );
  });

  it('prefers review_pin, then pinned_base, then meta.base for the pin', async () => {
    await same(enqueue({ meta: { ...META, review_pin: 'pinA' } }));
    await same(enqueue({ queue: { items: [openItem({ pinned_base: 'pinB' })] } }));
  });

  it('refuses a run id outside the job-id grammar without queueing', async () => {
    const out = await same(
      enqueue({
        meta: { ...META, run_id: 'bad/run' },
        findings: { 'bad/run': rows(F1) },
        runs: {},
      }),
    );
    expect(out.ret).toBe(false);
  });

  it('merged-current receipts: gated, scoped to critical/major, digests recorded', async () => {
    const receipt = {
      kind: 'merged-current',
      id: 'pr-9',
      pr: 9,
      receipt_id: 'rc1',
      capture: { target: 'tgt' },
      cycles: [{ run_id: 'r1', findings: 1 }],
    };
    const doc = { outcome: 'terminal-with-findings', findings: [F2, F1] };
    const base = {
      queue: { items: [receipt] },
      state: { 'receipts/rc1.json': doc },
      mergedCurrent: true,
    };
    const out = await same(enqueue({ ...base, meta: { run_id: 'r1', base: 'b0', head: 'h0' } }));
    expect(out.ret).toBe(true);
    await same(enqueue({ ...base, mergedCurrent: false }));
    await same(
      enqueue({
        ...base,
        state: { 'receipts/rc1.json': { ...doc, findings: [F1, { ...F1, severity: 'minor' }] } },
      }),
    );
    await same(
      enqueue({ ...base, state: { 'receipts/rc1.json': { ...doc, outcome: 'terminal-clean' } } }),
    );
    await same(enqueue({ ...base, state: { 'receipts/rc1.json': { ...doc, findings: [] } } }));
    // an unreadable receipt raises
    await same(enqueue({ ...base, state: {} }));
  });

  // crq review (F3) supersedes the older parity pin: a completed slot belonging
  // to a different finding must not be reused for this finding, so the port now
  // deliberately deviates from Python (repair_tick still binds the blocker) and
  // pins its own behavior on the TS side.
  it('preserves a completed inbox job for another finding without reusing it or its blocker', async () => {
    const out = await runTs(
      enqueue({
        queue: { items: [openItem({ blocking: [{ run: 'r1', run_finding: 1 }] })] },
        findings: { r1: rows(F2) }, // finding B now occupies slot 1
        state: {
          'repair/inbox/crq-r1-F1.json': { job: 'crq-r1-F1', finding: F1, repair_base: 'b0' },
          'repair/crq-r1-F1/result.json': { verdict: 'FIXED' },
        },
      }),
    );
    expect(out.error).toBe(false);
    expect(out.ret).toBe(true);
    expect(out.files['state/repair/inbox/crq-r1-F1.json']).toContain('fix a'); // still finding A
    expect(out.queue).not.toContain('"repair_job"'); // never bound to another finding's job
    expect(out.queue).toContain('"jobs":[]'); // the run claims no job it does not own
  });

  // crq review (F4, F10) flagged the next one as a defect. Python behaves exactly
  // this way, and the port is differential against it, so it is pinned as parity.
  it('counts a foreign repository PR with the same number toward the round ceiling (as Python does)', async () => {
    const done = (run: string): Record<string, unknown> => ({
      jobs: [],
      state: 'done',
      pin: 'b0',
      run,
    });
    const out = await same(
      enqueue({
        queue: {
          items: [
            openItem({ repo: 'other/x', repair_runs: { z1: done('z1'), z2: done('z2') } }),
            openItem(),
          ],
        },
        itemIndex: 1,
      }),
    );
    expect(out.ret).toBe(false);
    expect(out.queue).toContain('repair round ceiling reached; needs human');
  });

  it('raises where Python raises on a record it cannot read', async () => {
    await same(enqueue({ meta: { base: 'b0', head: 'h0' } })); // no run_id
    await same(enqueue({ git: {} })); // rev-list unavailable
    await same(enqueue({ queue: { items: [{ id: 'x', cycles: [] }] } })); // no kind
    await same(enqueue({ queue: { items: [{ ...openItem(), pr: undefined }] } })); // no pr
  });
});

describe('repairBackfill vs the real repair_tick.backfill', () => {
  const evidence = (extra: Record<string, unknown> = {}) => ({
    meta: { ...META, ...extra },
    review: 'x',
  });
  const backfill = (over: Partial<Spec> = {}): Spec => ({
    mode: 'backfill',
    queue: { items: [openItem()] },
    git: GIT,
    findings: { r1: rows(F1) },
    runs: { r1: evidence() },
    ...over,
  });

  it('is a no-op once backfilled', async () => {
    await same(backfill({ queue: { items: [openItem()], legacy_repair_backfilled: 'T' } }));
  });

  it('enqueues the cycle and stamps legacy_repair_backfilled when nothing is missing', async () => {
    const out = await same(backfill());
    expect(out.queue).toContain('legacy_repair_backfilled');
  });

  it('records a cycle with no repair verdict and does not stamp', async () => {
    const out = await same(
      backfill({
        queue: { items: [openItem({ last_error: 'round ceiling' })], repair_own_commits: [] },
        maxRounds: 0,
      }),
    );
    expect(out.queue).toContain('round ceiling');
    expect(out.queue).not.toContain('legacy_repair_backfilled');
    await same(backfill({ maxRounds: 0 })); // falls back to 'no repair verdict'
  });

  it('forgives an own-range review and a review with no findings', async () => {
    await same(
      backfill({
        maxRounds: 0,
        queue: { items: [openItem()], repair_own_commits: ['c1'] },
        git: { ...GIT, 'rev-list b0..h0': 'c1' },
      }),
    );
    await same(backfill({ findings: { r1: [] } }));
  });

  it('missing evidence is debt only for findings, severity counts, blocking or signer runs', async () => {
    const cycles = (c: Record<string, unknown>) => ({
      items: [openItem({ cycles: [{ run_id: 'gone', ...c }] })],
    });
    await same(backfill({ queue: cycles({}), runs: {} }));
    await same(backfill({ queue: cycles({ findings: 2 }), runs: {} }));
    await same(backfill({ queue: cycles({ severity_counts: { major: 1 } }), runs: {} }));
    await same(backfill({ queue: cycles({ severity_counts: {} }), runs: {} }));
    await same(
      backfill({
        queue: { items: [{ ...openItem({ cycles: [{ run_id: 'gone' }] }), blocking: [{}] }] },
        runs: {},
      }),
    );
    await same(
      backfill({ queue: { items: [openItem({ cycles: [{ run_id: 'signer:abc' }] })] }, runs: {} }),
    );
    // only one of the two evidence files present
    await same(backfill({ queue: cycles({ findings: 1 }), runs: { gone: { meta: META } } }));
    await same(backfill({ queue: cycles({ findings: 1 }), runs: { gone: { review: 'x' } } }));
  });

  it('skips local-review cycles, local-review metas and foreign repos', async () => {
    await same(
      backfill({
        queue: {
          items: [
            openItem({ cycles: [{ run_id: 'r1', source: 'local-review', findings: 3 }] }),
            openItem({ id: 'f', repo: 'x/y', cycles: [{ run_id: 'nope', findings: 3 }] }),
          ],
        },
      }),
    );
    await same(backfill({ runs: { r1: evidence({ kind: 'local-review' }) } }));
  });

  it('walks several items and cycles and keeps queued runs out of the missing list', async () => {
    await same(
      backfill({
        queue: {
          items: [
            openItem({ cycles: [{ run_id: 'r1' }, { run_id: 'r2', findings: 1 }] }),
            openItem({ id: 'pr-6', pr: 6, cycles: [{ run_id: 'r3' }] }),
          ],
        },
        runs: {
          r1: evidence(),
          r3: evidence({ run_id: 'r3', pr_branch: 'feat/y' }),
        },
        git: { ...GIT },
        findings: { r1: rows(F1), r3: rows(F2) },
      }),
    );
  });

  // crq review (PR #2241) flagged the next one as a defect. Python enqueues a
  // cycle's findings under the meta's run id even when it names another run,
  // leaving the cycle itself without a repair record, so the ledger could
  // archive while it is unresolved. The port deliberately deviates: the meta
  // must match the cycle or the debt is recorded and nothing is enqueued, and
  // repairEnqueue stays available for matching metadata so the other run's
  // record still serves its own evidence.
  it('records unresolved debt when the meta names another run instead of enqueueing', async () => {
    const out = await runTs(
      backfill({
        findings: { r1: rows(F1) },
        runs: { r1: evidence({ run_id: 'r2' }) },
      }),
    );
    expect(out.error).toBe(false);
    expect(JSON.parse(out.queue).legacy_repair_missing).toEqual([
      { item: 'pr-5', run: 'r1', reason: 'meta names another run' },
    ]);
    expect(JSON.parse(out.queue).legacy_repair_backfilled).toBeUndefined();
    expect(Object.keys(out.files)).toEqual(['runs/r1/meta.json', 'runs/r1/review.ndjson']);
  });

  it('raises on a cycle without a run_id and on unreadable meta', async () => {
    await same(backfill({ queue: { items: [openItem({ cycles: [{}] })] } }));
    await same(backfill({ runs: { r1: { meta: 'not-a-dict', review: 'x' } } }));
  });
});

describe('repairArchiveLegacy vs the real repair_tick.archive_legacy', () => {
  const archive = (queue: Record<string, unknown>, over: Partial<Spec> = {}): Spec => ({
    mode: 'archive',
    queue: { items: [], ...queue } as Spec['queue'],
    ledger: ['a-findings.md', 'b-findings.md', 'notes.md', 'findings.md'],
    ...over,
  });

  it('moves only the *-findings.md files and stamps legacy_ledger_archived', async () => {
    const out = await same(archive({ legacy_repair_backfilled: 'T' }));
    expect(Object.keys(out.files)).toEqual([
      'ledger/archive/a-findings.md',
      'ledger/archive/b-findings.md',
      'ledger/findings.md',
      'ledger/notes.md',
    ]);
  });

  it('waits while debt is owed, nothing is backfilled, or a record is still open', async () => {
    await same(
      archive({ legacy_repair_backfilled: 'T', legacy_repair_missing: [{ item: 'x', run: 'r' }] }),
    );
    await same(archive({}));
    for (const state of ['queued', 'ready', 'publish_failed']) {
      await same(
        archive({
          legacy_repair_backfilled: 'T',
          items: [openItem({ repair_runs: { r: { state } } })],
        }),
      );
    }
    await same(
      archive({
        legacy_repair_backfilled: 'T',
        items: [openItem({ repair_runs: { r: { state: 'done' } } })],
      }),
    );
  });

  it('archives once; an empty missing list does not block', async () => {
    await same(archive({ legacy_repair_backfilled: 'T', legacy_repair_missing: [] }));
    await same(archive({ legacy_repair_backfilled: 'T', legacy_ledger_archived: 'EARLIER' }));
  });

  it('archives past a record in an unrecognized state (as Python does)', async () => {
    const out = await same(
      archive({
        legacy_repair_backfilled: 'T',
        items: [openItem({ repair_runs: { r: { state: 'mystery' } } })],
      }),
    );
    expect(out.queue).toContain('legacy_ledger_archived');
  });

  it('raises on a repair record without a state', async () => {
    await same(
      archive({ legacy_repair_backfilled: 'T', items: [openItem({ repair_runs: { r: {} } })] }),
    );
  });
});

describe('injected effects only', () => {
  it('backfill calls hasRunEvidence/readMeta and never the filesystem on its own', async () => {
    const calls: string[] = [];
    const fx = {
      primaryRepo: 'o/r',
      defaultRef: 'origin/main',
      mergedCurrentEnabled: false,
      maxRoundsPerPin: 2,
      readReceipt: async () => ({}),
      findings: async () => [],
      git: async () => '',
      readInbox: async () => null,
      writeInbox: async () => undefined,
      resultExists: async () => false,
      hasRunEvidence: async (run: string) => {
        calls.push(`has:${run}`);
        return false;
      },
      readMeta: async () => ({}),
      iso: () => ISO,
    } satisfies RepairBackfillEffects;
    const q: Queue = { items: [openItem({ cycles: [{ run_id: 'r9' }] })] };
    await repairBackfill(q, fx);
    expect(calls).toEqual(['has:r9']);
    expect(q.legacy_repair_missing).toEqual([]);
    expect(q.legacy_repair_backfilled).toBe(ISO);
  });
});

describe('file-backed repair inbox reads', () => {
  it('returns null only for an absent file and rejects a non-object document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-bf-inbox-'));
    dirs.push(root);
    const fx = fileRepairBackfillEffects({
      stateRoot: join(root, 'state'),
      runsRoot: join(root, 'runs'),
      ledgerRoot: join(root, 'ledger'),
      primaryRepo: 'o/r',
      defaultRef: 'origin/main',
      mergedCurrentEnabled: false,
      maxRoundsPerPin: 2,
      iso: () => ISO,
      git: async () => '',
      findings: async () => [],
    });
    const path = join(root, 'state', 'repair', 'inbox', 'crq-x-F1.json');
    expect(await fx.readInbox('crq-x-F1')).toBeNull(); // absent
    await fx.writeInbox('crq-x-F1', { job: 'crq-x-F1', finding: F1 });
    expect(await fx.readInbox('crq-x-F1')).toEqual({ job: 'crq-x-F1', finding: F1 });
    for (const text of ['null', '[1]', '7', '"s"', 'nul']) {
      writeFileSync(path, text);
      await expect(fx.readInbox('crq-x-F1')).rejects.toThrow();
    }
    expect(existsSync(path)).toBe(true); // invalid content is never treated as absence
  });
});

describe('Python semantics over retained JsonNumber', () => {
  it('truthiness: zero of either kind (and -0.0) is falsy, anything else truthy', () => {
    expect(truthy(JsonNumber.int(0))).toBe(false);
    expect(truthy(JsonNumber.float(0))).toBe(false);
    expect(truthy(JsonNumber.float(-0))).toBe(false);
    expect(truthy(JsonNumber.int(3))).toBe(true);
    expect(truthy(JsonNumber.int(-1n))).toBe(true);
    expect(truthy(JsonNumber.float(0.5))).toBe(true);
  });

  it('equality: 1 == 1.0 == True, exact for big ints, never equal to a string or null', () => {
    expect(pyEq(JsonNumber.int(1), JsonNumber.float(1))).toBe(true);
    expect(pyEq(JsonNumber.int(1), true)).toBe(true);
    expect(pyEq(JsonNumber.int(0), 0)).toBe(true);
    expect(pyEq(JsonNumber.int(9007199254740993n), JsonNumber.int(9007199254740992n))).toBe(false);
    expect(pyEq(JsonNumber.int(9007199254740993n), JsonNumber.float(9007199254740992))).toBe(false);
    expect(pyEq(JsonNumber.int(1), '1')).toBe(false);
    expect(pyEq(JsonNumber.int(0), null)).toBe(false);
    expect(pyEq([JsonNumber.int(2)], [JsonNumber.float(2)])).toBe(true);
  });
});
