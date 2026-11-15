/**
 * Differential for the controller record classifier against the real Python
 * `_classify_record` / `refuse_unfinished_transactions`: every case is written
 * to a temp directory, classified by `deploy-controller.py`, and compared with
 * the TypeScript port. Skipped only when `python3` is unavailable.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  RecordRefused,
  classifyRecord,
  refuseUnfinishedTransactions,
  type RecordEntry,
} from '../../../../src/ops/crq/deploy/controllerRecords.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const TX = '0123456789abcdef0123456789abcdef';
const HEX64 = 'c'.repeat(64);
const TAG = 'crq-runner/20261115-1';
const NODE = `node:${SHA}`;

type Rec = Record<string, unknown>;

const unit = (over: Rec = {}): Rec => ({
  schema_version: 1,
  transaction_id: TX,
  operation: 'unit_switch',
  unit: 'crq-watchdog.service',
  runtime: NODE,
  prior_runtime: 'python',
  outcome: 'pending',
  at: '2026-11-15T00:00:00Z',
  snapshot: {},
  state: null,
  phase: 'snapshot',
  ...over,
});
const completion = (sequence: number, over: Rec = {}): Rec => ({
  unit: 'crq-watchdog.service',
  runtime: NODE,
  success: true,
  sequence,
  ...over,
});
const completed = (over: Rec = {}): Rec =>
  unit({
    outcome: 'completed',
    phase: 'activation_pending',
    state: {},
    completions: [completion(1), completion(2)],
    ...over,
  });
const rolledBack = (over: Rec = {}): Rec =>
  unit({ outcome: 'rolled_back', phase: 'restore_activation_pending', ...over });
const identity = (over: Rec = {}): Rec => ({
  schema_version: 1,
  transaction_id: TX,
  at: 'now',
  intended_operation: 'deploy',
  prior_state: {},
  prior_head: SHA,
  prior_config_sha256: HEX64,
  prior_tag: TAG,
  target: SHA2,
  tag: TAG,
  helper_sha256: null,
  automatic_rollback_permitted: false,
  rollback_compatibility: {},
  ...over,
});
const plan = { preflight: {}, steps: [] };
const refusal = (over: Rec = {}): Rec => ({
  ...identity(),
  operation: 'deploy_refused',
  outcome: 'refused_no_change',
  failed_phase: 'p',
  reason: 'r',
  observations: {},
  record_path: '/x',
  record_persisted: true,
  ...over,
});
const recovery = (over: Rec = {}): Rec => ({
  ...identity(),
  operation: 'recovery_required',
  outcome: 'recovery_required',
  failed_phase: 'p',
  reason: 'r',
  record_path: '/x',
  record_persisted: false,
  ...over,
});
const deployDone = (over: Rec = {}): Rec => ({
  schema_version: 1,
  transaction_id: TX,
  operation: 'deploy',
  outcome: 'completed',
  at: 'now',
  prior_head: SHA,
  prior_config_sha256: null,
  prior_tag: null,
  target: SHA2,
  tag: TAG,
  helper_sha256: HEX64,
  rollback_compatibility: {},
  automatic_rollback_permitted: true,
  plan,
  ...over,
});
const rollbackDone = (over: Rec = {}): Rec => ({
  schema_version: 1,
  transaction_id: TX,
  operation: 'rollback',
  outcome: 'completed',
  at: 'now',
  to: SHA,
  tag: TAG,
  helper_sha256: null,
  ...over,
});
const without = (rec: Rec, key: string): Rec => {
  const copy = { ...rec };
  delete copy[key];
  return copy;
};

/** A case is either a record (serialised) or literal file text. */
const cases: Array<[string, Rec | string]> = [
  ['unit pending', unit()],
  ['unit pending, missing state key', without(unit(), 'state')],
  ['unit pending, state object but phase snapshot', unit({ state: {} })],
  ['unit drained', unit({ phase: 'drained', state: {} })],
  ['unit drained without state', unit({ phase: 'drained' })],
  ['unit activation_pending', unit({ phase: 'activation_pending', state: {} })],
  ['unit restore pending, null state', unit({ phase: 'restore_activation_pending' })],
  ['unit completed', completed()],
  ['unit completed, equal sequences', completed({ completions: [completion(2), completion(2)] })],
  ['unit completed, descending', completed({ completions: [completion(3), completion(2)] })],
  [
    'unit completed, bool sequence',
    completed({ completions: [completion(1), completion(2, { sequence: true })] }),
  ],
  ['unit completed, one completion', completed({ completions: [completion(1)] })],
  [
    'unit completed, wrong unit',
    completed({ completions: [completion(1), completion(2, { unit: 'crq-tick.service' })] }),
  ],
  [
    'unit completed, wrong runtime',
    completed({ completions: [completion(1), completion(2, { runtime: 'python' })] }),
  ],
  [
    'unit completed, success false',
    completed({ completions: [completion(1), completion(2, { success: false })] }),
  ],
  ['unit completed, wrong phase', completed({ phase: 'drained' })],
  ['unit rolled_back', rolledBack()],
  ['unit rolled_back with reason', rolledBack({ reason: '' })],
  ['unit rolled_back bad reason', rolledBack({ reason: 3 })],
  ['unit rolled_back wrong phase', rolledBack({ phase: 'activation_pending', state: {} })],
  [
    'unit recovery_required',
    unit({ outcome: 'recovery_required', reason: 'x', record_path: '/p' }),
  ],
  ['unit recovery_required no reason', unit({ outcome: 'recovery_required', record_path: '/p' })],
  [
    'unit recovery_required empty reason',
    unit({ outcome: 'recovery_required', reason: '', record_path: '/p' }),
  ],
  ['unit recovery_required no path', unit({ outcome: 'recovery_required', reason: 'x' })],
  ['unit bad outcome', unit({ outcome: 'weird' })],
  ['unit null outcome', unit({ outcome: null })],
  ['unit unknown unit', unit({ unit: 'nope.service' })],
  ['unit same runtime', unit({ prior_runtime: NODE })],
  ['unit short node runtime', unit({ runtime: 'node:abc' })],
  ['unit uppercase node runtime', unit({ runtime: `node:${'A'.repeat(40)}` })],
  ['unit bad tx id', unit({ transaction_id: 'zz' })],
  ['unit empty at', unit({ at: '' })],
  ['unit no snapshot', without(unit(), 'snapshot')],
  ['unit null snapshot', unit({ snapshot: null })],
  ['unit bad phase', unit({ phase: 'done' })],
  ['unit non-string phase', unit({ phase: ['snapshot'] })],
  ['unit state not dict', unit({ state: 3 })],
  ['schema 2', unit({ schema_version: 2 })],
  ['schema true', unit({ schema_version: true })],
  ['schema missing', without(unit(), 'schema_version')],
  ['schema string', unit({ schema_version: '1' })],
  ['deploy legacy', { operation: 'deploy', schema_version: 1, at: 'now', plan }],
  ['deploy legacy bad plan', { operation: 'deploy', schema_version: 1, at: 'now', plan: {} }],
  ['deploy completed', deployDone()],
  ['deploy completed, auto rollback not bool', deployDone({ automatic_rollback_permitted: 1 })],
  ['deploy completed, bad prior tag', deployDone({ prior_tag: 'v1' })],
  ['deploy completed, bad helper', deployDone({ helper_sha256: 'abc' })],
  ['deploy bad outcome', deployDone({ outcome: 'pending' })],
  ['rollback legacy', { operation: 'rollback', schema_version: 1, at: 'now', to: SHA, tag: TAG }],
  [
    'rollback legacy bad sha',
    { operation: 'rollback', schema_version: 1, at: 'now', to: 'x', tag: TAG },
  ],
  ['rollback completed', rollbackDone()],
  ['rollback completed no tx', without(rollbackDone(), 'transaction_id')],
  ['rollback bad outcome', rollbackDone({ outcome: 'x' })],
  ['deploy pending', { ...identity(), operation: 'deploy_pending', outcome: 'pending' }],
  [
    'rollback pending',
    {
      ...identity({ intended_operation: 'rollback' }),
      operation: 'rollback_pending',
      outcome: 'pending',
    },
  ],
  [
    'pending, bad intended op',
    { ...identity({ intended_operation: 'x' }), operation: 'deploy_pending', outcome: 'pending' },
  ],
  [
    'pending, auto rollback true',
    {
      ...identity({ automatic_rollback_permitted: true }),
      operation: 'deploy_pending',
      outcome: 'pending',
    },
  ],
  [
    'pending, auto rollback missing',
    {
      ...without(identity(), 'automatic_rollback_permitted'),
      operation: 'deploy_pending',
      outcome: 'pending',
    },
  ],
  ['pending wrong outcome', { ...identity(), operation: 'deploy_pending', outcome: 'completed' }],
  ['deploy refused', refusal()],
  ['rollback refused', refusal({ operation: 'rollback_refused' })],
  ['refused wrong outcome', refusal({ outcome: 'pending' })],
  ['refused persisted not bool', refusal({ record_persisted: 'yes' })],
  ['refused no observations', without(refusal(), 'observations')],
  ['recovery_required', recovery()],
  ['recovery_required, observed head', recovery({ observed_head: SHA })],
  ['recovery_required, bad observed head', recovery({ observed_head: 'x' })],
  ['recovery_required, bad head error', recovery({ head_observation_error: 3 })],
  ['recovery_required, write error', recovery({ record_write_error: 'e' })],
  [
    'recovery_required legacy',
    { schema_version: 1, operation: 'recovery_required', outcome: 'recovery_required' },
  ],
  ['recovery_required wrong outcome', recovery({ outcome: 'pending' })],
  ['unknown operation', { schema_version: 1, operation: 'mystery' }],
  ['missing operation', { schema_version: 1 }],
  ['not an object', '[1]'],
  ['null', 'null'],
  ['empty file', ''],
  ['invalid json', '{'],
  ['trailing garbage', `${JSON.stringify(unit())} x`],
  ['NaN constant', '{"schema_version": 1, "x": NaN, "operation": "mystery"}'],
  ['float schema', '{"schema_version": 1.0, "operation": "unit_switch"}'],
  ['huge int schema', `{"schema_version": ${'9'.repeat(40)}, "operation": "unit_switch"}`],
  [
    'duplicate key keeps last',
    `{"schema_version": 2, "schema_version": 1, "operation": "mystery"}`,
  ],
  ['lone surrogate escape', '{"schema_version": 1, "operation": "\\ud800"}'],
  ['invalid utf-8', '\u0000BYTES:ff fe'],
  [
    'float completion sequence',
    JSON.stringify(completed()).replace('"sequence":2}', '"sequence":2.0}'),
  ],
  [
    'float completion sequence, first',
    JSON.stringify(completed()).replace('"sequence":1}', '"sequence":1.0}'),
  ],
];

