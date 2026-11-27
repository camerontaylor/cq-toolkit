/**
 * Differential test for the resumed-repair candidate decision
 * (src/queue-runner/repairResume.ts) against Python's
 * `crq_repair.resume_worktree` and the missing-candidate refusal at the top of
 * `crq_repair.process` (crq_repair.py:472-492, 517-530).
 *
 * Offline and non-mutating by construction. Every scenario is a throwaway
 * fixture tree. The Python oracle runs the real `resume_worktree` and the real
 * `process`, with `atomic` and `retain` replaced so the first effect is only
 * RECORDED and then stops the run: no result, job or progress file is
 * written, nothing is retained, judged, verified or dispatched, and the queue
 * is never opened. The TypeScript side answers from read-only probes over the
 * same tree. Both sides also log the ordered filesystem questions they asked.
 */
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileRepairHarvestReads } from '../../src/adapters/crq/repairHarvestReads.js';
import { parseJsonValue, toPlainJsonRetainingNumbers } from '../../src/policy/crq/jsonValue.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import {
  decideResumeCandidate,
  type RepairResumeOwner,
  type RepairResumeProbes,
  selectResumeWorktree,
} from '../../src/queue-runner/repairResume.js';

const PYTHON_DIR = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ITEM = 'pr1-merged';
const JOB = 'crq-R-F1';
const BASE = `crq-repair-${ITEM}-${JOB}`;
const A2 = `${BASE}-A2`;

type GitEntry = 'file' | 'dir' | 'dangling' | 'none';

interface Ctx {
  readonly root: string;
  readonly wtRoot: string;
  /** A path under `WT_ROOT`. */
  w(name: string): string;
}

interface Scenario {
  readonly name: string;
  /** Directories under `WT_ROOT`; the base tree (with a `.git` file) by default. */
  readonly trees?: Readonly<Record<string, GitEntry>>;
  /** Symlinks under `WT_ROOT`: name -> target relative to `WT_ROOT`. */
  readonly links?: Readonly<Record<string, string>>;
  /** Plain files under `WT_ROOT`. */
  readonly files?: readonly string[];
  /** The `wt` handed to `process` (default: the base tree). */
  readonly wt?: (c: Ctx) => string;
  /** The `progress.json` text; Python parses it, so `1.0` stays a float. */
  readonly result: (c: Ctx) => string;
}

const json = (value: unknown): string => JSON.stringify(value);
/** `{ ...flags, worktree }` as JSON text. */
const res =
  (flags: Record<string, unknown>, worktree?: (c: Ctx) => unknown) =>
  (c: Ctx): string =>
    json({ ...flags, ...(worktree === undefined ? {} : { worktree: worktree(c) }) });
const at = (name: string) => (c: Ctx) => c.w(name);

const JUDGE = { pending_judge: true };
const MECH = { pending_mechanical: true };
const DISPATCH = { dispatch_pending: true };

/** Recorded trees the old selector adopted for lack of an ownership check. */
const FOREIGN: ReadonlyArray<{
  readonly label: string;
  readonly trees: Readonly<Record<string, GitEntry>>;
  readonly record: (c: Ctx) => string;
}> = [
  {
    label: 'a tree outside WT_ROOT',
    trees: { '../outside-tree': 'file' },
    record: at('../outside-tree'),
  },
  {
    label: 'the owned name outside WT_ROOT',
    trees: { [`../elsewhere/${BASE}`]: 'file' },
    record: at(`../elsewhere/${BASE}`),
  },
  {
    label: 'the owned name nested below WT_ROOT',
    trees: { [`sub/${BASE}`]: 'file' },
    record: at(`sub/${BASE}`),
  },
  {
    label: 'WT_ROOT itself',
    trees: { '': 'file' },
    record: at(''),
  },
  {
    label: 'a foreign job id',
    trees: { [`crq-repair-${ITEM}-crq-R-F2`]: 'dir' },
    record: at(`crq-repair-${ITEM}-crq-R-F2`),
  },
  {
    label: 'a foreign item id',
    trees: { [`crq-repair-pr2-merged-${JOB}`]: 'file' },
    record: at(`crq-repair-pr2-merged-${JOB}`),
  },
  {
    label: 'the legacy crq-repair-<item> name',
    trees: { [`crq-repair-${ITEM}`]: 'file' },
    record: at(`crq-repair-${ITEM}`),
  },
  {
    label: 'a generic foreign name',
    trees: { 'crq-repair-other-job': 'dir' },
    record: at('crq-repair-other-job'),
  },
  {
    label: 'an -A2 of an -A2 name',
    trees: { [`${A2}-A2`]: 'file' },
    record: at(`${A2}-A2`),
  },
  {
    label: 'an owned name with a trailing suffix',
    trees: { [`${BASE}-A3`]: 'file' },
    record: at(`${BASE}-A3`),
  },
];

