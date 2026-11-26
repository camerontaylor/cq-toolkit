import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bindBackfillDispatchConfigured,
  bindTickSeams,
} from '../../../src/adapters/crq/coverageTickSeams.js';
import { JsonNumber, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerJsonDecodeError,
  LedgerIntegrityError,
  LedgerUnicodeDecodeError,
  ledgerLoads,
} from '../../../src/policy/crq/ledger.js';
import { BackfillInventoryError } from '../../../src/policy/crq/backfillInventory.js';
import { SpoolConfigError } from '../../../src/adapters/crq/publisherSpool.js';
import { TickScheduleError } from '../../../src/policy/crq/tickSchedule.js';
import { PyError } from '../../../src/policy/crq/pyCompat.js';
import type { Item, Queue } from '../../../src/queue-runner/coverageUsage.js';
import { oraclePython } from '../../helpers/oraclePython.js';

/**
 * Replays the Python 3.14 oracle (apps/crq-python/coverage_tick_seams_vectors.py):
 * production `crq.parse_iso`, `live_items`, `sort_key`, `deps_met` and
 * `backfill_runtime.settings(state, dispatch=True)` over a fixed clock, a
 * fixed scheduling config and throwaway state/policy directories.
 */

const FIXTURE = new URL(
  '../../../apps/crq-python/fixtures/crq-coverage-tick-seams/cases.json',
  import.meta.url,
);

type Outcome = { ok?: unknown; raises?: string; message?: string };
interface Fixture {
  now: string;
  primary: string;
  parse_iso: { input: unknown; outcome: Outcome }[];
  configs: { name: string; aging: number | null; repos: { repo: string; rank_tier: number }[] }[];
  queues: {
    queue: string;
    config: string;
    items: unknown[];
    live: string[];
    sorted: Outcome;
    deps: Record<string, Outcome>;
  }[];
  malformed: { name: string; queue: unknown; live: Outcome }[];
  settings: {
    name: string;
    outcome: Outcome;
    spec: {
      rollout: string | null;
      rollout_hex?: string;
      state_kind?: 'file' | 'loop';
      policy_files: Record<'tiers' | 'limits' | 'required-list', string | null>;
    };
  }[];
}
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
const NOW_MS = Date.parse(fixture.now);

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === 'number') return JsonNumber.int(value);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$int === 'string') return JsonNumber.int(record.$int);
  if (typeof record.$float === 'string') return JsonNumber.float(Number(record.$float));
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decode(v)]));
}

/** Plain JS numbers: the shape `bindStartOne` hands the seam. */
function decodePlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodePlain);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$int === 'string') return Number(record.$int);
  if (typeof record.$float === 'string') return Number(record.$float);
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decodePlain(v)]));
}

function errorOutcome(error: unknown): Outcome {
  if (error instanceof PyError) {
    // `PyErrorClass` has no FileNotFoundError; the only OSError raised here is ENOENT.
    const raises = error.pythonError === 'OSError' ? 'FileNotFoundError' : error.pythonError;
    return { raises, message: error.message };
  }
  if (error instanceof LedgerIntegrityError) {
    return { raises: 'IntegrityError', message: error.message };
  }
  if (error instanceof LedgerJsonDecodeError || error instanceof LedgerUnicodeDecodeError) {
    return { raises: error.pythonError, message: error.message };
  }
  // The policy modules refuse with their own typed errors where Python raises
  // `IntegrityError` (unusable spool, unverified or invalid limits) or `KeyError`
  // (a limits key that is absent): same fail-closed refusal, same message.
  // The spool parser names the specific field; Python's one message is the class contract.
  if (error instanceof SpoolConfigError) {
    return {
      raises: 'IntegrityError',
      message: 'backfill rollout publisher_spool incomplete or invalid',
    };
  }
  if (error instanceof BackfillInventoryError) {
    const missing = /^(?:construction|reviewer) limits is missing (\w+)$/.exec(error.message);
    return missing === null
      ? { raises: 'IntegrityError', message: error.message }
      : { raises: 'KeyError', message: `'${missing[1]}'` };
  }
  throw error;
}

