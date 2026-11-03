// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts; this module holds
// their shared fixtures (no tests). The original header follows.
//
// Lane H slice 2 (+ round-1 and round-2 fixes) — tests for captureBaseline
// and pruneBaselines (src/ops/ratchet/captureBaseline.ts).
//
// Pinned here:
//   1. Op-input serializability (Codex P1): the input is plain data
//      (structuredClone-safe — the kernel's makeManifest clones Job.input)
//      and references its runner by sourceId; the SourceCatalog is injected
//      at composition time and an unresolved sourceId fails naming it.
//   2. Capture lifecycle trio: 'created' on a fresh ws; 'updated' (previous
//      carried) when the value moves; 'unchanged' when the value is equal —
//      rewriting ONLY when the rendered bytes differ. The no-rewrite case is
//      pinned with a forced old mtime: an identical re-capture must not
//      touch the file.
//   3. Failure semantics — nothing crosses the op seam and I5 evidence is
//      never fabricated: unknown metric and unknown sourceId → failures
//      naming them; a null source or an unreadable raw → failure naming the
//      metric and "no metrics summary", with NOTHING written (no baselines
//      dir) and a pre-existing baseline surviving byte-for-byte; NON-ERROR
//      rejections (null, string, plain object) and throwing sources/adapters
//      → failures with mapped messages; a non-finite reading and an
//      unparseable capturedAt → failures; a corrupt existing baseline →
//      failure, file untouched; an unreadable existing path →
//      indeterminate, never a verdict.
//   4. Atomic publish: bytes land via temp-file + rename in the same dir —
//      no temp files linger, and the unchanged no-rewrite case still skips
//      the write entirely.
//   5. pruneBaselines: stale baselines deleted (relPath recorded), live
//      kept, unparseable content skipped, name/content disagreement
//      skipped (never deleted), I/O-fault files unreadable, a scan that
//      cannot start returns the zero outcome with `error` (never a throw),
//      the rename drill (capture a → capture b → prune live=[b] removes a)
//      and the delete drill (empty live removes every classifiable
//      baseline).
//
// Determinism: capturedAt is pinned on every capture (no clock in
// assertions); temp dirs under os.tmpdir(), removed in afterEach. The real
// typecheck-count adapter is used so capture is exercised end-to-end with a
// production adapter.
import type {
  CaptureBaselineInput,
  SourceCatalog,
} from '../../../src/ops/ratchet/captureBaseline.js';
import { typecheckCount } from '../../../src/ops/ratchet/adapters/typecheckCount.js';
import { baselineRelPath } from '../../../src/ops/ratchet/format.js';
import type { Direction } from '../../../src/ops/ratchet/format.js';
import type { MetricReading, MetricSource } from '../../../src/ops/ratchet/metricRegistry.js';
import { registerAdapter } from '../../../src/ops/ratchet/metricRegistry.js';

export const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
export const CAPTURED_AT_2 = '2026-09-15T01:00:00.000Z';
export const TARGET = 'typecheck';
export const METRIC = 'typecheck-count';
export const THROWING_METRIC = 'throwing-adapter';
export const OBJECT_THROWING_METRIC = 'object-throwing-adapter';
export const CRAFTED_INFINITE_METRIC = 'crafted-infinite';
export const UNIT_SHIFTING_METRIC = 'unit-shifting';
export const NULL_UNIT_METRIC = 'null-unit';
export const BAD_DIRECTION_METRIC = 'bad-direction';
export const BIGINT_UNIT_METRIC = 'bigint-unit';
export const UNDEFINED_READING_METRIC = 'undefined-reading';
export const THROWING_VALUE_GETTER_METRIC = 'throwing-value-getter';
export const THROWING_DIRECTION_GETTER_METRIC = 'throwing-direction-getter';
export const THROWING_MESSAGE_GETTER_METRIC = 'throwing-message-getter';
export const THROWING_UNIT_GETTER_METRIC = 'throwing-unit-getter';
export const REL = baselineRelPath(TARGET, METRIC);

