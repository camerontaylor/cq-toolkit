/**
 * Differential for the unit transaction against the real Python `switch_unit`
 * and `recover_unit` in `deploy-controller.py`. Each scenario is materialised
 * twice (one tree per implementation). Both run the same operation over a
 * scripted fake adapter and a journal-recording effects seam; the adapter call
 * transcript, the journal writes and the outcome (return value, refusal or
 * `RecoveryRequired` payload) are compared as Python-serialised JSON.
 *
 * Declared divergences: `KeyboardInterrupt` (a BaseException) is not modelled;
 * adapter errors carry a class `name` standing in for `type(exc).__name__`;
 * a record that is not valid UTF-8 is an effects-seam matter (the seam must
 * throw like `read_text`), so it is not driven here.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parseJsonValue,
  toPlainJsonRetainingNumbers,
} from '../../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../../src/policy/crq/pythonJson.js';
import { QueueDrainRefused, Refused } from '../../../../src/ops/crq/deploy/unitGuards.js';
import {
  RecoveryRequired,
  recoverUnit,
  switchUnit,
  type TransactionEffects,
  type UnitAdapter,
} from '../../../../src/ops/crq/deploy/unitTransaction.js';

const TICK = 'crq-tick.service';
const WD = 'crq-watchdog.service';
const NODE = `node:${'a'.repeat(40)}`;
const NODE2 = `node:${'b'.repeat(40)}`;
const TX = 'a'.repeat(32);
const RID = 'a1-20261115T010203Z';
const QTEXT = '{"items": []}';
const HB0 = 'hb0';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const GOOD_STATE = {
  'preserved/heartbeat.json': sha(HB0),
  'preserved/queue.json': sha(QTEXT),
  prior_head: 'h',
};
const SNAP = { runtime: 'python', files: { a: 'b' } };

interface Sc {
  name: string;
  op: 'switch' | 'recover';
  unit: string;
  runtime: unknown;
  adapterMode?: 'direct' | 'none' | 'factory' | 'factoryNull';
  queue?: string;
  live?: Record<string, string>;
  /** Raw JSON text: method -> steps ({ret} | {raise, cls} | {}). */
  script?: string;
  mutate?: { after: string; rel: 'queue.json' | 'heartbeat.json'; content: string };
  /** 1-based journal write attempts (append counts as one) that fail. */
  failReplace?: number[];
  /** Extra retained records by file name. */
  records?: Record<string, string>;
  /** Text of the record to recover; undefined = the file does not exist. */
  recover?: string | undefined;
  pathKind?: 'normal' | 'outside' | 'symlink';
}

const sw = (name: string, over: Partial<Sc> = {}): Sc => ({
  name,
  op: 'switch',
  unit: TICK,
  runtime: NODE,
  ...over,
});
const rc = (name: string, recover: string | undefined, over: Partial<Sc> = {}): Sc => ({
  name,
  op: 'recover',
  unit: TICK,
  runtime: NODE,
  recover,
  ...over,
});
const S = (steps: Record<string, unknown[]>): string => JSON.stringify(steps);
const boom = (msg: string, cls = 'OSError') => ({ raise: msg, cls });

const rec = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema_version: 1,
    transaction_id: TX,
    operation: 'unit_switch',
    unit: TICK,
    runtime: NODE,
    prior_runtime: 'python',
    outcome: 'pending',
    at: 't',
    snapshot: SNAP,
    state: null,
    phase: 'snapshot',
    ...over,
  });
const drained = (over: Record<string, unknown> = {}): string =>
  rec({ phase: 'drained', state: GOOD_STATE, ...over });
const evidence = (sequence: unknown, over: Record<string, unknown> = {}) => ({
  ret: { unit: TICK, runtime: NODE, success: true, sequence, ...over },
});
const aliveQueue = JSON.stringify({ items: [{ id: 'a', run: { run_id: RID } }] });
const longReason = 'é'.repeat(450);