function attempt<T>(call: () => T): Outcome {
  try {
    return { ok: call() };
  } catch (error) {
    return errorOutcome(error);
  }
}

describe('coverage tick seams against the Python oracle', () => {
  it('has unique case names and covers success and error classes', () => {
    const names = fixture.settings.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const raised = new Set(fixture.settings.map((c) => c.outcome.raises));
    for (const klass of ['IntegrityError', 'KeyError', 'AttributeError', 'FileNotFoundError']) {
      expect(raised.has(klass)).toBe(true);
    }
    expect(fixture.settings.some((c) => c.outcome.ok === true)).toBe(true);
    expect(fixture.settings.some((c) => c.outcome.ok === false)).toBe(true);
  });

  describe('clocks', () => {
    const seams = (clock = () => NOW_MS) =>
      bindTickSeams({
        clock,
        schedule: { primaryRepo: fixture.primary, repos: [], localReviewAgingMinutes: 60 },
      });

    it('calls the clock on its owner, for nowMs and for the sort keys', () => {
      // The input object is the owner: `clock` reads `this.fixedMs`.
      const input = {
        fixedMs: NOW_MS,
        schedule: { primaryRepo: fixture.primary, repos: [], localReviewAgingMinutes: 60 },
        clock(this: { fixedMs: number }) {
          return this.fixedMs;
        },
      };
      const seams = bindTickSeams(input);
      const a = { id: 'a', kind: 'open', state: 'pending', order: 1 } as Item;
      const b = { id: 'b', kind: 'open', state: 'pending', order: 2 } as Item;
      expect(seams.nowMs()).toBe(NOW_MS);
      expect(seams.compareItems(a, b)).toBeLessThan(0);
    });

    it('nowMs reads the injected clock', () => {
      expect(seams(() => 42).nowMs()).toBe(42);
    });

    for (const [index, testCase] of fixture.parse_iso.entries()) {
      it(`parseIsoMs #${index} ${JSON.stringify(testCase.input)}`, () => {
        // Both the retained-number shape and plain JS numbers: always a `PyError`.
        for (const shape of [decode, decodePlain]) {
          const input = shape(testCase.input) as string;
          const got = attempt(() => seams().parseIsoMs(input));
          if (testCase.outcome.ok === null) {
            // `parse_iso` is None; coverage_fallback compares it with `now()`.
            expect(got.raises).toBe('TypeError');
          } else if (testCase.outcome.ok !== undefined) {
            expect(got).toEqual(testCase.outcome);
          } else {
            expect(got.raises).toBe(testCase.outcome.raises);
            // `strptime`'s prose is a diagnostic: the ValueError class is the contract.
            if (testCase.outcome.raises !== 'ValueError') {
              expect(got.message).toBe(testCase.outcome.message);
            }
          }
        }
      });
    }
  });

  describe('queue helpers', () => {
    for (const testCase of fixture.queues) {
      it(`${testCase.queue} / ${testCase.config}`, () => {
        const config = fixture.configs.find((c) => c.name === testCase.config)!;
        const seams = bindTickSeams({
          clock: () => NOW_MS,
          schedule: {
            primaryRepo: fixture.primary,
            repos: config.repos,
            localReviewAgingMinutes: config.aging ?? 60,
          },
        });
        const ids = (items: Item[]) => items.map((i) => (i as { id: string }).id);
        // Plain JS numbers, and the retained-`JsonNumber` shape `composeTick`'s
        // `viaPlain` carries: Python orders both the same way.
        for (const shape of [decodePlain, decode]) {
          const queue = { items: shape(testCase.items) } as Queue;
          expect(ids(seams.liveItems(queue))).toEqual(testCase.live);
          expect(ids([...seams.liveItems(queue)].sort(seams.compareItems))).toEqual(
            testCase.sorted.ok,
          );
          for (const item of queue.items) {
            const id = (item as { id: string }).id;
            expect(seams.depsMet(queue, item)).toBe(testCase.deps[id]!.ok);
          }
        }
      });
    }

    // `fixture.malformed`: Python raises on all of these. `liveItems` refuses a
    // non-array `items` with its own typed error, and it filters a non-record
    // item where Python raises: the documented divergences, pinned here.
    for (const testCase of fixture.malformed) {
      it(`malformed ${testCase.name}`, () => {
        const seams = bindTickSeams({
          clock: () => NOW_MS,
          schedule: { primaryRepo: fixture.primary, repos: [], localReviewAgingMinutes: 60 },
        });
        expect(['AttributeError', 'KeyError']).toContain(testCase.live.raises);
        const queue = testCase.queue as Queue;
        if (testCase.name === 'item-not-a-dict') {
          expect(seams.liveItems(queue).map((i) => (i as { id: string }).id)).toEqual(['a']);
        } else {
          expect(() => seams.liveItems(queue)).toThrow(TickScheduleError);
        }
      });
    }
  });

  describe('backfillDispatchConfigured', () => {
    const roots: string[] = [];
    afterAll(() => {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    for (const testCase of fixture.settings) {
      it(testCase.name, () => {
        const root = mkdtempSync(join(tmpdir(), 'cq-tick-seams-'));
        roots.push(root);
        const state = join(root, 'state');
        if (testCase.spec.state_kind === 'file') writeFileSync(state, '');
        else mkdirSync(state);
        if (testCase.spec.state_kind === 'loop') {
          symlinkSync('backfill-rollout.json', join(state, 'backfill-rollout.json'));
        }
        mkdirSync(join(root, 'policy'));
        for (const [name, text] of Object.entries(testCase.spec.policy_files)) {
          if (text !== null) writeFileSync(join(root, 'policy', `review-${name}.json`), text);
        }
        if (testCase.spec.rollout_hex !== undefined) {
          writeFileSync(
            join(state, 'backfill-rollout.json'),
            Buffer.from(testCase.spec.rollout_hex, 'hex'),
          );
        } else if (testCase.spec.rollout !== null) {
          writeFileSync(join(state, 'backfill-rollout.json'), testCase.spec.rollout);
        }
        // `backfill_runtime.policies()`: all three files, in order, then limits.
        const loadLimits = (): JsonValue => {
          const loaded: JsonValue[] = [];
          for (const name of ['tiers', 'limits', 'required-list']) {
            const path = join(root, 'policy', `review-${name}.json`);
            let bytes: Buffer;
            try {
              bytes = readFileSync(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                const shown = path.replace(root, '<tmp>');
                throw new PyError('OSError', `[Errno 2] No such file or directory: '${shown}'`);
              }
              throw error;
            }
            loaded.push(ledgerLoads(bytes));
          }
          return loaded[1]!;
        };
        const configured = bindBackfillDispatchConfigured({ stateRoot: state, loadLimits });
        const got = attempt(configured);
        if (testCase.outcome.ok !== undefined) {
          expect(got).toEqual(testCase.outcome);
        } else {
          expect(got.raises).toBe(testCase.outcome.raises);
          // Codec and JSON-decoder prose is the library's; every other message is exact.
          if (!['UnicodeDecodeError', 'JSONDecodeError'].includes(testCase.outcome.raises ?? '')) {
            expect(got.message).toBe(testCase.outcome.message);
          }
        }
      });
    }
  });

  it('matches a live python3.14 emit of the same fixture', () => {
    const run = spawnSync(oraclePython(), ['coverage_tick_seams_vectors.py', '--stdout'], {
      cwd: new URL('../../../apps/crq-python/', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, PYTHONHASHSEED: '7' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(readFileSync(FIXTURE, 'utf8'));
  });
});