function render(value: Rec | string): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function fileEntry(dir: string, name: string): RecordEntry {
  const path = join(dir, name);
  return {
    name,
    isSymlink: () => lstatSync(path).isSymbolicLink(),
    isFile: () => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    read: () => {
      const bytes = readFileSync(path);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
    resolved: () => realpathSync(path),
  };
}

const PY = `
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location("dc", sys.argv[1])
dc = importlib.util.module_from_spec(spec); sys.modules["dc"] = dc; spec.loader.exec_module(dc)
root = pathlib.Path(sys.argv[2])
out = {}
for p in sorted(root.glob("controller-*.json")):
    try:
        out[p.name] = list(dc._classify_record(p))
    except dc.Refused as exc:
        out[p.name] = ["refused", str(exc)]
print(json.dumps(out))
`;

const controller = resolve('apps/crq-python/ops/deploy-controller.py');
const probe = spawnSync(
  'python3',
  ['-I', '-c', 'import sys; print(sys.version_info[:2] >= (3, 10))'],
  {
    encoding: 'utf8',
  },
);
const haveOracle = probe.status === 0 && probe.stdout.trim() === 'True';

function pythonClassify(dir: string): Record<string, string[]> {
  const run = spawnSync('python3', ['-I', '-c', PY, controller, dir], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`oracle failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as Record<string, string[]>;
}

function tsClassify(dir: string, name: string): string[] {
  try {
    const { status, operation } = classifyRecord(fileEntry(dir, name));
    return [status, operation];
  } catch (error) {
    if (!(error instanceof RecordRefused)) throw error;
    return ['refused', error.message];
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'controller-records-'));
}

describe.skipIf(!haveOracle)('classifyRecord against the Python oracle', () => {
  test('every case classifies as the Python controller does', () => {
    const dir = scratch();
    try {
      const names: string[] = [];
      cases.forEach(([, value], index) => {
        const name = `controller-${String(index).padStart(3, '0')}.json`;
        names.push(name);
        if (value === '\u0000BYTES:ff fe') {
          writeFileSync(join(dir, name), Buffer.from([0xff, 0xfe, 0x7b]));
        } else {
          writeFileSync(join(dir, name), render(value));
        }
      });
      // A symlink to a good record, a directory and a dangling link.
      writeFileSync(join(dir, 'real.json'), render(unit()));
      symlinkSync(join(dir, 'real.json'), join(dir, 'controller-900.json'));
      mkdirSync(join(dir, 'controller-901.json'));
      symlinkSync(join(dir, 'missing.json'), join(dir, 'controller-902.json'));
      names.push('controller-900.json', 'controller-901.json', 'controller-902.json');

      const expected = pythonClassify(dir);
      expect(Object.keys(expected).sort()).toEqual([...names].sort());
      const kinds = new Set<string>();
      for (const name of names) {
        const want = expected[name];
        expect(
          tsClassify(dir, name),
          `${name} ${cases[names.indexOf(name)]?.[0] ?? 'extra'}`,
        ).toEqual(want);
        kinds.add(`${want?.[0]}:${want?.[1]?.split(':')[0] ?? ''}`);
      }
      // The matrix really exercises both verdicts and many refusal reasons.
      expect([...kinds].filter((k) => k.startsWith('finished')).length).toBeGreaterThanOrEqual(5);
      expect([...kinds].filter((k) => k.startsWith('unfinished')).length).toBeGreaterThanOrEqual(3);
      expect([...kinds].filter((k) => k.startsWith('refused')).length).toBeGreaterThanOrEqual(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const GUARD_PY = `
import importlib.util, pathlib, sys, types
spec = importlib.util.spec_from_file_location("dc", sys.argv[1])
dc = importlib.util.module_from_spec(spec); sys.modules["dc"] = dc; spec.loader.exec_module(dc)
root = pathlib.Path(sys.argv[2])
exclude = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else None
try:
    dc.refuse_unfinished_transactions(types.SimpleNamespace(record_dir=root), exclude)
    print("ok")
except dc.Refused as exc:
    print("refused:" + str(exc))
`;

function pythonGuard(dir: string, exclude?: string): string {
  const args = ['-I', '-c', GUARD_PY, controller, dir, ...(exclude === undefined ? [] : [exclude])];
  const run = spawnSync('python3', args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`oracle failed: ${run.stderr}`);
  return run.stdout.trim();
}

function tsGuard(dir: string, exclude?: string): string {
  const entries = readdirSync(dir).map((name) => fileEntry(dir, name));
  try {
    refuseUnfinishedTransactions(
      entries,
      exclude === undefined ? undefined : realpathSync(exclude),
    );
    return 'ok';
  } catch (error) {
    if (!(error instanceof RecordRefused)) throw error;
    return `refused:${error.message}`;
  }
}

describe.skipIf(!haveOracle)('refuseUnfinishedTransactions against the Python oracle', () => {
  const layouts: Array<[string, Array<[string, Rec | string]>, string | undefined]> = [
    ['empty directory', [], undefined],
    [
      'ignores non-controller files',
      [
        ['notes.json', 'garbage'],
        ['controller-a.txt', 'garbage'],
        ['controller-1.json.bak', 'garbage'],
      ],
      undefined,
    ],
    ['empty glob star matches', [['controller-.json', unit()]], undefined],
    [
      'finished history',
      [
        ['controller-1.json', completed()],
        ['controller-2.json', rolledBack()],
        ['controller-3.json', deployDone()],
      ],
      undefined,
    ],
    ['unfinished unit switch', [['controller-1.json', unit()]], undefined],
    [
      'recovery_required unit',
      [
        [
          'controller-1.json',
          unit({ outcome: 'recovery_required', reason: 'x', record_path: '/p' }),
        ],
      ],
      undefined,
    ],
    [
      'pending checkout',
      [['controller-1.json', { ...identity(), operation: 'deploy_pending', outcome: 'pending' }]],
      undefined,
    ],
    ['unresolved checkout recovery', [['controller-1.json', recovery()]], undefined],
    [
      'legacy recovery',
      [
        [
          'controller-1.json',
          { schema_version: 1, operation: 'recovery_required', outcome: 'recovery_required' },
        ],
      ],
      undefined,
    ],
    ['unreadable record', [['controller-1.json', '{']], undefined],
    [
      'sorted order: b refused before a is reached? (a first)',
      [
        ['controller-b.json', '{'],
        ['controller-a.json', unit()],
      ],
      undefined,
    ],
    [
      'sort by code point not locale',
      [
        ['controller-B.json', unit()],
        ['controller-a.json', '{'],
      ],
      undefined,
    ],
    [
      'finished then unfinished',
      [
        ['controller-1.json', completed()],
        ['controller-2.json', unit()],
      ],
      undefined,
    ],
    ['excluded unfinished record', [['controller-1.json', unit()]], 'controller-1.json'],
    [
      'excluded record, other unfinished',
      [
        ['controller-1.json', unit()],
        ['controller-2.json', unit()],
      ],
      'controller-1.json',
    ],
    ['excluded garbage is skipped unread', [['controller-1.json', '{']], 'controller-1.json'],
    [
      'exclude names a different record',
      [
        ['controller-1.json', unit()],
        ['controller-2.json', completed()],
      ],
      'controller-2.json',
    ],
  ];
  test.each(layouts)('%s', (_name, files, exclude) => {
    const dir = scratch();
    try {
      for (const [name, value] of files) writeFileSync(join(dir, name), render(value));
      const excludePath = exclude === undefined ? undefined : join(dir, exclude);
      const want = pythonGuard(dir, excludePath);
      expect(tsGuard(dir, excludePath)).toBe(want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
