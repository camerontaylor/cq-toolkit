/**
 * Differential for the unit-transaction guards against the real Python
 * `queue_drain_gate`, `drain_check`, `captured_state` and `preservation_check`
 * in `deploy-controller.py`. Each scenario is materialised twice (one tree per
 * implementation) and both run the same sequence: gate, drain, capture,
 * mutate, preservation check. Results are compared as Python-serialised JSON.
 *
 * Declared divergence: when `queue.json` is missing or not JSON the refusal
 * message ends with the host's `str(exc)` text (`[Errno 2] ...`, `Expecting
 * value: ...`), which the port cannot reproduce. Only the prefix is compared.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseJsonValue } from '../../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../../src/policy/crq/pythonJson.js';
import {
  QueueDrainRefused,
  Refused,
  capturedState,
  drainCheck,
  preservationCheck,
  queueDrainGate,
  type GuardEffects,
} from '../../../../src/ops/crq/deploy/unitGuards.js';

interface Scenario {
  name: string;
  /** queue.json text; null = absent; 'dir' = a directory (unreadable). */
  queue: string | null;
  heartbeat?: string | null;
  config?: string | null;
  exits?: string[];
  /** run_id -> liveness result, `raise:<msg>`, or `echo` (alive iff exit.json). */
  live?: Record<string, string>;
  /** Applied between capture and preservation check. */
  after?: { queue?: string | null; heartbeat?: string | null };
  surfaces?: string[] | null;
  /** Compare only the `str(exc)`-free prefix of an unreadable-queue refusal. */
  tail?: boolean;
}

const UNITS = ['crq-watchdog.service', 'crq-tick.service'];
const RID = 'a1-20261115T010203Z';
const RID2 = 'crq-pr-12-20261115T010203Z';
const items = (...it: unknown[]) => JSON.stringify({ items: it });
const run = (run_id: unknown, id: unknown = 'a') => ({ id, run: { run_id } });

