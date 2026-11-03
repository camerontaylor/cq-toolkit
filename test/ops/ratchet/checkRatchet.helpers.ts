// Split provenance: test/ops/ratchet/checkRatchet.test.ts was split into
// checkRatchet.helpers.ts (shared fixtures, this file) and six subject files;
// this module carries the fixtures only — no tests, no describe.
//
// checkRatchet tests — lane H slice 1 (goal H2), for
// src/ops/ratchet/checkRatchet.ts.
//
// Pinned here:
//   1. Op-input serializability (Codex P1): the input is plain data
//      (structuredClone-safe — the kernel's makeManifest clones Job.input)
//      and references its runner by sourceId; the SourceCatalog is injected
//      at composition time and an unresolved sourceId fails naming it.
//   2. The ratchet's one direction of travel — thresholds only tighten:
//      tighten passes and equal passes in BOTH directions (lower-is-better
//      via the real typecheck-count adapter, higher-is-better via the real
//      coverage adapter), while a loosen fails with expected vs actual in
//      the reason and both values carried.
//   3. I5 / UC §5 row 56 `no-summary` as a hard rule: a null source, an
//      extract that yields null/undefined/a non-object (type-violating
//      adapter probe), a throwing adapter, a throwing source (including
//      non-Error rejections), a throwing adapter-owned getter, a missing
//      baseline file, a corrupt baseline, and a baselines-dir escape ALL
//      land on verdict:'fail' — never a pass on absent evidence. The
//      corollary is pinned explicitly: a missing summary fails EVEN WHEN a
//      permissive baseline exists that would have passed.
//   4. Identity: a planted baseline whose target, metric, or direction
//      disagrees with the capture context is incomparable evidence — fail
//      naming both sides; values are never compared across identities. The
//      unit joins the identity set: a planted unit differing from the
//      reading's unit (undefined counting as a value) is incomparable
//      SCALE — same-unit and unit-undefined≡undefined checks pass.
//   5. Every fail carries a reason naming WHAT failed, and both values stay
//      null unless the comparison actually ran.
//   6. The baseline leaf is inspected with lstat BEFORE any read: a
//      symlinked leaf (byte-valid content outside ws) and a directory
//      squatting at the leaf path both fail with the non-ENOENT refusal
//      wording, distinct from the missing-file 'not found'.
//
// Determinism: temp dirs under os.tmpdir(), removed in afterEach; no clock
// in assertions. Production adapters are used so checks are exercised
// end-to-end.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach } from 'vitest';
import { coverage } from '../../../src/ops/ratchet/adapters/coverage.js';
import { typecheckCount } from '../../../src/ops/ratchet/adapters/typecheckCount.js';
import { createCheckRatchet } from '../../../src/ops/ratchet/checkRatchet.js';
import type { CheckRatchetInput } from '../../../src/ops/ratchet/checkRatchet.js';
import type { SourceCatalog } from '../../../src/ops/ratchet/captureBaseline.js';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile, Direction } from '../../../src/ops/ratchet/format.js';
import { registerAdapter } from '../../../src/ops/ratchet/metricRegistry.js';
import type { MetricReading, MetricSource } from '../../../src/ops/ratchet/metricRegistry.js';

export const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
export const TARGET = 'typecheck';
export const METRIC = 'typecheck-count'; // real adapter, lower-is-better
export const COVERAGE_METRIC = 'coverage'; // real adapter, higher-is-better
export const THROWING_METRIC = 'throwing-adapter';
export const NULL_EXTRACT_METRIC = 'null-extract';
export const UNDEFINED_READING_METRIC = 'undefined-reading';
export const NONOBJECT_READING_METRIC = 'non-object-reading';
export const THROWING_VALUE_GETTER_METRIC = 'throwing-value-getter';
export const THROWING_DIRECTION_GETTER_METRIC = 'throwing-direction-getter';
export const THROWING_MESSAGE_GETTER_METRIC = 'throwing-message-getter';
export const UNIT_SHIFTING_METRIC = 'unit-shifting';
export const INFINITE_VALUE_METRIC = 'infinite-value';

// One row per Direction, driven by the REAL production adapters so the
// ratchet matrix (tighten/equal/loosen) is exercised end-to-end both ways.
export const DIRECTIONS = [
  { label: 'lower-is-better', metric: METRIC, unit: 'errors', baseline: 3, tighten: 2, loosen: 5 },
  {
    label: 'higher-is-better',
    metric: COVERAGE_METRIC,
    unit: 'pct',
    baseline: 50,
    tighten: 60,
    loosen: 40,
  },
] as const;
export type Dir = (typeof DIRECTIONS)[number];

export function rawFor(dir: Dir, value: number): unknown {
  return dir.metric === METRIC ? { count: value } : { total: { lines: { pct: value } } };
}

export function relFor(dir: Dir): string {
  return baselineRelPath(TARGET, dir.metric);
}

export const REL = relFor(DIRECTIONS[0]);

export let ws: string;
// The raw data each catalog source hands to its adapter; set per test.
export const raws: Record<string, unknown> = {};

