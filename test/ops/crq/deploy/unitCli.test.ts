/**
 * Differential for the unit-operation slice of `deploy-controller.py main`
 * against the real Python `main`. Python's helper load, live binding,
 * `Effects` and the two transactions are monkeypatched to scripted outcomes;
 * the argument contract, dispatch, artifacts, stderr and exit codes are the
 * real ones. The TS side injects the same scripted outcomes.
 *
 * Declared divergences: a Python `ValueError` is modelled by an Error named `ValueError`; a checkout switch with both --sha and --tag refuses "not ported"; usage-error message TEXT is argparse's (compared by
 * kind/subcommand/exit code only); global options are the caller's; the
 * checkout switch, rollback, health and `NoChangeRefused` are not ported.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { RecordRefused } from '../../../../src/ops/crq/deploy/controllerRecords.js';
import {
  AdapterBindingRefused,
  runUnitCli,
  type UnitCliDeps,
} from '../../../../src/ops/crq/deploy/unitCli.js';
import { RecoveryRequired } from '../../../../src/ops/crq/deploy/unitTransaction.js';

const NODE = `node:${'a'.repeat(40)}`;
const TICK = 'crq-tick.service';

/** outcome: ok | recovery | refused | value | empty | binding | prepare */
interface Scenario {
  name: string;
  argv: string[];
  outcome?: string;
}
const S = (name: string, argv: string[], outcome = 'ok'): Scenario => ({ name, argv, outcome });
const SW = ['switch', '--unit', TICK, '--runtime', NODE];
const scenarios: Scenario[] = [
  S('switch ok', SW),
  S('switch ok json', ['--json', ...SW]),
  S('switch ok equals form', ['switch', `--unit=${TICK}`, `--runtime=${NODE}`]),
  S('switch recovery', SW, 'recovery'),
  S('switch recovery json', ['--json', ...SW], 'recovery'),
  S('switch refused', SW, 'refused'),
  S('switch value error', SW, 'value'),
  S('switch empty-message error', SW, 'empty'),
  S('switch long message clipped', SW, 'long'),
  S('switch binding refused', SW, 'binding'),
  S('switch prepare refused', SW, 'prepare'),
  S('switch unicode record', SW, 'unicode'),
  S('switch unit only', ['switch', '--unit', TICK], 'ok'),
  S('switch runtime only', ['switch', '--runtime', NODE], 'ok'),
  S('switch with sha', [...SW, '--sha', 'x'], 'ok'),
  S('switch with tag', [...SW, '--tag', 'x'], 'ok'),
  S('switch bare', ['switch'], 'ok'),
  S('switch sha only', ['switch', '--sha', 'x'], 'ok'),
  S('switch tag only', ['switch', '--tag', 'x'], 'ok'),
  S('recover ok', ['recover', '--record', '/r/controller-1.json']),
  S('recover recovery', ['recover', '--record', '/r/c.json'], 'recovery'),
  S('recover refused', ['recover', '--record', '/r/c.json'], 'refused'),
  S('recover binding', ['recover', '--record', '/r/c.json'], 'binding'),
  S('recover value json', ['--json', 'recover', '--record', '/r/c.json'], 'value'),
  S('recover missing record', ['recover'], 'usage'),
  S('switch bad unit', ['switch', '--unit', 'nope.service', '--runtime', NODE], 'usage'),
  S('switch missing value', ['switch', '--unit'], 'usage'),
  S('switch unknown flag', [...SW, '--bogus', '1'], 'usage'),
  S('recover unknown flag', ['recover', '--record', 'x', '--unit', 'y'], 'usage'),
  S('no operation', [], 'usage'),
  S('bad operation json', ['--json', 'frobnicate'], 'usage'),
];