const scenarios: Sc[] = [
  // ---- switch: success and entry refusals
  sw('switch success'),
  sw('switch success watchdog', { unit: WD }),
  sw('switch to python from node', {
    runtime: 'python',
    script: S({ preflight: [{ ret: { runtime: NODE } }] }),
  }),
  sw('invalid unit', { unit: 'other.service' }),
  sw('invalid runtime short', { runtime: 'node:abc' }),
  sw('invalid runtime upper', { runtime: `node:${'A'.repeat(40)}` }),
  sw('invalid runtime int', { runtime: 5 }),
  sw('invalid runtime newline', { runtime: `${NODE}\n` }),
  sw('no adapter', { adapterMode: 'none' }),
  sw('queue alive refuses', {
    queue: aliveQueue,
    live: { [RID]: 'alive' },
  }),
  sw('queue alive ignored for watchdog', {
    unit: WD,
    queue: aliveQueue,
    live: { [RID]: 'alive' },
  }),
  sw('unfinished unit record', { records: { [`controller-${'b'.repeat(32)}.json`]: rec() } }),
  sw('garbage record blocks', { records: { 'controller-bad.json': 'x' } }),
  sw('finished-looking record', {
    records: {
      [`controller-${'c'.repeat(32)}.json`]: rec({
        outcome: 'completed',
        phase: 'activation_pending',
        state: GOOD_STATE,
        completions: [],
      }),
    },
  }),
  sw('unrelated file ignored', { records: { 'other.txt': 'x' } }),
  // ---- switch: preflight and snapshot
  sw('preflight not a dict', { script: S({ preflight: [{ ret: 'python' }] }) }),
  sw('preflight null', { script: S({ preflight: [{ ret: null }] }) }),
  sw('preflight runtime invalid', { script: S({ preflight: [{ ret: { runtime: 'x' } }] }) }),
  sw('preflight runtime missing', { script: S({ preflight: [{ ret: {} }] }) }),
  sw('preflight same runtime', { script: S({ preflight: [{ ret: { runtime: NODE } }] }) }),
  sw('preflight raises', { script: S({ preflight: [boom('no provider')] }) }),
  sw('snapshot raises', { script: S({ snapshot: [boom('snap')] }) }),
  sw('validate_snapshot raises', {
    script: S({ validate_snapshot: [boom('bad snap', 'ValueError')] }),
  }),
  sw('snapshot null', { script: S({ snapshot: [{ ret: null }] }) }),
  sw('snapshot with big int and float', {
    script:
      '{"snapshot":[{"ret":{"runtime":"python","n":123456789012345678901234567890,"f":1.0}}]}',
  }),
  // ---- switch: journal failures at each write
  sw('append fails', { failReplace: [1] }),
  sw('drained write fails, rollback ok', { failReplace: [2] }),
  sw('activation write fails', { failReplace: [3] }),
  sw('completed write fails', { failReplace: [4] }),
  sw('restore-pending write fails', { script: S({ start: [boom('x')] }), failReplace: [4] }),
  sw('rolled_back write fails', { script: S({ start: [boom('x')] }), failReplace: [5] }),
  sw('recovery write fails too', {
    script: S({ start: [boom('x')], restore: [boom('y')] }),
    failReplace: [4],
  }),
  // ---- switch: failure in each phase -> rollback
  sw('stop_and_drain fails first', { script: S({ stop_and_drain: [boom('stuck')] }) }),
  sw('sequence raises', { script: S({ sequence: [boom('seq', 'RuntimeError')] }) }),
  ...[
    ['string', '"5"'],
    ['negative', '-1'],
    ['bool', 'true'],
    ['float', '5.0'],
    ['null', 'null'],
    ['list', '[5]'],
  ].map(([n, v]) => sw(`baseline ${n}`, { script: `{"sequence":[{"ret":${v}}]}` })),
  sw('baseline zero ok', { script: S({ sequence: [{ ret: 0 }] }) }),
  sw('baseline bigint', {
    script: '{"sequence":[{"ret":99999999999999999999}]}',
  }),
  sw('install fails', { script: S({ install: [boom('disk')] }) }),
  sw('queue changed by install', {
    mutate: { after: 'install', rel: 'queue.json', content: '{"items": [1]}' },
  }),
  sw('heartbeat changed by install', {
    mutate: { after: 'install', rel: 'heartbeat.json', content: 'changed' },
  }),
  sw('watchdog ignores preserved change', {
    unit: WD,
    mutate: { after: 'install', rel: 'queue.json', content: '{"items": [1]}' },
  }),
  sw('queue changed by restore too', {
    script: S({ start: [boom('s')] }),
    mutate: { after: 'restore', rel: 'queue.json', content: '{"items": [2]}' },
  }),
  sw('start fails', { script: S({ start: [boom('no start')] }) }),
  sw('start fails watchdog', { unit: WD, script: S({ start: [boom('no start')] }) }),
  sw('reason clipped at 400', { script: S({ start: [boom(longReason)] }) }),
  // ---- switch: completion evidence
  sw('completion raises', { script: S({ completion: [boom('probe')] }) }),
  sw('second completion raises', { script: S({ completion: [{}, boom('probe2')] }) }),
  sw('completion not dict', { script: S({ completion: [{ ret: [1] }] }) }),
  sw('completion null', { script: S({ completion: [{ ret: null }] }) }),
  sw('completion wrong unit', { script: S({ completion: [evidence(6, { unit: WD })] }) }),
  sw('completion wrong runtime', { script: S({ completion: [evidence(6, { runtime: NODE2 })] }) }),
  sw('completion unsuccessful', { script: S({ completion: [evidence(6, { success: false })] }) }),
  sw('completion success truthy', { script: S({ completion: [evidence(6, { success: 1 })] }) }),
  sw('completion success missing', {
    script:
      '{"completion":[{"ret":{"unit":"crq-tick.service","runtime":"' + NODE + '","sequence":6}}]}',
  }),
  ...[
    ['equal', '5'],
    ['lower', '4'],
    ['bool', 'true'],
    ['float', '6.0'],
    ['string', '"6"'],
    ['null', 'null'],
  ].map(([n, v]) =>
    sw(`completion sequence ${n}`, {
      script: `{"completion":[{"ret":{"unit":"${TICK}","runtime":"${NODE}","success":true,"sequence":${v}}}]}`,
    }),
  ),
  sw('completion sequence missing', {
    script: `{"completion":[{"ret":{"unit":"${TICK}","runtime":"${NODE}","success":true}}]}`,
  }),
  sw('second completion non-advancing', { script: S({ completion: [evidence(9), evidence(9)] }) }),
  sw('second completion lower', { script: S({ completion: [evidence(9), evidence(8)] }) }),
  sw('completion jump ok', { script: S({ completion: [evidence(900), evidence(901)] }) }),
  sw('completion bigint', {
    script: `{"completion":[{"ret":{"unit":"${TICK}","runtime":"${NODE}","success":true,"sequence":99999999999999999999,"x":1.5}}]}`,
  }),
  sw('completion extra keys kept', {
    script: S({ completion: [evidence(6, { extra: { a: [1, null] } })] }),
  }),
  // ---- switch: rollback failures -> recovery_required
  sw('rollback stop_and_drain fails', {
    script: S({ start: [boom('s')], stop_and_drain: [{}, boom('cannot fence')] }),
  }),
  sw('rollback stop_and_drain fails before drain', {
    script: S({ stop_and_drain: [boom('first'), boom('second')] }),
  }),
  sw('rollback restore fails', {
    script: S({ start: [boom('s')], restore: [boom('no restore')] }),
  }),
  sw('rollback restore_activation fails', {
    script: S({ start: [boom('s')], restore_activation: [boom('no act')] }),
  }),
  sw('rollback reasons clipped at 200 each', {
    script: S({ start: [boom(longReason)], restore: [boom(longReason)] }),
  }),
  sw('rollback fence value kept', {
    script: S({ start: [boom('s')], stop_and_drain: [{}, { ret: ['fenced', { n: 1.5 }] }] }),
  }),
  sw('rollback fence null', {
    script: S({ start: [boom('s')], stop_and_drain: [{}, { ret: null }] }),
  }),
  sw('rollback with null state skips preservation', {
    script: S({ stop_and_drain: [boom('first')] }),
    mutate: { after: 'restore', rel: 'queue.json', content: '{"items": [3]}' },
  }),
  // ---- recover: validation chain
  rc('recover snapshot phase', rec()),
  rc('recover drained', drained()),
  rc('recover activation_pending', rec({ phase: 'activation_pending', state: GOOD_STATE })),
  rc('recover restore_pending null state', rec({ phase: 'restore_activation_pending' })),
  rc(
    'recover restore_pending dict state',
    rec({ phase: 'restore_activation_pending', state: GOOD_STATE }),
  ),
  rc(
    'recover recovery_required retained fields',
    rec({
      outcome: 'recovery_required',
      phase: 'restore_activation_pending',
      failed_phase: 'activation_pending',
      reason: 'r',
      fence: { x: 1 },
      state: GOOD_STATE,
    }),
  ),
  rc(
    'recover reverse direction',
    rec({ runtime: 'python', prior_runtime: NODE, snapshot: { runtime: NODE } }),
  ),
  rc('recover watchdog', rec({ unit: WD, phase: 'drained', state: {} }), {
    queue: aliveQueue,
    live: { [RID]: 'alive' },
  }),
  rc('recover watchdog snapshot', rec({ unit: WD })),
  rc(
    'recover big ints kept',
    rec({ snapshot: { runtime: 'python', n: 'BIG', f: 'FLT' } })
      .replace('"BIG"', '123456789012345678901234567890')
      .replace('"FLT"', '2.0'),
  ),
  rc(
    'recover digest null mismatches',
    drained({ state: { ...GOOD_STATE, 'preserved/heartbeat.json': null } }),
  ),
  rc('recover queue alive', rec(), { queue: aliveQueue, live: { [RID]: 'alive' } }),
  rc('recover queue ambiguous', rec(), { queue: aliveQueue, live: { [RID]: 'ambiguous' } }),
  ...(
    [
      ['operation', { operation: 'deploy_pending' }],
      ['outcome completed', { outcome: 'completed' }],
      ['outcome rolled_back', { outcome: 'rolled_back' }],
      ['outcome missing', { outcome: undefined }],
      ['schema 2', { schema_version: 2 }],
      ['schema true', { schema_version: true }],
      ['schema string', { schema_version: '1' }],
      ['schema missing', { schema_version: undefined }],
      ['tx upper', { transaction_id: 'A'.repeat(32) }],
      ['tx short', { transaction_id: 'a'.repeat(31) }],
      ['tx newline', { transaction_id: `${'a'.repeat(32)}\n` }],
      ['tx int', { transaction_id: 5 }],
      ['unit unknown', { unit: 'other.service' }],
      ['unit int', { unit: 5 }],
      ['runtime short', { runtime: 'node:abc' }],
      ['runtime int', { runtime: 5 }],
      ['prior upper', { prior_runtime: 'PYTHON' }],
      ['runtime equals prior', { runtime: 'python' }],
      ['snapshot null', { snapshot: null }],
      ['snapshot list', { snapshot: [] }],
      ['snapshot runtime mismatch', { snapshot: { runtime: NODE2 } }],
      ['snapshot runtime missing', { snapshot: {} }],
      ['state key missing', { state: undefined }],
      ['phase bogus', { phase: 'bogus' }],
      ['phase missing', { phase: undefined }],
      ['phase list', { phase: [] }],
      ['snapshot phase with state', { state: GOOD_STATE }],
      ['drained null state', { phase: 'drained', state: null }],
      ['activation list state', { phase: 'activation_pending', state: [] }],
      ['restore string state', { phase: 'restore_activation_pending', state: 'x' }],
      [
        'state missing queue key',
        { phase: 'drained', state: { 'preserved/heartbeat.json': null } },
      ],
      [
        'state missing heartbeat key',
        { phase: 'drained', state: { 'preserved/queue.json': null } },
      ],
      [
        'digest upper',
        { phase: 'drained', state: { ...GOOD_STATE, 'preserved/queue.json': 'A'.repeat(64) } },
      ],
      [
        'digest short',
        { phase: 'drained', state: { ...GOOD_STATE, 'preserved/queue.json': 'a'.repeat(63) } },
      ],
      ['digest int', { phase: 'drained', state: { ...GOOD_STATE, 'preserved/queue.json': 5 } }],
      [
        'digest newline',
        {
          phase: 'drained',
          state: { ...GOOD_STATE, 'preserved/queue.json': `${'a'.repeat(64)}\n` },
        },
      ],
    ] as [string, Record<string, unknown>][]
  ).map(([n, over]) => rc(`recover invalid ${n}`, rec(over))),
  rc('recover schema float', rec().replace('"schema_version":1', '"schema_version":1.0')),
  rc(
    'recover schema big',
    rec().replace('"schema_version":1', '"schema_version":1000000000000000000000'),
  ),
  rc('recover file missing', undefined),
  rc('recover file empty', ''),
  rc('recover file invalid json', '{'),
  rc('recover file list', '[]'),
  rc('recover file string', '"x"'),
  rc('recover file null', 'null'),
  // ---- recover: path and records
  rc('recover path outside records', rec(), { pathKind: 'outside' }),
  rc('recover path symlink', rec(), { pathKind: 'symlink' }),
  rc('recover other unfinished record', rec(), {
    records: { [`controller-${'b'.repeat(32)}.json`]: rec({ transaction_id: 'b'.repeat(32) }) },
  }),
  rc('recover other garbage record', rec(), { records: { 'controller-bad.json': 'x' } }),
  rc('recover adapter none', rec(), { adapterMode: 'none' }),
  rc('recover via factory', drained(), { adapterMode: 'factory' }),
  rc('recover factory returns none', drained(), { adapterMode: 'factoryNull' }),
  // ---- recover: failures
  rc('recover validate_snapshot raises', drained(), {
    script: S({ validate_snapshot: [boom('bad', 'ValueError')] }),
  }),
  rc('recover stop_and_drain raises', drained(), {
    script: S({ stop_and_drain: [boom('stuck')] }),
  }),
  rc('recover restore raises', drained(), { script: S({ restore: [boom('r', 'RuntimeError')] }) }),
  rc('recover restore_activation raises', drained(), {
    script: S({ restore_activation: [boom('act')] }),
  }),
  rc('recover preservation changed', drained(), {
    mutate: { after: 'restore', rel: 'queue.json', content: '{"items": [9]}' },
  }),
  rc('recover preservation skipped for null state', rec(), {
    mutate: { after: 'restore', rel: 'queue.json', content: '{"items": [9]}' },
  }),
  rc('recover reason clipped at 400', drained(), { script: S({ restore: [boom(longReason)] }) }),
  rc('recover journal first write fails', drained(), { failReplace: [1] }),
  rc('recover journal second write fails', drained(), { failReplace: [2] }),
  rc('recover fence kept', drained(), {
    script: S({ stop_and_drain: [{ ret: { f: [1, 2.5] } }] }),
  }),
  rc(
    'recover repeated failed_phase kept',
    rec({ phase: 'drained', state: GOOD_STATE, failed_phase: 'xyz' }),
  ),
];