const scenarios: Scenario[] = [
  { name: 'empty items', queue: items() },
  { name: 'no items key', queue: '{}' },
  { name: 'unstarted item', queue: items({ id: 'a' }) },
  { name: 'run null', queue: items({ id: 'a', run: null }) },
  { name: 'run string', queue: items({ id: 7, run: 'x' }) },
  { name: 'run list', queue: items({ id: 7.5, run: [1] }) },
  { name: 'item not object', queue: items('s', 3, null, [1]) },
  { name: 'run id missing', queue: items({ id: 'a', run: {} }) },
  { name: 'run id int', queue: items(run(5)) },
  { name: 'run id long', queue: items(run('a'.repeat(256))) },
  { name: 'run id hex65', queue: items(run('a'.repeat(65))) },
  { name: 'run id non-ascii', queue: items(run('é'.repeat(9))) },
  { name: 'run id trailing newline', queue: items(run(`${RID}\n`)) },
  { name: 'run id hex8', queue: items(run('abcdef01')), live: { abcdef01: 'alive' } },
  { name: 'run id hex7', queue: items(run('abcdef0')) },
  {
    name: 'run id exactly 255',
    queue: items(run(`${'a'.repeat(238)}-20261115T010203Z`)),
    live: { [`${'a'.repeat(238)}-20261115T010203Z`]: 'alive' },
  },
  { name: 'run id 256', queue: items(run(`${'a'.repeat(239)}-20261115T010203Z`)) },
  { name: 'run id uppercase hex', queue: items(run('ABCDEF01')) },
  { name: 'run id dashes', queue: items(run('--------')), live: { '--------': 'alive' } },
  { name: 'alive', queue: items(run(RID)), live: { [RID]: 'alive' } },
  { name: 'ambiguous', queue: items(run(RID, 'z')), live: { [RID]: 'ambiguous' } },
  { name: 'harvest', queue: items(run(RID)), live: { [RID]: 'harvest' } },
  { name: 'odd state', queue: items(run(RID)), live: { [RID]: 'weird' } },
  { name: 'probe raises', queue: items(run(RID, 'k')), live: { [RID]: 'raise:boom é' } },
  {
    name: 'probe raises long',
    queue: items(run(RID, 'k')),
    live: { [RID]: `raise:${'é'.repeat(130)}` },
  },
  { name: 'exit echo', queue: items(run(RID)), live: { [RID]: 'echo' }, exits: [RID] },
  { name: 'no exit echo', queue: items(run(RID)), live: { [RID]: 'echo' } },
  {
    name: 'two blocked + mixed',
    queue: items(run(RID, 'one'), { id: 'skip' }, run(RID2, { z: 1, a: [1.5, null] })),
    live: { [RID]: 'alive', [RID2]: 'ambiguous' },
  },
  {
    name: 'gate message truncates at 400 code points',
    queue: items(...Array.from({ length: 30 }, (_, i) => run(RID, `é-${i}-${'x'.repeat(20)}`))),
    live: { [RID]: 'alive' },
  },
  {
    name: 'id int and float',
    queue: items(run(RID, 12345678), run(RID2, 7.5)),
    live: { [RID]: 'alive', [RID2]: 'alive' },
  },
  { name: 'root list', queue: '[]' },
  { name: 'root null', queue: 'null' },
  { name: 'root string', queue: '"s"' },
  { name: 'root bool', queue: 'true' },
  { name: 'root int', queue: '3' },
  { name: 'root float', queue: '3.5' },
  { name: 'items null', queue: '{"items": null}' },
  { name: 'items dict', queue: '{"items": {}}' },
  { name: 'queue missing', queue: null, tail: true },
  { name: 'queue invalid json', queue: '{', tail: true },
  { name: 'queue is a directory', queue: 'dir', tail: true },
  {
    name: 'preserved unchanged',
    queue: items(),
    heartbeat: '{"t":1}',
    config: '{"c":1}',
  },
  { name: 'queue changed', queue: items(), after: { queue: items({ id: 'n' }) } },
  { name: 'heartbeat created', queue: items(), after: { heartbeat: '{"t":2}' } },
  { name: 'heartbeat removed', queue: items(), heartbeat: '{}', after: { heartbeat: null } },
  {
    name: 'both changed',
    queue: items(),
    heartbeat: '{}',
    after: { queue: items({ id: 'q' }), heartbeat: '{"x":1}' },
  },
  {
    name: 'only queue scope',
    queue: items(),
    after: { heartbeat: '{"x":1}' },
    surfaces: ['queue.json'],
  },
  {
    name: 'only heartbeat scope',
    queue: items(),
    after: { queue: items({ id: 'q' }) },
    surfaces: ['heartbeat.json'],
  },
  {
    name: 'empty scope ignores change',
    queue: items(),
    after: { queue: items({ id: 'q' }), heartbeat: '{"x":1}' },
    surfaces: [],
  },
  {
    name: 'queue vanishes after capture',
    queue: items(),
    after: { queue: null },
    tail: true,
  },
];

const controller = resolve('apps/crq-python/ops/deploy-controller.py');
const probe = spawnSync(
  'python3',
  ['-I', '-c', 'import sys; print(sys.version_info[:2] >= (3, 10))'],
  { encoding: 'utf8' },
);
const haveOracle = probe.status === 0 && probe.stdout.trim() === 'True';

const GIT: Record<string, string> = {
  'rev-parse HEAD': 'a'.repeat(40) + '\n',
  'status --porcelain --untracked-files=all': ' M x\n',
};
const UNIT_DIGESTS = { 'crq-tick.service': 'd1', 'crq-watchdog.service': null };

function put(path: string, text: string | null | undefined): void {
  if (text === undefined) return;
  if (text === null) {
    rmSync(path, { force: true });
    return;
  }
  if (text === 'dir') {
    mkdirSync(path, { recursive: true });
    return;
  }
  writeFileSync(path, text);
}