const SCENARIOS: readonly Scenario[] = [
  // --- candidate selection, including the -A2 sibling -----------------------
  {
    name: 'pending judge, recorded tree is the tree in hand',
    result: res(JUDGE, at(BASE)),
  },
  {
    name: 'pending judge, recorded -A2 checkout exists: adopted',
    trees: { [BASE]: 'file', [A2]: 'file' },
    result: res(JUDGE, at(A2)),
  },
  {
    name: 'pending mechanical, recorded -A2 checkout with a .git directory: adopted',
    trees: { [BASE]: 'file', [A2]: 'dir' },
    result: res(MECH, at(A2)),
  },
  {
    name: 'running in the -A2 tree while the result records the base tree: adopted',
    trees: { [BASE]: 'file', [A2]: 'file' },
    wt: at(A2),
    result: res(JUDGE, at(BASE)),
  },
  {
    name: 'dispatch_pending alone adopts a recorded -A2 checkout',
    trees: { [BASE]: 'file', [A2]: 'file' },
    result: res(DISPATCH, at(A2)),
  },
  {
    name: 'dispatch_pending alone keeps the tree when the -A2 checkout is gone',
    result: res(DISPATCH, at(A2)),
  },
  {
    name: 'dispatch_pending and pending judge, -A2 gone: refused as judge',
    result: res({ ...DISPATCH, ...JUDGE }, at(A2)),
  },
  {
    name: 'no resume state: the recorded -A2 tree is ignored without a probe',
    trees: { [BASE]: 'file', [A2]: 'file' },
    result: res({ verdict: 'FAILED' }, at(A2)),
  },
  // --- absent / misbound candidate -> typed refusal --------------------------
  {
    name: 'pending judge, candidate tree absent: refused',
    result: res(JUDGE, at(A2)),
  },
  {
    name: 'pending mechanical, candidate tree absent: refused',
    result: res(MECH, at(A2)),
  },
  {
    name: 'both stages pending, candidate absent: reported as judge',
    result: res({ ...JUDGE, ...MECH }, at(A2)),
  },
  {
    name: 'pending judge, candidate has no .git entry: refused',
    trees: { [BASE]: 'file', [A2]: 'none' },
    result: res(JUDGE, at(A2)),
  },
  {
    name: 'pending mechanical, candidate .git is a dangling symlink: refused',
    trees: { [BASE]: 'file', [A2]: 'dangling' },
    result: res(MECH, at(A2)),
  },
  {
    name: 'pending judge, candidate is a regular file: refused',
    files: [A2],
    result: res(JUDGE, at(A2)),
  },
  {
    name: 'pending judge, candidate is a dangling symlink: refused',
    links: { [A2]: 'nowhere-at-all' },
    result: res(JUDGE, at(A2)),
  },
  {
    name: 'pending mechanical, base tree itself is gone and the candidate is the same path: proceeds',
    trees: {},
    result: res(MECH, at(BASE)),
  },
  {
    name: 'pending judge, base tree gone, candidate valid: adopted',
    trees: { [A2]: 'file' },
    result: res(JUDGE, at(A2)),
  },
  // --- path resolution -------------------------------------------------------
  {
    name: 'recorded path named -A2 but a symlink to a foreign-named checkout: not owned, refused',
    trees: { [BASE]: 'file', 'real-a2': 'file' },
    links: { [A2]: 'real-a2' },
    result: res(JUDGE, at(A2)),
  },
  {
    name: 'recorded path is a foreign-named symlink to the owned -A2 checkout: adopted as the target',
    trees: { [BASE]: 'file', [A2]: 'file' },
    links: { alias: A2 },
    result: res(JUDGE, at('alias')),
  },
  {
    name: 'recorded path is a symlink to the base tree: same tree, no refusal',
    trees: { [BASE]: 'file' },
    links: { [A2]: BASE },
    result: res(JUDGE, at(A2)),
  },
  {
    name: 'the tree in hand is a symlink to the recorded tree: kept as given',
    trees: { 'real-a2': 'file' },
    links: { [BASE]: 'real-a2' },
    result: res(MECH, at('real-a2')),
  },
  {
    name: 'recorded path with a trailing slash and dot components',
    trees: { [BASE]: 'file', [A2]: 'file' },
    result: (c) => json({ ...JUDGE, worktree: `${c.wtRoot}//./${A2}/` }),
  },
  {
    name: 'the tree in hand is given with a trailing slash',
    trees: { [BASE]: 'file' },
    wt: (c) => `${c.w(BASE)}/`,
    result: res(JUDGE, at(BASE)),
  },
  // --- ownership: formerly adopted, now refused or kept ----------------------
  ...FOREIGN.flatMap(({ label, trees, record }): Scenario[] => [
    {
      name: `pending judge, ${label} (has .git): not owned, refused`,
      trees: { [BASE]: 'file', ...trees },
      result: res(JUDGE, record),
    },
    {
      name: `pending mechanical, ${label} (has .git): not owned, refused`,
      trees: { [BASE]: 'file', ...trees },
      result: res(MECH, record),
    },
    {
      name: `dispatch_pending alone, ${label} (has .git): not adopted, tree in hand kept`,
      trees: { [BASE]: 'file', ...trees },
      result: res(DISPATCH, record),
    },
    {
      name: `running in the -A2 tree, ${label} recorded: refused, not adopted`,
      trees: { [BASE]: 'file', [A2]: 'file', ...trees },
      wt: at(A2),
      result: res(JUDGE, record),
    },
  ]),
  {
    name: 'non-ASCII tree name: not owned, refused',
    trees: { [BASE]: 'file', 'crq-repair-naïve-ß-\u{1f600}': 'file' },
    result: res(JUDGE, at('crq-repair-naïve-ß-\u{1f600}')),
  },
  // --- pending-flag truthiness -----------------------------------------------
  ...[
    ['0', '0'],
    ['empty string', '""'],
    ['empty list', '[]'],
    ['empty object', '{}'],
    ['null', 'null'],
    ['false', 'false'],
    ['0.0', '0.0'],
  ].map(([label, literal]): Scenario => ({
    name: `falsy pending_judge (${label ?? ''}): not pending, recorded -A2 ignored`,
    trees: { [BASE]: 'file', [A2]: 'file' },
    result: (c) => `{"pending_judge": ${literal ?? ''}, "worktree": ${json(c.w(A2))}}`,
  })),
  ...[
    ['1', '1'],
    ['a string', '"yes"'],
    ['a list', '[0]'],
    ['an object', '{"a": 1}'],
    ['0.5', '0.5'],
    ['1e-300', '1e-300'],
  ].map(([label, literal]): Scenario => ({
    name: `truthy pending_mechanical (${label ?? ''}): -A2 absent is refused`,
    result: (c) => `{"pending_mechanical": ${literal ?? ''}, "worktree": ${json(c.w(A2))}}`,
  })),
  {
    name: 'truthy pending_judge 1.0 with a valid -A2 checkout: adopted',
    trees: { [BASE]: 'file', [A2]: 'file' },
    result: (c) => `{"pending_judge": 1.0, "worktree": ${json(c.w(A2))}}`,
  },
  // --- recorded worktree value ----------------------------------------------
  ...[
    ['absent', undefined],
    ['null', 'null'],
    ['empty string', '""'],
    ['0', '0'],
    ['false', 'false'],
    ['empty list', '[]'],
    ['empty object', '{}'],
  ].map(([label, literal]): Scenario => ({
    name: `falsy recorded worktree (${label ?? ''}): the tree in hand is kept, no refusal`,
    result: () =>
      literal === undefined
        ? json({ pending_judge: true })
        : `{"pending_judge": true, "worktree": ${literal}}`,
  })),
  ...[
    ['an int', '5'],
    ['a float', '1.0'],
    ['true', 'true'],
    ['a list', '[1]'],
    ['an object', '{"a": 1}'],
  ].flatMap(([label, literal]): Scenario[] => [
    {
      name: `truthy non-string recorded worktree (${label ?? ''}) with pending judge: TypeError`,
      result: () => `{"pending_judge": true, "worktree": ${literal ?? ''}}`,
    },
    {
      name: `truthy non-string recorded worktree (${label ?? ''}) with dispatch_pending only: TypeError`,
      result: () => `{"dispatch_pending": true, "worktree": ${literal ?? ''}}`,
    },
    {
      name: `truthy non-string recorded worktree (${label ?? ''}) with no resume state: ignored`,
      result: () => `{"worktree": ${literal ?? ''}}`,
    },
  ]),
  {
    name: 'embedded NUL in the recorded worktree: ValueError from resolve',
    result: () => '{"pending_judge": true, "worktree": "a\\u0000b"}',
  },
  {
    name: 'embedded NUL in the recorded worktree with no resume state: ignored',
    result: () => '{"worktree": "a\\u0000b"}',
  },
];