// ---------------------------------------------------------------------------

const controller = resolve('apps/crq-python/ops/deploy-controller.py');
const probe = spawnSync(
  'python3',
  ['-I', '-c', 'import sys; print(sys.version_info[:2] >= (3, 10))'],
  { encoding: 'utf8' },
);
const haveOracle = probe.status === 0 && probe.stdout.trim() === 'True';

const GIT: Record<string, string> = {
  'rev-parse HEAD': `${'a'.repeat(40)}\n`,
  'status --porcelain --untracked-files=all': ' M x\n',
};
const UNIT_DIGESTS = { [TICK]: 'd1', [WD]: null };

const PY = `
import builtins, contextlib, importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location("dc", sys.argv[1])
dc = importlib.util.module_from_spec(spec); sys.modules["dc"] = dc; spec.loader.exec_module(dc)
GIT = json.loads(sys.argv[2])
UD = json.loads(sys.argv[3])
TX = sys.argv[4]
dc.now_iso = lambda: "2026-11-15T01:02:03Z"
dc.uuid = types.SimpleNamespace(uuid4=lambda: types.SimpleNamespace(hex="0" * 31 + "1"))
out = []
for d in sys.argv[5:]:
    root = pathlib.Path(d)
    sc = json.loads((root / "scenario.json").read_text())
    state = root / "state"
    rec = root / "records"
    log = []
    journal = []
    count = [0]
    script = json.loads(sc["script"]) if sc.get("script") else {}
    def put(kind, path, entry):
        count[0] += 1
        if count[0] in sc.get("failReplace", []):
            raise OSError("disk full")
        journal.append([kind, str(path), entry])
        path.write_text(json.dumps(entry))
    def append(entry):
        path = rec / ("controller-" + dc.uuid.uuid4().hex + ".json")
        put("append", path, entry)
        return path
    def replace(path, entry):
        put("replace", path, entry)
    eff = types.SimpleNamespace(
        root=root, record_dir=rec, state_dir=lambda s=state: s,
        completion_heartbeat_path=lambda r=root: r / "hb.json",
        config_path=root / "config.json",
        read_json=lambda rel, s=state: json.loads((s / rel).read_text()),
        git=lambda *a: GIT[" ".join(a)], unit_digests=lambda: UD,
        controller_lock=contextlib.nullcontext, record_preflight=lambda: None,
        journal_append=append, journal_replace=replace)
    live_map = sc.get("live", {})
    def live(rdir, item, r, has_exit, m=live_map):
        v = m.get(r["run_id"], "harvest")
        if v.startswith("raise:"):
            raise OSError(v[6:])
        return v
    dc._runner_liveness = lambda e, l=live: l
    def mutate(name):
        m = sc.get("mutate")
        if m and m["after"] == name:
            p = state / "queue.json" if m["rel"] == "queue.json" else root / "hb.json"
            p.write_text(m["content"])
    class A:
        def _call(self, name, args, default):
            log.append([name, *args])
            mutate(name)
            steps = script.get(name)
            step = steps.pop(0) if steps else {}
            if "raise" in step:
                raise getattr(builtins, step.get("cls", "RuntimeError"))(step["raise"])
            return step["ret"] if "ret" in step else default
        def preflight(self, unit, runtime):
            return self._call("preflight", [unit, runtime], {"runtime": "python"})
        def snapshot(self, unit):
            return self._call("snapshot", [unit], {"runtime": "python", "files": {"a": "b"}})
        def validate_snapshot(self, unit, snapshot):
            return self._call("validate_snapshot", [unit, snapshot], None)
        def stop_and_drain(self, unit):
            return self._call("stop_and_drain", [unit], {"fence": "ok"})
        def install(self, unit, runtime):
            return self._call("install", [unit, runtime], None)
        def sequence(self, unit):
            return self._call("sequence", [unit], 5)
        def start(self, unit):
            return self._call("start", [unit], None)
        def completion(self, unit, runtime, previous):
            return self._call("completion", [unit, runtime, previous],
                              {"unit": unit, "runtime": runtime, "success": True, "sequence": previous + 1})
        def restore(self, unit, snapshot):
            return self._call("restore", [unit, snapshot], None)
        def restore_activation(self, unit, snapshot):
            return self._call("restore_activation", [unit, snapshot], None)
    mode = sc.get("adapterMode", "direct")
    adapter = A() if mode == "direct" else None
    def factory(unit, prior):
        log.append(["factory", unit, prior])
        return None if mode == "factoryNull" else A()
    kind = sc.get("pathKind", "normal")
    path = root / "controller-x.json" if kind == "outside" else (
        rec / "controller-link.json" if kind == "symlink" else rec / ("controller-" + TX + ".json"))
    try:
        if sc["op"] == "switch":
            res = {"ok": dc.switch_unit(eff, adapter, sc["unit"], sc["runtime"])}
        else:
            kw = {"adapter_factory": factory} if mode in ("factory", "factoryNull") else {}
            res = {"ok": dc.recover_unit(eff, adapter, path, **kw)}
    except dc.RecoveryRequired as e:
        res = {"recovery": e.recovery, "msg": str(e)}
    except dc.QueueDrainRefused as e:
        res = {"qdr": str(e)}
    except dc.Refused as e:
        res = {"refused": str(e)}
    except Exception as e:
        res = {"raised": type(e).__name__, "msg": str(e)}
    out.append({"res": res, "log": log, "journal": journal})
print(json.dumps(out, sort_keys=True))
`;