const PY = String.raw`
import importlib.util, io, contextlib, json, sys, types
spec = importlib.util.spec_from_file_location("dc", sys.argv[1])
dc = importlib.util.module_from_spec(spec); sys.modules["dc"] = dc; spec.loader.exec_module(dc)
sc = json.loads(sys.argv[2])
outcome = sc["outcome"]
class Helper:
    def load_overlay(self, p):
        if outcome == "prepare": raise dc.Refused("overlay refused")
        return {}, ""
dc._load_helper = lambda path, sha: (Helper(), "h" * 64)
class FR(Exception): pass
class Live:
    LiveBindingRefused = FR
    factory = types.SimpleNamespace(FactoryRefused=FR)
    completion = types.SimpleNamespace(CompletionError=FR)
    def production_adapter(self, effects, overlay, unit, runtime):
        if outcome == "binding": raise FR("binding refused: " + "x" * 500)
        return object(), None
dc._load_live_binding = lambda: Live()
dc.Effects = lambda root, rd: object()
def result():
    if outcome == "recovery": raise dc.RecoveryRequired({"reason": "r", "unit": "u"})
    if outcome == "refused": raise dc.Refused("nope")
    if outcome == "value": raise ValueError("bad value")
    if outcome == "empty": raise ValueError("")
    if outcome == "long": raise ValueError("é" * 500)
    if outcome == "unicode": return {"z": "é☃", "a": [1, 2.5, None, True], "n": {"b": 1, "a": 2}}
    return {"ok": True, "n": {"b": 1, "a": 2}}
dc.switch_unit = lambda effects, adapter, unit, runtime: result()
def recover(effects, adapter, path, adapter_factory=None):
    if adapter_factory is not None and outcome in ("binding", "ok"):
        adapter_factory("crq-tick.service", "python")
    return result()
dc.recover_unit = recover
out, err = io.StringIO(), io.StringIO()
code = None
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    try:
        code = dc.main(["--root", "/tmp", "--overlay", "/tmp/o", "--record-dir", "/tmp/rd"] + sc["argv"])
    except SystemExit as e:
        code = e.code
print(json.dumps({"code": code, "stdout": out.getvalue(), "stderr": err.getvalue()}))
`;

const stubTransactions = (outcome: string): NonNullable<UnitCliDeps['transactions']> => {
  const result = (): Record<string, unknown> => {
    if (outcome === 'recovery') throw new RecoveryRequired({ reason: 'r', unit: 'u' });
    if (outcome === 'refused') throw new RecordRefused('nope');
    if (outcome === 'value') throw new Error('bad value');
    if (outcome === 'empty') throw Object.assign(new Error(''), { name: 'ValueError' });
    if (outcome === 'long') throw new Error('é'.repeat(500));
    if (outcome === 'unicode') return { z: 'é☃', a: [1, 2.5, null, true], n: { b: 1, a: 2 } };
    return { ok: true, n: { b: 1, a: 2 } };
  };
  return {
    switchUnit: async () => result(),
    recoverUnit: async (_e, _a, _p, factory) => {
      if (factory !== undefined && (outcome === 'binding' || outcome === 'ok')) {
        factory('crq-tick.service', 'python');
      }
      return result();
    },
  };
};

const depsFor = (outcome: string): UnitCliDeps => ({
  effects: {} as never,
  prepare: () => {
    if (outcome === 'prepare') throw new RecordRefused('overlay refused');
  },
  adapterFor: () => {
    if (outcome === 'binding')
      throw new AdapterBindingRefused('binding refused: ' + 'x'.repeat(500));
    return {} as never;
  },
  transactions: stubTransactions(outcome),
});

const MAIN = resolve('apps/crq-python/ops/deploy-controller.py');

function oracle(sc: Scenario): { code: number; stdout: string; stderr: string } {
  const run = spawnSync('python3', ['-I', '-c', PY, MAIN, JSON.stringify(sc)], {
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`oracle failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as { code: number; stdout: string; stderr: string };
}

describe('unit CLI slice differential against deploy-controller.py main', () => {
  const seen = new Set<number>();
  for (const sc of scenarios) {
    test(sc.name, async () => {
      const py = oracle(sc);
      const ts = await runUnitCli(sc.argv, depsFor(sc.outcome ?? 'ok'));
      seen.add(py.code);
      expect(ts.exitCode).toBe(py.code);
      if (sc.outcome === 'usage') {
        const a = JSON.parse(ts.stdout).error;
        const b = JSON.parse(py.stdout).error;
        expect([a.kind, a.subcommand, a.exitCode]).toEqual([b.kind, b.subcommand, b.exitCode]);
        expect(ts.stderr === '').toBe(py.stderr === '');
        return;
      }
      expect(ts.stdout).toBe(py.stdout);
      expect(ts.stderr).toBe(py.stderr);
    });
  }
  test('oracle exercised exit codes 0, 2 and 3', () => {
    expect([...seen].sort()).toEqual([0, 2, 3]);
  });
});