beforeAll(() => {
  registerAdapter(typecheckCount);
  registerAdapter(coverage);
  registerAdapter({
    id: THROWING_METRIC,
    direction: 'lower-is-better',
    extract: () => {
      throw new Error('exploded');
    },
  });
  registerAdapter({
    id: NULL_EXTRACT_METRIC,
    direction: 'lower-is-better',
    extract: () => null, // usable raw in, "no summary here" out
  });
  registerAdapter({
    id: UNDEFINED_READING_METRIC,
    direction: 'lower-is-better',
    // A type-violating adapter: returns undefined instead of the declared
    // MetricReading | null — I5 non-passing evidence, never dereferenced.
    extract: () => undefined as unknown as MetricReading,
  });
  registerAdapter({
    id: NONOBJECT_READING_METRIC,
    direction: 'lower-is-better',
    // Also type-violating: a plain number where an object was declared.
    extract: () => 42 as unknown as MetricReading,
  });
  registerAdapter({
    id: THROWING_VALUE_GETTER_METRIC,
    direction: 'lower-is-better',
    // Adapter-owned FIELD ACCESS can throw: the value getter explodes on
    // access, after the reading passed the typeof guard.
    extract: () => {
      const reading: Record<string, unknown> = { unit: 'errors' };
      Object.defineProperty(reading, 'value', {
        get() {
          throw new Error('value getter exploded');
        },
      });
      return reading as unknown as MetricReading;
    },
  });
  registerAdapter({
    id: THROWING_DIRECTION_GETTER_METRIC,
    // review-debt #72: `direction` is adapter-owned property read AFTER the
    // guarded value/unit snapshot — a throwing getter here must land on a
    // fail verdict, never escape the op seam.
    get direction(): 'lower-is-better' {
      throw new Error('direction getter exploded');
    },
    extract: () => ({ value: 1, unit: 'errors' }),
  } as unknown as Parameters<typeof registerAdapter>[0]);
  registerAdapter({
    id: THROWING_MESSAGE_GETTER_METRIC,
    direction: 'lower-is-better',
    // review-debt #72: the THROWN value's own message accessor throws — the
    // containment helper must never throw inside the catch handler.
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
    // metric) path can be checked against baselines in different units —
    // exactly the incomparable-scale scenario.
    extract: (raw) => {
      const record = raw as { count?: unknown; unit?: string };
      if (typeof record.count !== 'number') return null;
      return { value: record.count, ...(record.unit === undefined ? {} : { unit: record.unit }) };
    },
  });
  registerAdapter({
    id: INFINITE_VALUE_METRIC,
    direction: 'lower-is-better',
    // A crafted huge value that overflows the double range: 10**400 IS
    // Infinity — a clean (non-throwing) non-finite reading must fail the
    // check as an unusable reading, never reach the comparison.
    extract: () => ({ value: 10 ** 400, unit: 'errors' }),
  });
});

// Sources are composition-time wiring: they live in this catalog, never in
// the op input — the input only carries the sourceId.
const sources: SourceCatalog = new Map<string, MetricSource>([
  [METRIC, () => Promise.resolve(raws[METRIC])],
  [COVERAGE_METRIC, () => Promise.resolve(raws[COVERAGE_METRIC])],
  [UNIT_SHIFTING_METRIC, () => Promise.resolve(raws[UNIT_SHIFTING_METRIC])],
  [INFINITE_VALUE_METRIC, () => Promise.resolve({ count: 1 })],
  [THROWING_METRIC, () => Promise.resolve({ count: 1 })],
  [NULL_EXTRACT_METRIC, () => Promise.resolve({ count: 1 })],
  [UNDEFINED_READING_METRIC, () => Promise.resolve({ count: 1 })],
  [NONOBJECT_READING_METRIC, () => Promise.resolve({ count: 1 })],
  [THROWING_VALUE_GETTER_METRIC, () => Promise.resolve({ count: 1 })],
  [THROWING_DIRECTION_GETTER_METRIC, () => Promise.resolve({ count: 1 })],
  [THROWING_MESSAGE_GETTER_METRIC, () => Promise.resolve({ count: 1 })],
  ['exploding-source', () => Promise.reject(new Error('boom'))],
  ['rejecting-null', () => Promise.reject(null)],
  ['rejecting-string', () => Promise.reject('boom-string')],
]);
export const check = createCheckRatchet(sources);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-check-'));
  delete raws[METRIC];
  delete raws[COVERAGE_METRIC];
  delete raws[UNIT_SHIFTING_METRIC];
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

export function checkInput(overrides: Partial<CheckRatchetInput> = {}): CheckRatchetInput {
  return {
    ws,
    target: TARGET,
    metric: METRIC,
    sourceId: METRIC,
    ...overrides,
  };
}

/** Plant a committed baseline for one direction row at its real relPath. */
interface DirSpec {
  label: Direction;
  metric: string;
  unit?: string;
}

export async function plantBaseline(
  dir: DirSpec,
  value: number,
  overrides: Partial<BaselineFile> = {},
): Promise<void> {
  await mkdir(join(ws, 'baselines'), { recursive: true });
  const bytes = renderBaseline({
    schemaVersion: 1,
    target: TARGET,
    metric: dir.metric,
    direction: dir.label,
    value,
    ...(dir.unit === undefined ? {} : { unit: dir.unit }),
    capturedAt: CAPTURED_AT,
    ...overrides,
  });
  await writeFile(join(ws, baselineRelPath(TARGET, dir.metric)), bytes, 'utf8');
}