interface Probe {
  readonly op: string;
  readonly path: string;
}

type Outcome =
  | { readonly proceed: string; readonly trace: readonly Probe[] }
  | {
      readonly refuse: string;
      readonly pending: string;
      readonly trace: readonly Probe[];
    }
  | {
      readonly error: string;
      readonly message: string;
      readonly trace: readonly Probe[];
    };

interface Observed {
  readonly process: Outcome;
  readonly direct: Outcome;
}

interface Laid {
  readonly scenario: Scenario;
  readonly ctx: Ctx;
  readonly resultText: string;
  readonly wt: string;
  /** Every file name under `WT_ROOT`, to prove neither side changed the tree. */
  readonly listing: string;
}

/**
 * Recursive, non-following snapshot of names and kinds under `dir`. A symlink is
 * recorded as itself with its stored target (`lstat` + `readlink`), never as the
 * thing it points at, and is not descended into: retargeting a link, or turning a
 * link into a copy of its target, changes the snapshot.
 */
function listing(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      out.push(`${prefix}${name}:l->${readlinkSync(full)}`);
    } else if (info.isDirectory()) {
      out.push(`${prefix}${name}:d`);
      out.push(...listing(full, `${prefix}${name}/`));
    } else {
      out.push(`${prefix}${name}:f`);
    }
  }
  return out;
}

