import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runComposedShadow,
  type ExplainedDivergence,
} from '../../../src/adapters/crq/shadowRun.js';
import {
  offlineClone,
  runnerCheckout,
  runComposedTs,
  type ComposedSpec,
} from '../../helpers/composedTickShadowTs.js';

const REPO = resolve(import.meta.dirname, '../../..');
const ORACLE = join(REPO, 'test/helpers/composedTickShadowOracle.py');
const NOW = '2027-01-15T08:00:00Z';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'composed-shadow-'));

const spec = (over: Partial<ComposedSpec> = {}): ComposedSpec => {
  const base = {
    clone: offlineClone(),
    config: {
      schedule_id: null,
      merged_discovery: { enabled: false },
      alerts: { alert_agent_id: 'a' },
      repos: [],
    },
    ...over,
  };
  const runnerRoot = runnerCheckout(REPO, base);
  return { now: NOW, runnerRoot, rootField: tmp(), home: tmp(), ...base };
};

function live(queue: unknown): string {
  const dir = tmp();
  writeFileSync(join(dir, 'queue.json'), JSON.stringify(queue));
  return dir;
}

const python = (s: ComposedSpec) => async (root: string) => {
  // Python's summary reads `<ROOT>/state/events.jsonl`; in production ROOT/state is the state root,
  // so the oracle's ROOT directory carries a `state` link to this run's frozen copy.
  symlinkSync(root, join(s.rootField, 'state'));
  const out = execFileSync('python3', ['-I', ORACLE, join(REPO, 'apps/crq-python')], {
    input: JSON.stringify({ root, spec: s }),
    encoding: 'utf8',
  });
  return JSON.parse(out) as { log: string[]; phaseCalls: string[] };
};

async function shadow(
  queue: unknown,
  over: Partial<ComposedSpec> = {},
  allowList: readonly ExplainedDivergence[] = [],
) {
  const s = spec(over);
  const liveRoot = live(queue);
  const scratch = tmp();
  const result = await runComposedShadow({
    liveRoot,
    scratch,
    pinnedAt: NOW,
    sample: 'probe',
    allowList,
    python: python(s),
    ts: (root) => runComposedTs(REPO, root, s),
  });
  return { result, scratch };
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  repo: 'o/r',
  kind: 'open',
  state: 'done',
  cycles: [{ run_id: 'r-legacy', findings: 3 }],
  ...over,
});

/** Queue states the live host is sampled in. */
const SEEDS: readonly (readonly [string, Record<string, unknown>, Partial<ComposedSpec>?])[] = [
  [
    'legacy cycle with a tick gap',
    { items: [item()], starts: [], last_tick: '2027-01-15T07:00:00Z' },
  ],
  ['empty queue', { items: [], starts: [], last_tick: '2027-01-15T07:55:00Z' }],
  [
    'paused',
    {
      items: [item({ state: 'pending', cycles: [] })],
      starts: [],
      paused: true,
      last_tick: '2027-01-15T07:55:00Z',
    },
  ],
  [
    'quota cooldown',
    {
      items: [item({ state: 'pending', cycles: [] })],
      starts: [],
      cooldown_until: '2027-01-15T09:00:00Z',
      last_tick: '2027-01-15T07:55:00Z',
    },
  ],
  [
    'hourly cap reached',
    {
      items: [item({ state: 'pending', cycles: [] })],
      starts: Array(5).fill('2027-01-15T07:40:00Z'),
      last_tick: '2027-01-15T07:55:00Z',
    },
  ],
  [
    'two repos, mixed states',
    {
      items: [
        item({ id: 'a', state: 'pending', cycles: [] }),
        item({ id: 'b', repo: 'o/s', state: 'failed', last_error: 'x' }),
      ],
      starts: [],
      last_tick: '2027-01-15T07:55:00Z',
    },
  ],
  [
    'dry run',
    {
      items: [item({ state: 'pending', cycles: [] })],
      starts: [],
      last_tick: '2027-01-15T07:55:00Z',
    },
    { dry: true },
  ],
];

