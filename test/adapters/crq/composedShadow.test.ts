import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
  allowList:
    | readonly ExplainedDivergence[]
    | ((scratch: string) => readonly ExplainedDivergence[]) = [],
) {
  const s = spec(over);
  const liveRoot = live(queue);
  const scratch = tmp();
  const result = await runComposedShadow({
    liveRoot,
    scratch,
    pinnedAt: NOW,
    sample: 'probe',
    allowList: typeof allowList === 'function' ? allowList(scratch) : allowList,
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

  // The tick-gap sample alerts agent `a`, so it reaches notifyOwner. composeFullTick binds the real
  // `paseo send`; the helper must replace it, recording the call as Python's stub does. A fake
  // `paseo` first on PATH leaves a marker if anything ever spawns it.
  it('never spawns paseo on the tick-gap sample and records notify_owner on both sides', async () => {
    const bin = tmp();
    const marker = join(bin, 'spawned');
    writeFileSync(join(bin, 'paseo'), `#!/bin/sh\necho spawned > '${marker}'\n`);
    chmodSync(join(bin, 'paseo'), 0o755);
    const saved = { PATH: process.env.PATH, PASEO_HOST: process.env.PASEO_HOST };
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.PASEO_HOST = 'real-daemon.invalid';
    try {
      const s = spec();
      const ts = await runComposedTs(REPO, live(SEEDS[0]![1]), s);
      expect(ts.phaseCalls).toContain('notify_owner');
      const { result } = await shadow(SEEDS[0]![1]);
      expect(result.report.diff?.phaseCalls).toBe('same');
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.PASEO_HOST === undefined) delete process.env.PASEO_HOST;
      else process.env.PASEO_HOST = saved.PASEO_HOST;
    }
    expect(existsSync(marker)).toBe(false);
  });

  // Default-deny: every entry the freeze does not copy is refused, so a phase that would read it
  // cannot run switched off on both sides and still read `identical`. One test per name.
  const refuse = async (plant: (liveRoot: string) => void, shown: string) => {
    const liveRoot = live(SEEDS[0]![1]);
    plant(liveRoot);
    const s = spec();
    await expect(
      runComposedShadow({
        liveRoot,
        scratch: tmp(),
        pinnedAt: NOW,
        sample: 'unfrozen',
        python: python(s),
        ts: (root) => runComposedTs(REPO, root, s),
      }),
    ).rejects.toThrow(`does not freeze: ${shown}`);
  };
  for (const name of [
    'backfill-rollout.json',
    'ledger',
    'runs',
    'receipts',
    'reconcile',
    'backfill',
  ])
    it(`refuses a live root holding ${name}`, () =>
      refuse(
        (root) =>
          name.includes('.') ? writeFileSync(join(root, name), '{}') : mkdirSync(join(root, name)),
        name,
      ));

  it('refuses backfill/findings planted below a backfill directory', () =>
    refuse(
      (root) => mkdirSync(join(root, 'backfill', 'findings'), { recursive: true }),
      'backfill',
    ));

  it('refuses an entry no phase is known to read yet (default-deny)', () =>
    refuse((root) => writeFileSync(join(root, 'something-new.json'), '{}'), 'something-new.json'));

  it('names every refused entry, sorted', () =>
    refuse((root) => {
      mkdirSync(join(root, 'runs'));
      mkdirSync(join(root, 'receipts'));
    }, 'receipts, runs'));

  it('two runs over one scratch: run 2 starts both copies without run 1 leftovers', async () => {
    const scratch = tmp();
    const strays = (root: string): string[] =>
      ['receipts', 'runs', 'ledger', 'reconcile'].filter((n) => existsSync(join(root, n)));
    const seen: Record<string, string[]> = {};
    const run = async (leave: boolean) => {
      const s = spec();
      const py = python(s);
      return runComposedShadow({
        liveRoot: live(SEEDS[0]![1]),
        scratch,
        pinnedAt: NOW,
        sample: 'two-runs',
        python: async (root) => {
          seen.a = strays(root);
          return py(root);
        },
        ts: async (root) => {
          seen.b = strays(root);
          const out = await runComposedTs(REPO, root, s);
          if (leave) for (const n of ['receipts', 'runs']) mkdirSync(join(root, n));
          return out;
        },
      });
    };
    expect((await run(true)).report.class).toBe('identical');
    expect((await run(false)).report.class).toBe('identical');
    expect(seen).toEqual({ a: [], b: [] });
  });

  // The scratch clearing must never reach live state or a foreign directory: each case refuses and
  // leaves the target intact.
  const guarded = async (
    arrange: (scratch: string, liveRoot: string) => { liveRoot: string; intact: string[] },
    message: string,
  ) => {
    const scratch = tmp();
    const liveRoot = live(SEEDS[0]![1]);
    const { liveRoot: used, intact } = arrange(scratch, liveRoot);
    const s = spec();
    await expect(
      runComposedShadow({
        liveRoot: used,
        scratch,
        pinnedAt: NOW,
        sample: 'guard',
        python: python(s),
        ts: (root) => runComposedTs(REPO, root, s),
      }),
    ).rejects.toThrow(message);
    for (const path of intact) expect(existsSync(path)).toBe(true);
  };

  it('refuses a live root nested under a scratch copy, and does not delete it', () =>
    guarded((scratch) => {
      const nested = join(scratch, 'a', 'live-state');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'queue.json'), JSON.stringify(SEEDS[0]![1]));
      return { liveRoot: nested, intact: [join(nested, 'queue.json')] };
    }, 'overlaps the live root'));

  it('refuses a scratch copy linked to the live root parent, and does not delete it', () =>
    guarded((scratch, liveRoot) => {
      symlinkSync(join(liveRoot, '..'), join(scratch, 'a'));
      return { liveRoot, intact: [join(liveRoot, 'queue.json')] };
    }, 'overlaps the live root'));

  it('refuses a scratch copy linked to an unrelated directory, and does not clear it', () =>
    guarded((scratch, liveRoot) => {
      const victim = tmp();
      mkdirSync(join(victim, 'receipts'));
      writeFileSync(join(victim, 'notes.md'), 'keep');
      symlinkSync(victim, join(scratch, 'b'));
      return { liveRoot, intact: [join(victim, 'receipts'), join(victim, 'notes.md')] };
    }, 'is a symbolic link'));

  it('clears the overwritten outputs a run left in both copies', async () => {
    const scratch = tmp();
    const seen: Record<string, boolean> = {};
    const run = async (leave: boolean) => {
      const s = spec();
      const py = python(s);
      return runComposedShadow({
        liveRoot: live(SEEDS[0]![1]),
        scratch,
        pinnedAt: NOW,
        sample: 'outputs-reused',
        python: async (root) => {
          seen.a = existsSync(join(root, 'tick.lock'));
          return py(root);
        },
        ts: async (root) => {
          seen.b = existsSync(join(root, 'tick.lock'));
          const out = await runComposedTs(REPO, root, s);
          if (leave) writeFileSync(join(root, 'tick.lock'), 'stale');
          return out;
        },
      });
    };
    await run(true);
    expect((await run(false)).report.class).toBe('identical');
    expect(seen).toEqual({ a: false, b: false });
  });

  it('accepts the outputs the tick overwrites without reading', async () => {
    const liveRoot = live(SEEDS[0]![1]);
    for (const name of ['status.json', 'status.md', 'next-review-at', 'tick.lock'])
      writeFileSync(join(liveRoot, name), 'stale');
    const s = spec();
    const { report } = await runComposedShadow({
      liveRoot,
      scratch: tmp(),
      pinnedAt: NOW,
      sample: 'outputs',
      python: python(s),
      ts: (root) => runComposedTs(REPO, root, s),
    });
    expect(report.class).toBe('identical');
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
  // The expected delta is derived, not assumed: the TS copy with the retirement applied must equal
  // the Python copy by value (queue) or by bytes (status.json, status.md), and each of the three
  // must actually differ. What the retirement changes: the item's state (`pending` -> `done`) and the `idle_while_pending_24h` counter that derives from it,
  // the `not_before`/`last_error` keys Python adds, and the coverage observation's `pending` flag.
  const retirementOnly = (scratch: string): ExplainedDivergence => ({
    id: 'load-queue-retirement-not-persisted',
    explains: (d) => {
      if (
        d.queue !== 'differs' ||
        d.events.verdict !== 'same' ||
        d.heartbeat !== 'same' ||
        d.phaseCalls !== 'same' ||
        d.slotDecision !== 'same' ||
        d.composed?.log !== 'same' ||
        d.composed.files['next-review-at'] !== 'same' ||
        d.composed.files['status.json'] !== 'differs' ||
        d.composed.files['status.md'] !== 'differs'
      )
        return false;
      const read = (side: string, name: string): string | null => {
        try {
          return readFileSync(join(scratch, side, name), 'utf8');
        } catch {
          return null;
        }
      };
      const [qa, qb, ja, jb, ma, mb] = [
        read('a', 'queue.json'),
        read('b', 'queue.json'),
        read('a', 'status.json'),
        read('b', 'status.json'),
        read('a', 'status.md'),
        read('b', 'status.md'),
      ];
      if ([qa, qb, ja, jb, ma, mb].some((v) => v === null)) return false;
      try {
        const queueB = JSON.parse(qb as string) as {
          items: Record<string, unknown>[];
          coverage: { observations: Record<string, Record<string, unknown>> };
        };
        queueB.items = queueB.items.map((it) =>
          it.state === 'pending'
            ? { ...it, state: 'done', not_before: null, last_error: null }
            : it,
        );
        for (const obs of Object.values(queueB.coverage.observations)) obs.pending = false;
        const retiredQueue = JSON.stringify(queueB);
        const statusB = JSON.parse(jb as string) as { items: Record<string, unknown>[] };
        statusB.items = statusB.items.map((it) =>
          it.state === 'pending' ? { ...it, state: 'done' } : it,
        );
        const sameJson = (x: string, y: string) =>
          JSON.stringify(sortKeys(JSON.parse(x))) === JSON.stringify(sortKeys(JSON.parse(y)));
        return (
          sameJson(qa as string, retiredQueue) &&
          JSON.stringify(statusB, null, 2) + '\n' === ja &&
          (mb as string)
            .replace('| open | pending |', '| open | done |')
            .replace('"idle_while_pending_24h": 1,', '"idle_while_pending_24h": 0,') === ma
        );
      } catch {
        return false;
      }
    },
  });
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, x]) => [k, sortKeys(x)]),
          )
        : v;
  const retirementQueue = {
    items: [item({ state: 'pending' })],
    starts: [],
    last_tick: '2027-01-15T07:55:00Z',
  };

  it('records the unpersisted superseded-open retirement as an explained divergence', async () => {
    const unexplained = await shadow(retirementQueue);
    expect(unexplained.result.report.class).toBe('unexplained');
    expect(unexplained.result.report.diff?.queue).toBe('differs');
    const explained = await shadow(retirementQueue, {}, (scratch) => [retirementOnly(scratch)]);
    expect(explained.result.report.class).toBe('explained');
  });

  const retirementWith = (mutate: (root: string) => void, extra: Partial<ComposedSpec> = {}) => {
    const s = spec(extra);
    const scratch = tmp();
    return runComposedShadow({
      liveRoot: live(retirementQueue),
      scratch,
      pinnedAt: NOW,
      sample: 'retirement',
      allowList: [retirementOnly(scratch)],
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
      // Queue corruption and lost reports are not the retirement delta.
      (root: string) => writeFileSync(join(root, 'queue.json'), '{}'),
      (root: string) => writeFileSync(join(root, 'queue.json'), '{"items":[]}'),
      (root: string) => unlinkSync(join(root, 'status.json')),
      (root: string) => unlinkSync(join(root, 'status.md')),
      (root: string) => appendFileSync(join(root, 'status.md'), 'extra\n'),
      (root: string) => {
        const q = JSON.parse(readFileSync(join(root, 'queue.json'), 'utf8')) as {
          items: Record<string, unknown>[];
        };
        q.items[0]!.repo = 'o/other';
        writeFileSync(join(root, 'queue.json'), JSON.stringify(q));
      },
    ]) {
      expect((await retirementWith(mutate)).report.class).toBe('unexplained');
    }
    const logDrift = spec();
    const logScratch = tmp();
    const { report } = await runComposedShadow({
      liveRoot: live(retirementQueue),
      scratch: logScratch,
      pinnedAt: NOW,
      sample: 'retirement-log',
      allowList: [retirementOnly(logScratch)],
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