function lay(scenario: Scenario): Laid {
  const root = mkdtempSync(join(tmpdir(), 'repair-resume-'));
  dirs.push(root);
  const wtRoot = join(root, 'wt');
  mkdirSync(wtRoot, { recursive: true });
  const ctx: Ctx = { root, wtRoot, w: (name) => join(wtRoot, name) };
  for (const [name, git] of Object.entries(scenario.trees ?? { [BASE]: 'file' })) {
    const tree = join(wtRoot, name);
    mkdirSync(tree, { recursive: true });
    if (git === 'file') writeFileSync(join(tree, '.git'), 'gitdir: ../fake\n');
    else if (git === 'dir') mkdirSync(join(tree, '.git'));
    else if (git === 'dangling') symlinkSync(join(root, 'no-such-gitdir'), join(tree, '.git'));
  }
  for (const [name, target] of Object.entries(scenario.links ?? {})) {
    symlinkSync(join(wtRoot, target), join(wtRoot, name));
  }
  for (const name of scenario.files ?? []) writeFileSync(join(wtRoot, name), 'not a tree\n');
  const directory = join(root, 'state', 'repair', JOB);
  mkdirSync(directory, { recursive: true });
  const resultText = scenario.result(ctx);
  writeFileSync(join(directory, 'progress.json'), resultText);
  return {
    scenario,
    ctx,
    resultText,
    wt: scenario.wt === undefined ? ctx.w(BASE) : scenario.wt(ctx),
    listing: listing(wtRoot).join('\n'),
  };
}