describe('composed tick shadow: Python crq.tick vs the TS composed tick', () => {
  for (const [name, queue, over] of SEEDS)
    it(`is identical on ${name}`, async () => {
      const { result } = await shadow(queue, over);
      expect(result.report.diff).toMatchObject({
        queue: 'same',
        heartbeat: 'same',
        phaseCalls: 'same',
        composed: {
          files: { 'status.json': 'same', 'status.md': 'same', 'next-review-at': 'same' },
          log: 'same',
        },
      });
      expect(result.report.class).toBe('identical');
    });

  it('never reports complete: exactly the four open rows stay', async () => {
    const { result } = await shadow(SEEDS[0]![1]);
    expect(result.complete).toBe(false);
    expect(result.openRows).toEqual([
      'harvest-review-effects',
      'repair-harvest-effects',
      'start-one-effects',
      'shadow-d2',
    ]);
    expect(result.openRows).toHaveLength(4);
  });

  // Found by this shadow: Python's `load_queue` retires a pending `open` item that already has a
  // completed cycle and the tick persists it; the TS composition plans the retirement but the
  // queue it persists keeps the item pending. The divergence is explained, not fixed here.
  // Allowed: `queue.json` and the two status files that render the retired item (its state,
  // `not_before`, `last_error` and the pending counters). Everything else must match exactly.
  const retirementOnly: ExplainedDivergence = {
    id: 'load-queue-retirement-not-persisted',
    explains: (d) =>
      d.queue === 'differs' &&
      d.events.verdict === 'same' &&
      d.heartbeat === 'same' &&
      d.phaseCalls === 'same' &&
      d.slotDecision === 'same' &&
      d.composed?.log === 'same' &&
      d.composed.files['next-review-at'] === 'same',
  };
  const retirementQueue = {
    items: [item({ state: 'pending' })],
    starts: [],
    last_tick: '2027-01-15T07:55:00Z',
  };

  it('records the unpersisted superseded-open retirement as an explained divergence', async () => {
    const unexplained = await shadow(retirementQueue);
    expect(unexplained.result.report.class).toBe('unexplained');
    expect(unexplained.result.report.diff?.queue).toBe('differs');
    const explained = await shadow(retirementQueue, {}, [retirementOnly]);
    expect(explained.result.report.class).toBe('explained');
  });

  const retirementWith = (mutate: (root: string) => void, extra: Partial<ComposedSpec> = {}) => {
    const s = spec(extra);
    return runComposedShadow({
      liveRoot: live(retirementQueue),
      scratch: tmp(),
      pinnedAt: NOW,
      sample: 'retirement',
      allowList: [retirementOnly],
      python: python(s),
      ts: async (root) => {
        const out = await runComposedTs(REPO, root, s);
        mutate(root);
        return out;
      },
    });
  };

  it('does not let the retirement allow-list hide other drift on that sample', async () => {
    for (const mutate of [
      (root: string) => writeFileSync(join(root, 'next-review-at'), 'x'),
      (root: string) => appendFileSync(join(root, 'events.jsonl'), '{"at":"x","event":"x"}\n'),
      (root: string) => writeFileSync(join(root, 'heartbeat.json'), '{}'),
    ]) {
      expect((await retirementWith(mutate)).report.class).toBe('unexplained');
    }
    const logDrift = spec();
    const { report } = await runComposedShadow({
      liveRoot: live(retirementQueue),
      scratch: tmp(),
      pinnedAt: NOW,
      sample: 'retirement-log',
      allowList: [retirementOnly],
      python: python(logDrift),
      ts: async (root) => {
        const out = await runComposedTs(REPO, root, logDrift);
        return { ...out, log: [...out.log, 'extra'] };
      },
    });
    expect(report.class).toBe('unexplained');
  });

  // Counterfactuals: each corrupts one TS-side artefact after a correct run.
  const tamper = (mutate: (root: string) => void, over: Partial<ComposedSpec> = {}) => {
    const s = spec(over);
    return runComposedShadow({
      liveRoot: live(SEEDS[0]![1]),
      scratch: tmp(),
      pinnedAt: NOW,
      sample: 'tamper',
      python: python(s),
      ts: async (root) => {
        const out = await runComposedTs(REPO, root, s);
        mutate(root);
        return out;
      },
    });
  };

  it('catches a composed-phase difference while the plan matches (status.md only)', async () => {
    const { report } = await tamper((root) => appendFileSync(join(root, 'status.md'), '\n'));
    expect(report.class).toBe('unexplained');
    expect(report.diff).toMatchObject({
      queue: 'same',
      heartbeat: 'same',
      phaseCalls: 'same',
      composed: { files: { 'status.md': 'differs', 'status.json': 'same' }, log: 'same' },
    });
  });

  it('catches a status.json key-order drift that is value-equal (byte compare)', async () => {
    const { report } = await tamper((root) => {
      const doc = JSON.parse(readFileSync(join(root, 'status.json'), 'utf8')) as {
        items: Record<string, unknown>[];
      };
      doc.items = doc.items.map(({ repo, ...rest }) => ({ repo, ...rest }));
      writeFileSync(join(root, 'status.json'), `${JSON.stringify(doc, null, 2)}\n`);
    });
    expect(report.diff?.composed?.files['status.json']).toBe('differs');
  });

  it('catches a different next-review-at', async () => {
    const { report } = await tamper((root) => writeFileSync(join(root, 'next-review-at'), 'x'));
    expect(report.diff?.composed?.files['next-review-at']).toBe('differs');
  });

  it('catches a different tick log', async () => {
    const s = spec();
    const { report } = await runComposedShadow({
      liveRoot: live(SEEDS[0]![1]),
      scratch: tmp(),
      pinnedAt: NOW,
      sample: 'log',
      python: python(s),
      ts: async (root) => {
        const out = await runComposedTs(REPO, root, s);
        return { ...out, log: [...out.log, 'extra'] };
      },
    });
    expect(report.diff?.composed?.log).toBe('differs');
  });

  it('aborts the sample when the live root changes under the run', async () => {
    const s = spec();
    const liveRoot = live(SEEDS[0]![1]);
    const { report } = await runComposedShadow({
      liveRoot,
      scratch: tmp(),
      pinnedAt: NOW,
      sample: 'abort',
      python: python(s),
      ts: async (root) => {
        const out = await runComposedTs(REPO, root, s);
        appendFileSync(join(liveRoot, 'queue.json'), ' ');
        return out;
      },
    });
    expect(report.class).toBe('aborted');
  });

  it('is not satisfied by an explained-divergence allow-list that does not match', async () => {
    const { report } = await tamper((root) => appendFileSync(join(root, 'status.md'), '\n'));
    expect(report.class).not.toBe('identical');
  });
});