function materialise(root: string, sc: Scenario): void {
  mkdirSync(join(root, 'state', 'runs'), { recursive: true });
  put(join(root, 'state', 'queue.json'), sc.queue);
  put(join(root, 'hb.json'), sc.heartbeat);
  put(join(root, 'config.json'), sc.config);
  for (const id of sc.exits ?? []) {
    mkdirSync(join(root, 'state', 'runs', id), { recursive: true });
    writeFileSync(join(root, 'state', 'runs', id, 'exit.json'), '{}');
  }
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(sc));
}

function applyAfter(root: string, sc: Scenario): void {
  if (sc.after === undefined) return;
  if ('queue' in sc.after) put(join(root, 'state', 'queue.json'), sc.after.queue);
  if ('heartbeat' in sc.after) put(join(root, 'hb.json'), sc.after.heartbeat);
}

const PY = `
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location("dc", sys.argv[1])
dc = importlib.util.module_from_spec(spec); sys.modules["dc"] = dc; spec.loader.exec_module(dc)
UNITS = json.loads(sys.argv[2])
GIT = json.loads(sys.argv[3])
UD = json.loads(sys.argv[4])
def call(fn):
    try:
        return {"ok": fn()}
    except dc.QueueDrainRefused as e:
        return {"qdr": str(e), "drain": e.drain}
    except dc.Refused as e:
        return {"refused": str(e)}
    except Exception:
        return {"raised": True}
out = []
for d in sys.argv[5:]:
    root = pathlib.Path(d)
    sc = json.loads((root / "scenario.json").read_text())
    state = root / "state"
    eff = types.SimpleNamespace(
        root=root, state_dir=lambda s=state: s,
        completion_heartbeat_path=lambda r=root: r / "hb.json",
        config_path=root / "config.json",
        read_json=lambda rel, s=state: json.loads((s / rel).read_text()),
        git=lambda *a: GIT[" ".join(a)], unit_digests=lambda: UD)
    live_map = sc.get("live", {})
    def live(rdir, item, r, has_exit, m=live_map):
        v = m.get(r["run_id"], "harvest")
        if v.startswith("raise:"):
            raise OSError(v[6:])
        if v == "echo":
            return "alive" if has_exit else "harvest"
        return v
    dc._runner_liveness = lambda e, l=live: l
    res = {}
    for unit in UNITS:
        r = {}
        r["gate"] = call(lambda: dc.queue_drain_gate(eff, unit))
        r["drain"] = call(lambda: dc.drain_check(eff, live))
        cap = call(lambda: dc.captured_state(eff, unit))
        r["captured"] = cap
        r["captured_all"] = call(lambda: dc.captured_state(eff))
        if "ok" in cap:
            after = sc.get("after")
            if after:
                if "queue" in after:
                    p = state / "queue.json"
                    if after["queue"] is None: p.unlink(missing_ok=True)
                    else: p.write_text(after["queue"])
                if "heartbeat" in after:
                    p = root / "hb.json"
                    if after["heartbeat"] is None: p.unlink(missing_ok=True)
                    else: p.write_text(after["heartbeat"])
            surf = sc.get("surfaces", "all")
            r["check"] = call(lambda: dc.preservation_check(
                eff, cap["ok"], None if surf == "all" or surf is None else surf))
        res[unit] = r
    out.append(res)
print(json.dumps(out, sort_keys=True))
`;