const PY = String.raw`
import importlib.util, json, pathlib, sys
from unittest import mock
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location('repair_resume_oracle', pathlib.Path(sys.argv[1]) / 'crq_repair.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

class Stop(BaseException):
    pass

# The resume preamble of process(): from the resume_worktree call to the first
# "if resume_progress:" after it. Located by text so a moved line cannot skew it.
source = pathlib.Path(service.__file__).read_text().splitlines()
start = next(i for i, l in enumerate(source) if l.startswith("    if result.get('dispatch_pending') or result.get('pending_judge')")) + 1
end = next(i for i in range(start, len(source)) if source[i] == '    if resume_progress:') + 1
Path = pathlib.Path

def kind_of(e):
    return 'OSError' if isinstance(e, OSError) else 'ValueError' if isinstance(e, ValueError) else type(e).__name__

out = []
for s in json.loads(sys.argv[2]):
    root = Path(s['root'])
    service.ROOT = root
    config = {'repair': {'roles': {}}, 'worktree_root': s['wt_root']}
    job = {'job': s['job'], 'item': s['item'], 'repair_base': 'a' * 40, 'source_sha': 'c' * 40, 'finding_sha256': 'd' * 64}
    trace = []
    effects = []

    def wrap(op, original):
        def wrapper(self, *a, **k):
            frame = sys._getframe(1)
            name = frame.f_code.co_name
            if name == 'resume_worktree' or (name == 'process' and start <= frame.f_lineno < end):
                trace.append({'op': op, 'path': str(self)})
            return original(self, *a, **k)
        return wrapper

    def fake_atomic(path, payload):
        name = Path(path).name
        effects.append({'file': name, 'wt': str(sys._getframe(1).f_locals['wt']),
                        'payload': payload if name == 'result.json' else None})
        if name == 'job.json':
            raise Stop()

    def fake_retain(*a, **k):
        effects.append({'file': 'retain', 'wt': str(sys._getframe(1).f_locals['wt']), 'payload': None})
        raise Stop()

    def run(fn):
        entry = {}
        try:
            entry['value'] = fn()
        except Stop:
            pass
        except Exception as e:
            entry['error'] = kind_of(e)
            entry['message'] = str(e)
        entry['trace'] = list(trace)
        del trace[:]
        return entry

    with mock.patch.object(Path, 'resolve', wrap('resolve', Path.resolve)), \
         mock.patch.object(Path, 'is_dir', wrap('is_dir', Path.is_dir)), \
         mock.patch.object(Path, 'exists', wrap('exists', Path.exists)), \
         mock.patch.object(service, 'atomic', fake_atomic), \
         mock.patch.object(service, 'retain', fake_retain):
        progress = json.loads((root / 'state' / 'repair' / s['job'] / 'progress.json').read_text())
        direct = run(lambda: str(service.resume_worktree(progress, s['wt'], s['wt_root'], s['item'], s['job'])))
        entry = run(lambda: service.process(config, job, s['wt']))
        # process returns the refusal result; a Stop leaves the first effect.
        if 'error' not in entry:
            first = effects[0] if effects else None
            if first is None and entry.get('value') is not None:
                raise AssertionError('process returned without an effect')
            entry['effect'] = first
    out.append({'process': entry, 'direct': direct})
print(json.dumps(out))
`;

function normalizeOracle(raw: Record<string, unknown>, refusalOnly: boolean): Outcome {
  const trace = raw.trace as Probe[];
  if (typeof raw.error === 'string') {
    return { error: raw.error, message: raw.message as string, trace };
  }
  if (!refusalOnly) return { proceed: raw.value as string, trace };
  const effect = raw.effect as {
    file: string;
    wt: string;
    payload: Record<string, unknown> | null;
  };
  const payload = effect.payload;
  const reason = payload?.reason;
  const matched =
    effect.file === 'result.json' && typeof reason === 'string'
      ? /^pending (judge|mechanical) worktree unavailable; needs human$/.exec(reason)
      : null;
  if (matched === null || payload === null) return { proceed: effect.wt, trace };
  // What the refusal writes: FAILED, a finish stamp, and neither pending key.
  expect(payload.verdict).toBe('FAILED');
  expect(typeof payload.finished_at).toBe('string');
  expect('pending_judge' in payload).toBe(false);
  expect('pending_mechanical' in payload).toBe(false);
  return { refuse: reason as string, pending: matched[1] as string, trace };
}