function materialise(root: string, sc: Sc): void {
  const records = join(root, 'records');
  mkdirSync(join(root, 'state', 'runs'), { recursive: true });
  mkdirSync(records);
  chmodSync(records, 0o700);
  writeFileSync(join(root, 'state', 'queue.json'), sc.queue ?? QTEXT);
  writeFileSync(join(root, 'hb.json'), HB0);
  writeFileSync(join(root, 'config.json'), '{}');
  for (const [name, text] of Object.entries(sc.records ?? {})) {
    writeFileSync(join(records, name), text);
  }
  if (sc.recover !== undefined) {
    const real = join(records, `controller-${TX}.json`);
    if (sc.pathKind === 'outside') {
      writeFileSync(join(root, 'controller-x.json'), sc.recover);
    } else {
      writeFileSync(real, sc.recover);
      if (sc.pathKind === 'symlink') symlinkSync(real, join(records, 'controller-link.json'));
    }
  }
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(sc));
}

const dump = (value: unknown): string =>
  pythonJsonText(value, { sortKeys: true, asciiOnly: true, spacedSeparators: true });

type Step = { ret?: unknown; raise?: string; cls?: string };
const named = (message: string, cls: string): Error =>
  Object.assign(new Error(message), { name: cls });

interface Harness {
  effects: TransactionEffects;
  adapter: () => UnitAdapter;
  log: unknown[][];
  journal: unknown[];
  path: string;
}

