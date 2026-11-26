// Differential run of the worker process boundary: Python's real forking `drain_items`
// (test/helpers/repairWorkerOracle.py, Python 3.14 pinned) against `drainItems` over real
// spawned workers. Each case is run through Python first; the bytes each Python child
// wrote on its private pipe then script the stub worker, and the forked-item order, the
// returned failures and the coordinator narration must be equal. Every child exits on its
// own; the one signal is a scripted self-SIGKILL.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import {
  fileRepairWorkerStarter,
  ownedWorkerCount,
} from '../../../src/adapters/crq/repairWorkerProcess.js';
import { drainItems, type RepairDrainEffects } from '../../../src/ops/crq/internal/repairDrain.js';

const ORACLE = fileURLToPath(new URL('../../helpers/repairWorkerOracle.py', import.meta.url));
const STUB = fileURLToPath(new URL('../../helpers/repairWorkerStub.mjs', import.meta.url));
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));

function oraclePython(): string {
  for (const name of ['python3.14', 'python3']) {
    const probe = spawnSync(name, ['-c', 'import sys; print(sys.version_info[:2] == (3, 14))'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === 'True') return name;
  }
  throw new Error('the worker parity oracle needs Python 3.14 (python3.14, or python3 at 3.14)');
}
const PYTHON = oraclePython();

interface PyScenario {
  outcome?: 'rate-limit' | 'runner-disabled';
  crash?: 'exit9' | 'signal' | 'raise';
  gate?: 'refuse';
  waitFor?: string;
}
interface Case {
  name: string;
  order: string[];
  limit: number;
  marker?: boolean;
  scenarios?: Record<string, PyScenario>;
}
interface PyResult {
  failures: string[];
  forked: string[];
  bytes: Record<string, string>;
  narration: string[];
  error: string | null;
}

/** What the child of each Python scenario exits with (the narration comparison proves the mapping). */
function exitOf(spec: PyScenario): { exit?: number; signal?: string } {
  if (spec.crash === 'exit9') return { exit: 9 };
  if (spec.crash === 'signal') return { signal: 'SIGKILL' };
  if (spec.crash === 'raise') return { exit: 1 };
  if (spec.gate === 'refuse') return { exit: 3 };
  if (spec.outcome === 'rate-limit') return { exit: 2 };
  if (spec.outcome === 'runner-disabled') return { exit: 3 };
  return { exit: 0 };
}

const CASES: Case[] = [
  { name: 'clean pass, six items, limit 3', order: ['a', 'b', 'c', 'd', 'e', 'f'], limit: 3 },
  {
    name: 'rate limit stops new admission',
    order: ['a', 'b', 'c'],
    limit: 2,
    scenarios: { a: { outcome: 'rate-limit' } },
  },
  {
    name: 'a crashed worker is a failure',
    order: ['a', 'b'],
    limit: 2,
    scenarios: { b: { crash: 'exit9' } },
  },
  {
    name: 'a crash stops admission while another worker is held',
    order: ['a', 'b', 'c'],
    limit: 2,
    scenarios: {
      a: { waitFor: 'repair item b: worker exited with code 9' },
      b: { crash: 'exit9' },
    },
  },
  {
    name: 'the runner marker forks nothing',
    order: ['a', 'b'],
    limit: 2,
    marker: true,
  },
  {
    name: 'death by signal is a failure',
    order: ['a', 'b'],
    limit: 2,
    scenarios: { a: { crash: 'signal' } },
  },
  {
    name: 'a raised worker exits 1 and is a failure',
    order: ['a', 'b'],
    limit: 2,
    scenarios: { a: { crash: 'raise' } },
  },
  {
    name: 'a child-gate refusal is not a failure',
    order: ['a', 'b'],
    limit: 2,
    scenarios: { a: { gate: 'refuse' } },
  },
];

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function runPython(cases: Case[]): PyResult[] {
  const run = spawnSync('nice', ['-n', '5', PYTHON, '-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (run.status !== 0) throw new Error(`oracle failed: ${run.stderr.slice(0, 600)}`);
  return (JSON.parse(run.stdout) as { results: PyResult[] }).results;
}

async function runTs(
  spec: Case,
  py: PyResult,
): Promise<{ failures: string[]; forked: string[]; narration: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'repair-worker-parity-'));
  dirs.push(dir);
  const release = join(dir, 'release');
  const scenarios: Record<string, unknown> = {};
  for (const item of spec.order) {
    const scripted = spec.scenarios?.[item] ?? {};
    scenarios[item] = {
      publish: [...(py.bytes[item] ?? '')],
      ...exitOf(scripted),
      ...(scripted.waitFor ? { holdUntil: release } : {}),
    };
  }
  const waits = Object.values(spec.scenarios ?? {}).flatMap((s) => (s.waitFor ? [s.waitFor] : []));
  const base = fileRepairWorkerStarter({
    stateRoot: dir,
    clone: join(dir, 'clone'),
    configText: JSON.stringify(scenarios),
    launch: { entry: STUB },
  });
  const said: string[] = [];
  const forked: string[] = [];
  const effects = {
    runnerDisabled: async () => spec.marker === true,
    narrate: (message: string) => {
      said.push(message);
      if (waits.some((w) => message.includes(w))) writeFileSync(release, '');
    },
    maxConcurrentItems: async () => undefined,
    dispatchPaused: async () => null,
    blocked: () => false,
    withAdmissionLock: async <T>(admission: () => Promise<T>) => admission(),
    startWorker: (item: string, ids: string[]) => {
      forked.push(item);
      return base(item, ids);
    },
  } as unknown as RepairDrainEffects;
  const groups = new Map(spec.order.map((item) => [item, [`${item}-job`]]));
  const failures = await drainItems(effects, groups, spec.order, spec.limit);
  return { failures, forked, narration: said };
}

describe('startWorker parity with the forking drain_items', () => {
  const results = runPython(CASES);

  CASES.forEach((spec, index) => {
    test(spec.name, async () => {
      const py = results[index];
      if (!py) throw new Error('missing oracle result');
      expect(py.error).toBeNull();
      const ts = await runTs(spec, py);
      expect(ts.forked).toEqual(py.forked);
      expect([...ts.failures].sort()).toEqual([...py.failures].sort());
      expect([...ts.narration].sort()).toEqual([...py.narration].sort());
      expect(ownedWorkerCount()).toBe(0);
    });
  });

  test('anchors: the Python results are the ones the table claims', () => {
    expect(results[0]?.failures).toEqual([]);
    expect(results[2]?.failures).toEqual(['b']);
    expect(results[3]?.forked).toEqual(['a', 'b']);
    expect(results[4]?.forked).toEqual([]);
    expect(results[5]?.failures).toEqual(['a']);
    expect(results[6]?.failures).toEqual(['a']);
    expect(results[7]?.bytes.a).toBe('x');
    expect(results[7]?.failures).toEqual([]);
  });
});