// Each test file calls this from its own beforeAll (one registry per test-file
// module graph).
export function registerCaptureAdapters(): void {
  registerAdapter(typecheckCount);
  registerAdapter({
    id: THROWING_METRIC,
    direction: 'lower-is-better',
    extract: () => {
      throw new Error('exploded');
    },
  });
  registerAdapter({
    id: OBJECT_THROWING_METRIC,
    direction: 'lower-is-better',
    // A NON-Error throw: containment must map the object, not crash on it.
    extract: () => {
      throw { message: 'plain boom' };
    },
  });
  registerAdapter({
    id: CRAFTED_INFINITE_METRIC,
    direction: 'lower-is-better',
    // A crafted huge value that overflows the double range: 10**400 IS
    // Infinity, and JSON.stringify(Infinity) would write a `null` value the
    // baseline file could never parse back — the op must refuse it.
    extract: () => ({ value: 10 ** 400, unit: 'errors' }),
  });
  registerAdapter({
    id: THROWING_DIRECTION_GETTER_METRIC,
    // review-debt #72: `direction` is adapter-owned property read after the
    // guarded value/unit snapshot — a throwing getter must fail the op,
    // never escape the seam.
    get direction(): 'lower-is-better' {
      throw new Error('direction getter exploded');
    },
    extract: () => ({ value: 1, unit: 'errors' }),
  } as unknown as Parameters<typeof registerAdapter>[0]);
  registerAdapter({
    id: THROWING_MESSAGE_GETTER_METRIC,
    direction: 'lower-is-better',
    // review-debt #72: the THROWN value's own message accessor throws.
    extract: () => {
      throw {
        get message(): string {
          throw new Error('meta-explosion');
        },
      };
    },
  });
  registerAdapter({
    id: UNIT_SHIFTING_METRIC,
    direction: 'lower-is-better',
    // The reading's unit follows the source data, so the same (target,
    // metric) path can be captured with different units — exactly the
    // identity-check scenario.
    extract: (raw) => {
      const record = raw as { count?: unknown; unit?: string };
      if (typeof record.count !== 'number') return null;
      return { value: record.count, ...(record.unit === undefined ? {} : { unit: record.unit }) };
    },
  });
  registerAdapter({
    id: NULL_UNIT_METRIC,
    direction: 'lower-is-better',
    // A third-party adapter shape the type system cannot see through:
    // unit: null serializes as "unit": null and the rendered baseline
    // would fail its own parser — the publish self-check must refuse it.
    extract: () => ({ value: 1, unit: null }) as unknown as MetricReading,
  });
  registerAdapter({
    id: BAD_DIRECTION_METRIC,
    // A cast-bogus direction on the adapter object itself.
    direction: 'sideways' as unknown as Direction,
    extract: () => ({ value: 1, unit: 'x' }),
  });
  registerAdapter({
    id: BIGINT_UNIT_METRIC,
    direction: 'lower-is-better',
    // A BigInt unit makes JSON.stringify THROW (before any guarded parse) —
    // the render itself must be contained by the op seam.
    extract: () => ({ value: 1, unit: 1n }) as unknown as MetricReading,
  });
  registerAdapter({
    id: UNDEFINED_READING_METRIC,
    direction: 'lower-is-better',
    // A type-violating adapter: returns undefined instead of the declared
    // MetricReading | null — the op must treat it as I5 non-passing
    // evidence, never dereference it.
    extract: () => undefined as unknown as MetricReading,
  });
  registerAdapter({
    id: THROWING_VALUE_GETTER_METRIC,
    direction: 'lower-is-better',
    // Adapter-owned FIELD ACCESS can also throw: the value getter explodes
    // on access, after the reading passed the typeof guard.
    extract: () => {
      const reading = { unit: 'errors' };
      Object.defineProperty(reading, 'value', {
        get() {
          throw new Error('value getter exploded');
        },
      });
      return reading as unknown as MetricReading;
    },
  });
  registerAdapter({
    id: THROWING_UNIT_GETTER_METRIC,
    direction: 'lower-is-better',
    extract: () => {
      const reading = { value: 2 };
      Object.defineProperty(reading, 'unit', {
        get() {
          throw new Error('unit getter exploded');
        },
      });
      return reading as unknown as MetricReading;
    },
  });
}

// Sources are composition-time wiring (round-1 fix): they live in this
// catalog, never in the op input — the input only carries the sourceId.
// `readSourceRaw` reads the per-file `sourceRaw` binding at call time.
export function createSourceCatalog(readSourceRaw: () => unknown): SourceCatalog {
  return new Map<string, MetricSource>([
    [METRIC, () => Promise.resolve(readSourceRaw())],
    ['offline', () => Promise.resolve(null)],
    [THROWING_METRIC, () => Promise.resolve({ count: 1 })],
    [OBJECT_THROWING_METRIC, () => Promise.resolve({ count: 1 })],
    [CRAFTED_INFINITE_METRIC, () => Promise.resolve({ count: 1 })],
    [NULL_UNIT_METRIC, () => Promise.resolve({ count: 1 })],
    [BAD_DIRECTION_METRIC, () => Promise.resolve({ count: 1 })],
    [BIGINT_UNIT_METRIC, () => Promise.resolve({ count: 1 })],
    [UNDEFINED_READING_METRIC, () => Promise.resolve({ count: 1 })],
    [THROWING_VALUE_GETTER_METRIC, () => Promise.resolve({ count: 1 })],
    [THROWING_UNIT_GETTER_METRIC, () => Promise.resolve({ count: 1 })],
    [THROWING_DIRECTION_GETTER_METRIC, () => Promise.resolve({ count: 1 })],
    [THROWING_MESSAGE_GETTER_METRIC, () => Promise.resolve({ count: 1 })],
    [UNIT_SHIFTING_METRIC, () => Promise.resolve(readSourceRaw())],
    ['exploding-source', () => Promise.reject(new Error('boom'))],
    ['rejecting-null', () => Promise.reject(null)],
    ['rejecting-string', () => Promise.reject('boom-string')],
  ]);
}

export function captureInputFor(
  ws: string,
  overrides: Partial<CaptureBaselineInput> = {},
): CaptureBaselineInput {
  return {
    ws,
    target: TARGET,
    metric: METRIC,
    sourceId: METRIC,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}