function harness(root: string, sc: Sc): Harness {
  const state = join(root, 'state');
  const records = join(root, 'records');
  const hb = join(root, 'hb.json');
  const log: unknown[][] = [];
  const journal: unknown[] = [];
  let count = 0;
  const script = (
    sc.script === undefined ? {} : toPlainJsonRetainingNumbers(parseJsonValue(sc.script))
  ) as Record<string, Step[]>;
  const digest = (rel: string): string | null => {
    try {
      return sha(readFileSync(rel === 'heartbeat.json' ? hb : join(state, rel), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const put = (kind: string, path: string, entry: Record<string, unknown>): void => {
    count += 1;
    if (sc.failReplace?.includes(count) === true) throw named('disk full', 'OSError');
    journal.push([kind, path, entry]);
    writeFileSync(path, dump(entry));
  };
  const live = (runId: string): string => {
    const v = sc.live?.[runId] ?? 'harvest';
    if (v.startsWith('raise:')) throw new Error(v.slice(6));
    return v;
  };
  const effects: TransactionEffects = {
    git: (...args) => GIT[args.join(' ')] ?? '',
    configSha256: () => sha(readFileSync(join(root, 'config.json'), 'utf8')),
    preservedDigest: digest,
    unitDigests: () => UNIT_DIGESTS,
    readQueueJson: () => parseJsonValue(readFileSync(join(state, 'queue.json'), 'utf8')),
    exitExists: (runId) => existsSync(join(state, 'runs', runId, 'exit.json')),
    controllerLock: (body) => body(),
    recordPreflight: () => undefined,
    recordEntries: () =>
      readdirSync(records).map((name) => {
        const p = join(records, name);
        return {
          name,
          isSymlink: () => lstatSync(p).isSymbolicLink(),
          isFile: () => {
            try {
              return statSync(p).isFile();
            } catch {
              return false;
            }
          },
          read: () => readFileSync(p, 'utf8'),
          resolved: () => realpathSync(p),
        };
      }),
    recordPathAllowed: (path) =>
      dirname(path) === records &&
      lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() !== true,
    resolvedPath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    },
    readRecordText: (path) => readFileSync(path, 'utf8'),
    journalAppend: (entry) => {
      const path = join(records, `controller-${'0'.repeat(31)}1.json`);
      put('append', path, entry);
      return path;
    },
    journalReplace: (path, entry) => put('replace', path, entry),
    liveness: (runId) => live(runId),
    uuidHex: () => `${'0'.repeat(31)}1`,
    nowIso: () => '2026-11-15T01:02:03Z',
  };
  const mutate = (name: string): void => {
    const m = sc.mutate;
    if (m?.after !== name) return;
    writeFileSync(m.rel === 'queue.json' ? join(state, 'queue.json') : hb, m.content);
  };
  const call = (name: string, args: unknown[], fallback: unknown): unknown => {
    log.push([name, ...args]);
    mutate(name);
    const step = script[name]?.shift() ?? {};
    if (step.raise !== undefined) throw named(step.raise, step.cls ?? 'RuntimeError');
    return 'ret' in step ? step.ret : fallback;
  };
  const adapter = (): UnitAdapter => ({
    preflight: (u, r) => call('preflight', [u, r], { runtime: 'python' }),
    snapshot: (u) => call('snapshot', [u], { runtime: 'python', files: { a: 'b' } }),
    validateSnapshot: (u, s) => void call('validate_snapshot', [u, s], null),
    stopAndDrain: (u) => call('stop_and_drain', [u], { fence: 'ok' }),
    install: (u, r) => void call('install', [u, r], null),
    sequence: (u) => call('sequence', [u], 5n),
    start: (u) => void call('start', [u], null),
    completion: (u, r, p) =>
      call('completion', [u, r, p], { unit: u, runtime: r, success: true, sequence: p + 1n }),
    restore: (u, s) => void call('restore', [u, s], null),
    restoreActivation: (u, s) => void call('restore_activation', [u, s], null),
  });
  const kind = sc.pathKind ?? 'normal';
  const path =
    kind === 'outside'
      ? join(root, 'controller-x.json')
      : join(records, kind === 'symlink' ? 'controller-link.json' : `controller-${TX}.json`);
  return { effects, adapter, log, journal, path };
}

async function tsRun(root: string, sc: Sc): Promise<unknown> {
  const h = harness(root, sc);
  const mode = sc.adapterMode ?? 'direct';
  const adapter = mode === 'direct' ? h.adapter() : null;
  let res: Record<string, unknown>;
  try {
    if (sc.op === 'switch') {
      res = { ok: await switchUnit(h.effects, adapter, sc.unit, sc.runtime as string) };
    } else {
      const factory =
        mode === 'factory' || mode === 'factoryNull'
          ? (unit: string, prior: string): UnitAdapter | null => {
              h.log.push(['factory', unit, prior]);
              return mode === 'factoryNull' ? null : h.adapter();
            }
          : undefined;
      res = { ok: await recoverUnit(h.effects, adapter, h.path, factory) };
    }
  } catch (error) {
    if (error instanceof RecoveryRequired) res = { recovery: error.recovery, msg: error.message };
    else if (error instanceof QueueDrainRefused) res = { qdr: error.message };
    else if (error instanceof Refused) res = { refused: error.message };
    else res = { raised: (error as Error).name, msg: (error as Error).message };
  }
  return { res, log: h.log, journal: h.journal };
}

describe.skipIf(!haveOracle)('unit transaction matches deploy-controller.py', () => {
  const base = mkdtempSync(join(tmpdir(), 'unit-tx-'));
  const pyDirs = scenarios.map((sc, i) => {
    const dir = join(base, `py-${i}`);
    mkdirSync(dir);
    materialise(dir, sc);
    return dir;
  });
  const python = spawnSync(
    'python3',
    ['-I', '-c', PY, controller, JSON.stringify(GIT), JSON.stringify(UNIT_DIGESTS), TX, ...pyDirs],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (python.status !== 0) throw new Error(`oracle failed: ${python.stderr}`);
  const expected = toPlainJsonRetainingNumbers(parseJsonValue(python.stdout)) as unknown[];

  scenarios.forEach((sc, i) => {
    test(sc.name, async () => {
      const dir = join(base, `ts-${i}`);
      mkdirSync(dir);
      materialise(dir, sc);
      const actual = dump(await tsRun(dir, sc)).replaceAll(dir, '<R>');
      expect(actual).toBe(dump(expected[i]).replaceAll(pyDirs[i]!, '<R>'));
    });
  });

  test('oracle exercised every outcome and refusal path', () => {
    const text = dump(expected).replaceAll('": ', '":');
    for (const needle of [
      '"ok"',
      '"recovery"',
      '"refused"',
      '"qdr"',
      '"raised"',
      'rolled_back',
      'recovery_required',
      'failed_phase',
      'invalid unit recovery record',
      'unreadable unit recovery record',
      'invalid controller transaction record path',
      'no unit recovery adapter',
      'invalid or non-advancing unit completion evidence',
      'invalid completion baseline',
      'preserved surfaces changed',
      'unfinished unit switch requires recovery',
      '; rollback: ',
    ]) {
      expect(text).toContain(needle.replaceAll('": ', '":'));
    }
  });
});
