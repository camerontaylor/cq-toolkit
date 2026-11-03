// Split provenance: test/kernel/types.test.ts was split by subject; this file
// holds the generator-driven property tests (JSON round-trip, plain-data
// invariant, vendor-vocabulary). Sibling subjects: types.encoded-couplings.test.ts,
// types.mirror-tightenings.test.ts, types.worker-result-wire.test.ts,
// types.seam.test.ts, types.dispatch-errors.test.ts; shared fixtures live in
// types.helpers.ts.
import { describe, expect, test } from 'vitest';
import * as kernelSchema from '../../src/kernel/schema.js';
import type {
  JournalEvent,
  OpRegistryEntry,
  PlanRegistryEntry,
  RunReport,
} from '../../src/kernel/types.js';
import {
  ITERATIONS,
  ROUND_TRIP_CASES,
  assertNoFunctions,
  genJobFinished,
  genJobStarted,
  genJournalEvent,
  genOpResult,
  genRunFinished,
  genRunReport,
  genRunStarted,
  genWorkerResult,
  mulberry32,
  roundTripsThrough,
  seedFor,
} from './types.helpers.js';

// ---------------------------------------------------------------------------
// 1. JSON round-trip serializability (the property)
// ---------------------------------------------------------------------------

describe('JSON round-trip serializability (seeded property)', () => {
  for (const [name, schema, gen] of ROUND_TRIP_CASES) {
    test(`${name} round-trips JSON through ${name}Schema`, () => {
      const r = mulberry32(seedFor(name));
      for (let i = 0; i < ITERATIONS; i++) {
        roundTripsThrough(schema, gen(r));
      }
    });
  }

  test('all four journal event variants also parse through the JournalEventSchema union', () => {
    const r = mulberry32(seedFor('journal-union'));
    const events: JournalEvent[] = [
      genRunStarted(r),
      genJobStarted(r),
      genJobFinished(r),
      genRunFinished(r),
    ];
    for (const event of events) {
      const parsed = kernelSchema.JournalEventSchema.parse(JSON.parse(JSON.stringify(event)));
      expect(parsed).toEqual(event);
    }
  });

  test('random OpResult generation covers all five frozen statuses', () => {
    const r = mulberry32(seedFor('opresult-coverage'));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(genOpResult(r).status);
    expect([...seen].sort()).toEqual([
      'budget-exhausted',
      'failed',
      'indeterminate',
      'needs-human',
      'ok',
    ]);
  });

  test('random journal generation covers all four event types', () => {
    const r = mulberry32(seedFor('journal-coverage'));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(genJournalEvent(r).type);
    expect([...seen].sort()).toEqual([
      'job-finished',
      'job-started',
      'run-finished',
      'run-started',
    ]);
  });

  test('RunReport honest-stop variant round-trips (stoppedEarly + budget reason)', () => {
    // Explicit honest-stop instance: the run stopped early on budget.
    const honestStop: RunReport = {
      runId: 'run-honest',
      stoppedEarly: true,
      earlyStopReason: 'budget',
      counts: {
        queued: 1,
        running: 0,
        blocked: 0,
        done: 2,
        failed: 0,
        'budget-exhausted': 0,
      },
      jobs: [{ jobId: 'job-a', op: 'op-a', result: { status: 'budget-exhausted' } }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.42,
    };
    roundTripsThrough(kernelSchema.RunReportSchema, honestStop);

    // Plus randomized honest-stop instances from the generator.
    const r = mulberry32(seedFor('honest-stop'));
    let seen = 0;
    for (let i = 0; seen < 8 && i < 500; i++) {
      const instance = genRunReport(r);
      if (!instance.stoppedEarly) continue;
      expect(instance.earlyStopReason).toBe('budget');
      roundTripsThrough(kernelSchema.RunReportSchema, instance);
      seen++;
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// 2. Plain-data invariant: no function-valued fields in persisted shapes
// ---------------------------------------------------------------------------

describe('plain-data invariant', () => {
  // Honest scope note (VB1A): this walk covers generator-emitted fields only —
  // it is a generator-drift tripwire, not a proof of the plain-data invariant.
  // The proof is the type system (persisted types declare no functions) plus
  // the strict zod mirrors rejecting unexpected keys.
  test('no generated persisted instance contains a function-valued field', () => {
    for (const [name, , gen] of ROUND_TRIP_CASES) {
      const r = mulberry32(seedFor(`functions:${name}`));
      for (let i = 0; i < ITERATIONS; i++) {
        assertNoFunctions(gen(r), `${name}#${i}`);
      }
    }
  });

  test('registry entries are runtime-only: schema.ts mirrors nothing for them', () => {
    // Runtime absence check: a zod schema for OpRegistryEntry/PlanRegistryEntry
    // would be wrong by construction — the lazy importer is a function, and
    // functions are not JSON. If a *Registry* export ever appears in
    // kernel/schema.ts, the runtime-only contract has drifted.
    const exportedNames = Object.keys(kernelSchema);
    expect(exportedNames.filter((name) => /Registry/i.test(name))).toEqual([]);

    // Compile-time half of the claim: the registry entry types DO carry the
    // runtime importer functions. If this stops compiling, the types drifted
    // away from the runtime-only shape (or lost their importer).
    type HasRuntimeImporter<E> = E extends { importer: () => Promise<unknown> } ? true : false;
    const opRegistry: HasRuntimeImporter<OpRegistryEntry> = true;
    const planRegistry: HasRuntimeImporter<PlanRegistryEntry> = true;
    expect(opRegistry).toBe(true);
    expect(planRegistry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Vendor-vocabulary frozen claim: strict persisted shapes reject pollution
// ---------------------------------------------------------------------------

const VENDOR_KEYS = ['SDKMessage', 'BaseMessage', 'RunState'] as const;

describe('vendor-vocabulary frozen claim (strict persisted shapes)', () => {
  test('a valid WorkerResult parses', () => {
    const r = mulberry32(seedFor('worker-result-valid'));
    for (let i = 0; i < ITERATIONS; i++) {
      const result = kernelSchema.WorkerResultSchema.safeParse(genWorkerResult(r));
      expect(result.success, `valid instance #${i} must parse`).toBe(true);
    }
  });

  test.each(VENDOR_KEYS)(
    'WorkerResultSchema rejects an extra %s key (vendor message shape)',
    (vendorKey) => {
      const r = mulberry32(seedFor(`polluted:${vendorKey}`));
      const polluted = { ...genWorkerResult(r), [vendorKey]: { role: 'assistant' } };
      const result = kernelSchema.WorkerResultSchema.safeParse(polluted);
      if (result.success) {
        throw new Error(`WorkerResultSchema must reject ${vendorKey} pollution`);
      }
      expect(JSON.stringify(result.error.issues)).toContain(vendorKey);
    },
  );
});