function sha(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function effectsFor(root: string): GuardEffects {
  const state = join(root, 'state');
  const surface = (rel: string) =>
    rel === 'heartbeat.json' ? join(root, 'hb.json') : join(state, rel);
  return {
    git: (...args) => GIT[args.join(' ')] ?? '',
    configSha256: () => {
      try {
        return createHash('sha256')
          .update(readFileSync(join(root, 'config.json')))
          .digest('hex');
      } catch {
        return null;
      }
    },
    preservedDigest: (rel) => sha(surface(rel)),
    unitDigests: () => UNIT_DIGESTS,
    readQueueJson: () => parseJsonValue(readFileSync(join(state, 'queue.json'), 'utf8')),
    exitExists: (runId) => existsSync(join(state, 'runs', runId, 'exit.json')),
  };
}

type Out = Record<string, unknown>;

async function call(fn: () => Promise<unknown>): Promise<Out> {
  try {
    return { ok: await fn() };
  } catch (error) {
    if (error instanceof QueueDrainRefused) {
      return { qdr: error.message, drain: error.drain };
    }
    if (error instanceof Refused) return { refused: error.message };
    return { raised: true };
  }
}

async function tsRun(root: string, sc: Scenario): Promise<Record<string, Out>> {
  const effects = effectsFor(root);
  const live = (runId: string, _item: unknown, _run: unknown, hasExit: boolean): string => {
    const v = sc.live?.[runId] ?? 'harvest';
    if (v.startsWith('raise:')) throw new Error(v.slice(6));
    if (v === 'echo') return hasExit ? 'alive' : 'harvest';
    return v;
  };
  const res: Record<string, Out> = {};
  for (const unit of UNITS) {
    const r: Out = {};
    r['gate'] = await call(() => queueDrainGate(effects, unit, live));
    r['drain'] = await call(() => drainCheck(effects, live));
    const cap = await call(() => capturedState(effects, unit));
    r['captured'] = cap;
    r['captured_all'] = await call(() => capturedState(effects));
    if ('ok' in cap) {
      applyAfter(root, sc);
      const surf = sc.surfaces === undefined || sc.surfaces === null ? undefined : sc.surfaces;
      r['check'] = await call(() =>
        preservationCheck(effects, cap['ok'] as Record<string, unknown>, surf),
      );
    }
    res[unit] = r;
  }
  return res;
}

const dump = (value: unknown): string =>
  pythonJsonText(value, { sortKeys: true, asciiOnly: true, spacedSeparators: true });

const TAIL = /(queue unreadable, refusing to reason about drain: ).*?(")/g;
const norm = (text: string, tail: boolean | undefined): string =>
  tail === true ? text.replace(TAIL, '$1…$2') : text;

describe.skipIf(!haveOracle)('unit guards match deploy-controller.py', () => {
  const base = mkdtempSync(join(tmpdir(), 'unit-guards-'));
  const pyDirs = scenarios.map((sc, i) => {
    const dir = join(base, `py-${i}`);
    mkdirSync(dir);
    materialise(dir, sc);
    return dir;
  });
  const python = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      PY,
      controller,
      JSON.stringify(UNITS),
      JSON.stringify(GIT),
      JSON.stringify(UNIT_DIGESTS),
      ...pyDirs,
    ],
    { encoding: 'utf8' },
  );
  if (python.status !== 0) throw new Error(`oracle failed: ${python.stderr}`);
  const expected = JSON.parse(python.stdout) as Record<string, Record<string, unknown>>[];

  scenarios.forEach((sc, i) => {
    test(sc.name, async () => {
      const dir = join(base, `ts-${i}`);
      mkdirSync(dir);
      materialise(dir, sc);
      const actual = await tsRun(dir, sc);
      expect(norm(dump(actual), sc.tail)).toBe(norm(dump(expected[i]), sc.tail));
    });
  });

  test('queue-unreadable text is clipped to 160 code points', async () => {
    const dir = join(base, 'clip');
    mkdirSync(dir);
    materialise(dir, { name: 'clip', queue: items() });
    const effects = {
      ...effectsFor(dir),
      readQueueJson: () => {
        throw new Error('é'.repeat(200));
      },
    };
    const err = await drainCheck(effects, () => 'harvest').then(
      () => new Error('no refusal'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toBe(
      `queue unreadable, refusing to reason about drain: ${'é'.repeat(160)}`,
    );
  });

  test('oracle exercised every refusal and success path', () => {
    const text = JSON.stringify(expected);
    for (const needle of [
      '"qdr"',
      '"refused"',
      '"raised"',
      '"ok"',
      'malformed run id',
      'malformed recorded run metadata',
      'malformed queue item',
      'liveness probe failed',
      'preserved surfaces changed',
      '"applicable": false',
    ]) {
      expect(text).toContain(needle.replace('": ', '":'));
    }
  });
});