function runPython(laid: readonly Laid[]): Observed[] {
  const specs = laid.map(({ ctx, wt }) => ({
    root: ctx.root,
    wt,
    wt_root: ctx.wtRoot,
    job: JOB,
    item: ITEM,
  }));
  const stdout = execFileSync('python3', ['-I', '-c', PY, PYTHON_DIR, JSON.stringify(specs)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return (
    JSON.parse(stdout) as Array<{
      process: Record<string, unknown>;
      direct: Record<string, unknown>;
    }>
  ).map((entry) => ({
    process: normalizeOracle(entry.process, true),
    direct: normalizeOracle(entry.direct, false),
  }));
}

/** Read-only probes over the fixture, logging every question in order. */
function fileProbes(laid: Laid, trace: Probe[]): RepairResumeProbes {
  const reads = fileRepairHarvestReads({
    stateRoot: join(laid.ctx.root, 'state'),
    worktreeRoot: laid.ctx.wtRoot,
  });
  const ask = async (op: string, path: string): Promise<boolean> => {
    trace.push({ op, path });
    try {
      const info = await stat(path);
      return op === 'is_dir' ? info.isDirectory() : true;
    } catch {
      return false;
    }
  };
  return {
    resolve: (path) => {
      trace.push({ op: 'resolve', path });
      return reads.resolvePath(path);
    },
    isDirectory: (path) => ask('is_dir', path),
    exists: (path) => ask('exists', path),
  };
}

const ownerOf = (laid: Laid): RepairResumeOwner => ({
  worktreeRoot: laid.ctx.wtRoot,
  itemId: ITEM,
  jobId: JOB,
});

const plain = (text: string): Record<string, unknown> =>
  toPlainJsonRetainingNumbers(parseJsonValue(text)) as Record<string, unknown>;

async function settle(
  trace: Probe[],
  body: () => Promise<{ proceed: string } | { refuse: string; pending: string }>,
): Promise<Outcome> {
  try {
    return { ...(await body()), trace };
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    return { error: e.kind, message: e.message, trace };
  }
}

async function runTs(laid: Laid): Promise<Observed> {
  const resultOf = (): Record<string, unknown> => plain(laid.resultText);
  const processTrace: Probe[] = [];
  const processProbes = fileProbes(laid, processTrace);
  const decided = await settle(processTrace, async () => {
    const decision = await decideResumeCandidate(resultOf(), laid.wt, processProbes, ownerOf(laid));
    return decision.kind === 'proceed'
      ? { proceed: decision.worktree }
      : { refuse: decision.reason, pending: decision.pending };
  });
  const directTrace: Probe[] = [];
  const directProbes = fileProbes(laid, directTrace);
  const direct = await settle(directTrace, async () => ({
    proceed: await selectResumeWorktree(resultOf(), laid.wt, directProbes, ownerOf(laid)),
  }));
  return { process: decided, direct };
}

describe('repairResume differential (resume_worktree + missing-candidate refusal)', () => {
  const laid = SCENARIOS.map(lay);
  const python = runPython(laid);

  it('covers every scenario once', () => {
    expect(python).toHaveLength(SCENARIOS.length);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
  });

  it.each(SCENARIOS.map((scenario, index) => [scenario.name, index] as const))(
    '%s',
    async (_name, index) => {
      const subject = laid[index] as Laid;
      const expected = python[index] as Observed;
      const actual = await runTs(subject);
      expect(actual.process).toEqual(expected.process);
      expect(actual.direct).toEqual(expected.direct);
      // Neither side created, removed or retargeted anything under WT_ROOT.
      expect(listing(subject.ctx.wtRoot).join('\n')).toBe(subject.listing);
    },
  );

  it('exercises the typed refusal, adoption and TypeError paths', () => {
    const outcomes = python.map((entry) => entry.process);
    expect(outcomes.some((o) => 'refuse' in o && o.pending === 'judge')).toBe(true);
    expect(outcomes.some((o) => 'refuse' in o && o.pending === 'mechanical')).toBe(true);
    expect(outcomes.some((o, i) => 'proceed' in o && o.proceed === laid[i]?.ctx.w(A2))).toBe(true);
    expect(outcomes.some((o) => 'error' in o && o.error === 'TypeError')).toBe(true);
    expect(outcomes.some((o) => 'error' in o && o.error === 'ValueError')).toBe(true);
  });
});

describe('the WT_ROOT snapshot', () => {
  it('sees a symlink retargeted to a look-alike directory and a link swapped for a directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-resume-snap-'));
    dirs.push(root);
    for (const twin of ['real-a', 'real-b']) {
      mkdirSync(join(root, twin));
      writeFileSync(join(root, twin, '.git'), 'gitdir: x\n');
    }
    symlinkSync(join(root, 'real-a'), join(root, 'link'));
    const before = listing(root).join('\n');
    expect(listing(root).join('\n')).toBe(before);
    unlinkSync(join(root, 'link'));
    symlinkSync(join(root, 'real-b'), join(root, 'link'));
    const retargeted = listing(root).join('\n');
    expect(retargeted).not.toBe(before);
    unlinkSync(join(root, 'link'));
    mkdirSync(join(root, 'link'));
    writeFileSync(join(root, 'link', '.git'), 'gitdir: x\n');
    expect(listing(root).join('\n')).not.toBe(retargeted);
  });
});

describe('decideResumeCandidate with synthetic probes', () => {
  const probes = (
    answers: Partial<Record<'resolve' | 'isDirectory' | 'exists', (p: string) => unknown>> = {},
  ): { probes: RepairResumeProbes; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      probes: {
        resolve: (p) => {
          calls.push(`resolve ${p}`);
          return Promise.resolve((answers.resolve?.(p) as string | undefined) ?? p);
        },
        isDirectory: (p) => {
          calls.push(`is_dir ${p}`);
          return Promise.resolve((answers.isDirectory?.(p) as boolean | undefined) ?? true);
        },
        exists: (p) => {
          calls.push(`exists ${p}`);
          return Promise.resolve((answers.exists?.(p) as boolean | undefined) ?? true);
        },
      },
    };
  };

  const OWNER: RepairResumeOwner = { worktreeRoot: '/w', itemId: 'i', jobId: 'j' };
  const OWNED = '/w/crq-repair-i-j';
  const OWNED_A2 = `${OWNED}-A2`;

  it('asks nothing when no resume state is set', async () => {
    const { probes: p, calls } = probes();
    const decision = await decideResumeCandidate({ worktree: OWNED_A2 }, OWNED, p, OWNER);
    expect(decision).toEqual({ kind: 'proceed', worktree: OWNED, adopted: false });
    expect(calls).toEqual([]);
  });

  it('adopts an owned candidate and reports it as adopted', async () => {
    const { probes: p, calls } = probes();
    const decision = await decideResumeCandidate(
      { pending_judge: true, worktree: OWNED_A2 },
      OWNED,
      p,
      OWNER,
    );
    expect(decision).toEqual({ kind: 'proceed', worktree: OWNED_A2, adopted: true });
    expect(calls).toEqual([
      `resolve ${OWNED_A2}`,
      `resolve ${OWNED}`,
      'resolve /w',
      `is_dir ${OWNED_A2}`,
      `exists ${OWNED_A2}/.git`,
      `resolve ${OWNED_A2}`,
      `resolve ${OWNED_A2}`,
    ]);
  });

  it('adopts the owned base tree while running in -A2', async () => {
    const { probes: p } = probes();
    const decision = await decideResumeCandidate(
      { pending_mechanical: true, worktree: OWNED },
      OWNED_A2,
      p,
      OWNER,
    );
    expect(decision).toEqual({ kind: 'proceed', worktree: OWNED, adopted: true });
  });

  it('refuses a foreign candidate before asking whether it is a directory', async () => {
    const { probes: p, calls } = probes();
    const decision = await decideResumeCandidate(
      { pending_judge: true, worktree: '/w/crq-repair-i-other' },
      OWNED,
      p,
      OWNER,
    );
    expect(decision).toEqual({
      kind: 'refuse-missing-candidate',
      pending: 'judge',
      reason: 'pending judge worktree unavailable; needs human',
    });
    expect(calls.some((c) => c.startsWith('is_dir') || c.startsWith('exists'))).toBe(false);
  });

  it('keeps the tree in hand for a foreign candidate under dispatch_pending alone', async () => {
    const { probes: p } = probes();
    const decision = await decideResumeCandidate(
      { dispatch_pending: true, worktree: '/w/crq-repair-i-other' },
      OWNED,
      p,
      OWNER,
    );
    expect(decision).toEqual({ kind: 'proceed', worktree: OWNED, adopted: false });
  });

  it('identifies ownership by the resolved path, not the recorded spelling', async () => {
    // A foreign-named link whose target is the owned -A2 tree resolves to it.
    const alias = probes({ resolve: (x) => (x === '/w/alias' ? OWNED_A2 : x) });
    expect(
      await decideResumeCandidate(
        { pending_judge: true, worktree: '/w/alias' },
        OWNED,
        alias.probes,
        OWNER,
      ),
    ).toEqual({ kind: 'proceed', worktree: OWNED_A2, adopted: true });
    // An owned-named link whose target is elsewhere does not.
    const escape = probes({ resolve: (x) => (x === OWNED_A2 ? '/elsewhere/tree' : x) });
    expect(
      await decideResumeCandidate(
        { pending_judge: true, worktree: OWNED_A2 },
        OWNED,
        escape.probes,
        OWNER,
      ),
    ).toMatchObject({ kind: 'refuse-missing-candidate', pending: 'judge' });
  });

  it('compares against the resolved worktree root', async () => {
    const { probes: p } = probes({ resolve: (x) => (x === '/link-root' ? '/w' : x) });
    const decision = await decideResumeCandidate(
      { pending_judge: true, worktree: OWNED_A2 },
      OWNED,
      p,
      { ...OWNER, worktreeRoot: '/link-root' },
    );
    expect(decision).toEqual({ kind: 'proceed', worktree: OWNED_A2, adopted: true });
  });

  it('names the judge stage before the mechanical stage', async () => {
    const { probes: p } = probes({ isDirectory: () => false });
    const both = { pending_judge: 1, pending_mechanical: 1, worktree: OWNED_A2 };
    expect(await decideResumeCandidate(both, OWNED, p, OWNER)).toEqual({
      kind: 'refuse-missing-candidate',
      pending: 'judge',
      reason: 'pending judge worktree unavailable; needs human',
    });
    expect(await decideResumeCandidate({ ...both, pending_judge: 0 }, OWNED, p, OWNER)).toEqual({
      kind: 'refuse-missing-candidate',
      pending: 'mechanical',
      reason: 'pending mechanical worktree unavailable; needs human',
    });
  });

  it('never refuses a dispatch_pending-only result', async () => {
    const { probes: p } = probes({ isDirectory: () => false });
    const decision = await decideResumeCandidate(
      { dispatch_pending: true, worktree: OWNED_A2 },
      OWNED,
      p,
      OWNER,
    );
    expect(decision).toEqual({ kind: 'proceed', worktree: OWNED, adopted: false });
  });

  it('raises a Python TypeError for a truthy non-string worktree', async () => {
    const { probes: p, calls } = probes();
    await expect(
      decideResumeCandidate({ pending_judge: true, worktree: 5 }, OWNED, p, OWNER),
    ).rejects.toEqual(
      new PyError(
        'TypeError',
        "argument should be a str or an os.PathLike object where __fspath__ returns a str, not 'int'",
      ),
    );
    expect(calls).toEqual([]);
  });
});
