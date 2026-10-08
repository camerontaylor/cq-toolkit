import { match } from '../../helpers/matchers.js';
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
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { coverage } from '../../../src/ops/ratchet/adapters/coverage.js';
import { typecheckCount } from '../../../src/ops/ratchet/adapters/typecheckCount.js';
import { createCheckRatchet } from '../../../src/ops/ratchet/checkRatchet.js';
import type { CheckRatchetInput } from '../../../src/ops/ratchet/checkRatchet.js';
import type { SourceCatalog } from '../../../src/ops/ratchet/captureBaseline.js';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile, Direction } from '../../../src/ops/ratchet/format.js';
import { registerAdapter } from '../../../src/ops/ratchet/metricRegistry.js';
import type { MetricReading, MetricSource } from '../../../src/ops/ratchet/metricRegistry.js';

const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
const TARGET = 'typecheck';
const METRIC = 'typecheck-count'; // real adapter, lower-is-better
const COVERAGE_METRIC = 'coverage'; // real adapter, higher-is-better
const THROWING_METRIC = 'throwing-adapter';
const NULL_EXTRACT_METRIC = 'null-extract';
const UNDEFINED_READING_METRIC = 'undefined-reading';
const NONOBJECT_READING_METRIC = 'non-object-reading';
const THROWING_VALUE_GETTER_METRIC = 'throwing-value-getter';
const THROWING_DIRECTION_GETTER_METRIC = 'throwing-direction-getter';
const THROWING_MESSAGE_GETTER_METRIC = 'throwing-message-getter';
const UNIT_SHIFTING_METRIC = 'unit-shifting';
const INFINITE_VALUE_METRIC = 'infinite-value';

// One row per Direction, driven by the REAL production adapters so the
// ratchet matrix (tighten/equal/loosen) is exercised end-to-end both ways.
const DIRECTIONS = [
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
type Dir = (typeof DIRECTIONS)[number];

function rawFor(dir: Dir, value: number): unknown {
  return dir.metric === METRIC ? { count: value } : { total: { lines: { pct: value } } };
}

function relFor(dir: Dir): string {
  return baselineRelPath(TARGET, dir.metric);
}

const REL = relFor(DIRECTIONS[0]);

let ws: string;
// The raw data each catalog source hands to its adapter; set per test.
const raws: Record<string, unknown> = {};

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
const check = createCheckRatchet(sources);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-check-'));
  delete raws[METRIC];
  delete raws[COVERAGE_METRIC];
  delete raws[UNIT_SHIFTING_METRIC];
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function checkInput(overrides: Partial<CheckRatchetInput> = {}): CheckRatchetInput {
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

async function plantBaseline(
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

describe('checkRatchet', () => {
  test('the op input is plain data: structuredClone-safe (kernel makeManifest clones Job.input)', () => {
    expect(() => structuredClone(checkInput())).not.toThrow();
  });

  test.each([
    ['ws: undefined', { ws: undefined }],
    ['target: 42', { target: 42 }],
    ['metric: {}', { metric: {} }],
    ['sourceId: null', { sourceId: null }],
  ])(
    'a non-string input (%s) fails with arg-error wording before any path work — never a throw',
    async (_label, overrides) => {
      await expect(check(checkInput(overrides as Partial<CheckRatchetInput>))).resolves.toEqual({
        status: 'ok',
        value: {
          path: '',
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(
            /invalid input — '(ws|target|metric|sourceId)' must be a string/,
          ),
        },
      });
    },
  );

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])(
    'calling the op with %s input fails with arg-error wording — no throw',
    async (_label, badInput) => {
      await expect(check(badInput as unknown as CheckRatchetInput)).resolves.toEqual({
        status: 'ok',
        value: {
          path: '',
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(/invalid input — expected a non-null object/),
        },
      });
    },
  );

  test('a clean non-finite reading (Infinity) fails as an unusable reading — no throw, no comparison', async () => {
    await expect(
      check(checkInput({ metric: INFINITE_VALUE_METRIC, sourceId: INFINITE_VALUE_METRIC })),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, INFINITE_VALUE_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(/adapter produced an unusable reading \(Infinity\)/),
      },
    });
  });

  test.each(DIRECTIONS)(
    'tighten passes ($label): the value improves on the baseline',
    async (dir) => {
      await plantBaseline(dir, dir.baseline);
      raws[dir.metric] = rawFor(dir, dir.tighten);
      await expect(
        check(checkInput({ metric: dir.metric, sourceId: dir.metric })),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          path: relFor(dir),
          verdict: 'pass',
          baselineValue: dir.baseline,
          currentValue: dir.tighten,
        },
      });
    },
  );

  test.each(DIRECTIONS)('equal passes ($label): an unchanged metric never blocks', async (dir) => {
    await plantBaseline(dir, dir.baseline);
    raws[dir.metric] = rawFor(dir, dir.baseline);
    // toEqual with no `reason` key pins its absence: a pass carries no
    // excuse, and undefined extras are ignored by toEqual while a string
    // reason would fail the match.
    await expect(check(checkInput({ metric: dir.metric, sourceId: dir.metric }))).resolves.toEqual({
      status: 'ok',
      value: {
        path: relFor(dir),
        verdict: 'pass',
        baselineValue: dir.baseline,
        currentValue: dir.baseline,
      },
    });
  });

  test.each(DIRECTIONS)(
    'loosen fails ($label) with expected vs actual in the reason',
    async (dir) => {
      await plantBaseline(dir, dir.baseline);
      raws[dir.metric] = rawFor(dir, dir.loosen);
      await expect(
        check(checkInput({ metric: dir.metric, sourceId: dir.metric })),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          path: relFor(dir),
          verdict: 'fail',
          baselineValue: dir.baseline,
          currentValue: dir.loosen,
          reason: match.stringMatching(
            new RegExp(
              `metric '${dir.metric}' loosened: baseline ${dir.baseline} → ` +
                `current ${dir.loosen} \\(${dir.label}\\) — only tightening passes`,
            ),
          ),
        },
      });
    },
  );

  test('a missing summary fails with the I5 wording EVEN WHEN a permissive baseline exists', async () => {
    // The baseline (3) would pass a current ≤ 3 — but there is no reading:
    // UC §5 row 56's `no-summary` lesson is a hard rule, so absent evidence
    // can never ride a would-have-passed baseline to a pass.
    await plantBaseline(DIRECTIONS[0], 3);
    raws[METRIC] = null;
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /metric 'typecheck-count' has no metrics summary \(I5: non-passing evidence, never a pass\)/,
        ),
      },
    });
  });

  test('an extract that yields null on usable raw fails with the same no-summary wording', async () => {
    await plantBaseline(DIRECTIONS[0], 3);
    await expect(
      check(checkInput({ metric: NULL_EXTRACT_METRIC, sourceId: NULL_EXTRACT_METRIC })),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, NULL_EXTRACT_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /has no metrics summary \(I5: non-passing evidence, never a pass\)/,
        ),
      },
    });
  });

  test.each([
    ['undefined', UNDEFINED_READING_METRIC],
    ['a non-object (42)', NONOBJECT_READING_METRIC],
  ])(
    'a type-violating adapter returning %s fails as no-summary (no throw, no dereference)',
    async (_kind, metric) => {
      await expect(check(checkInput({ metric, sourceId: metric }))).resolves.toEqual({
        status: 'ok',
        value: {
          path: baselineRelPath(TARGET, metric),
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(
            new RegExp(
              `metric '${metric}' has no metrics summary \\(I5: non-passing evidence, never a pass\\)`,
            ),
          ),
        },
      });
    },
  );

  test('a missing baseline file fails as non-passing evidence (no dir, and dir present but empty)', async () => {
    raws[METRIC] = { count: 2 };
    // No baselines dir at all.
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          new RegExp(
            `baseline '${REL}' not found — metric 'typecheck-count' baseline not found \\(non-passing evidence\\)`,
          ),
        ),
      },
    });
    // Baselines dir exists, file does not.
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(new RegExp(`baseline '${REL}' not found`)),
      },
    });
  });

  test('a corrupt baseline fails naming the path', async () => {
    raws[METRIC] = { count: 2 };
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, REL), '{"schemaVersion": 999}\n', 'utf8');
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(new RegExp(`baseline '${REL}' is corrupt`)),
      },
    });
  });

  const IDENTITY_MISMATCHES: Array<[string, Partial<BaselineFile>, RegExp]> = [
    ['target', { target: 'elsewhere' }, /disagrees on target 'elsewhere' → 'typecheck'/],
    [
      'metric',
      { metric: 'other-metric' },
      /disagrees on metric 'other-metric' → 'typecheck-count'/,
    ],
    [
      'direction',
      { direction: 'higher-is-better' },
      /disagrees on direction 'higher-is-better' → 'lower-is-better'/,
    ],
  ];
  test.each(IDENTITY_MISMATCHES)(
    'a planted baseline whose %s disagrees is incomparable evidence — fail naming both sides',
    async (_field, overrides, pattern) => {
      raws[METRIC] = { count: 2 };
      await plantBaseline(DIRECTIONS[0], 3, overrides);
      await expect(check(checkInput())).resolves.toEqual({
        status: 'ok',
        value: {
          path: REL,
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(pattern),
        },
      });
    },
  );

  test('unknown metric fails with arg-error semantics in the reason (a verdict, not a throw)', async () => {
    await expect(check(checkInput({ metric: 'no-such-metric' }))).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, 'no-such-metric'),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(/unknown metric 'no-such-metric' — no registered adapter/),
      },
    });
  });

  test('unknown sourceId fails naming the source', async () => {
    raws[METRIC] = { count: 2 };
    await plantBaseline(DIRECTIONS[0], 3);
    await expect(check(checkInput({ sourceId: 'no-such-source' }))).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /unknown source 'no-such-source' for metric 'typecheck-count'/,
        ),
      },
    });
  });

  test.each([
    ['an Error rejection', 'exploding-source', /source failed.*boom/s],
    ['a null rejection', 'rejecting-null', /source failed.*unknown error/s],
    ['a string rejection', 'rejecting-string', /source failed.*boom-string/s],
  ])(
    'a throwing source (%s) is contained: fail with the mapped message, no throw crosses the seam',
    async (_kind, sourceId, pattern) => {
      await plantBaseline(DIRECTIONS[0], 3);
      await expect(check(checkInput({ sourceId }))).resolves.toEqual({
        status: 'ok',
        value: {
          path: REL,
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(pattern),
        },
      });
    },
  );

  test('a THROWING direction getter is contained by the snapshot (review-debt #72): fail, never a throw', async () => {
    // `direction` was read AFTER the guarded value/unit snapshot — at the
    // identity check, the comparison, and the fail reason — so a hostile
    // getter escaped the op seam. The snapshot now materializes it inside
    // the same containment.
    await expect(
      check(
        checkInput({
          metric: THROWING_DIRECTION_GETTER_METRIC,
          sourceId: THROWING_DIRECTION_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, THROWING_DIRECTION_GETTER_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /metric 'throwing-direction-getter' adapter produced an unusable reading.*direction getter exploded/s,
        ),
      },
    });
  });

  test('a thrown value whose MESSAGE getter throws is contained (review-debt #72): unknown error, never a second throw', async () => {
    await expect(
      check(
        checkInput({
          metric: THROWING_MESSAGE_GETTER_METRIC,
          sourceId: THROWING_MESSAGE_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, THROWING_MESSAGE_GETTER_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /metric 'throwing-message-getter' adapter failed.*unknown error/s,
        ),
      },
    });
  });

  test('a throwing adapter is contained: fail with the mapped message', async () => {
    await expect(
      check(checkInput({ metric: THROWING_METRIC, sourceId: THROWING_METRIC })),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, THROWING_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(/metric 'throwing-adapter' adapter failed.*exploded/s),
      },
    });
  });

  test('a throwing reading-getter is contained: fail as an unusable reading (no rejection)', async () => {
    await expect(
      check(
        checkInput({
          metric: THROWING_VALUE_GETTER_METRIC,
          sourceId: THROWING_VALUE_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, THROWING_VALUE_GETTER_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /metric 'throwing-value-getter' adapter produced an unusable reading.*value getter exploded/s,
        ),
      },
    });
  });

  test('a symlinked baseline leaf (byte-valid content outside ws) fails the leaf check, never read as evidence', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-check-outside-'));
    try {
      await mkdir(join(ws, 'baselines'), { recursive: true });
      const outsideFile = join(outside, 'elsewhere.json');
      await writeFile(
        outsideFile,
        renderBaseline({
          schemaVersion: 1,
          target: TARGET,
          metric: METRIC,
          direction: 'lower-is-better',
          value: 3,
          unit: 'errors',
          capturedAt: CAPTURED_AT,
        }),
        'utf8',
      );
      await symlink(outsideFile, join(ws, REL));
      raws[METRIC] = { count: 2 };
      // lstat sees the link itself — even byte-VALID evidence behind a
      // symlink is refused, mirroring captureBaseline's write-path leaf
      // check and prune's scan guard.
      await expect(check(checkInput())).resolves.toEqual({
        status: 'ok',
        value: {
          path: REL,
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(/is not a regular file — refusing to read as evidence/),
        },
      });
      // The link was never followed — the outside bytes are untouched.
      expect(await readFile(outsideFile, 'utf8')).toContain('"value": 3');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a directory squatting at the baseline path fails the leaf check — wording distinct from not-found', async () => {
    raws[METRIC] = { count: 2 };
    await mkdir(join(ws, REL), { recursive: true });
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        // The non-ENOENT refusal — negative lookahead pins that it is NOT
        // the missing-baseline 'not found' wording.
        reason: match.stringMatching(
          /^(?!.*not found).*is not a regular file — refusing to read as evidence/,
        ),
      },
    });
  });

  test.each([
    {
      label: "plant 'errors', check 'failures'",
      plantUnit: 'errors' as string | undefined,
      raw: { count: 2, unit: 'failures' },
      pattern: /disagrees on unit 'errors' → 'failures' — incomparable scale/,
    },
    {
      label: "plant 'errors', check undefined",
      plantUnit: 'errors' as string | undefined,
      raw: { count: 2 },
      pattern: /disagrees on unit 'errors' → undefined — incomparable scale/,
    },
    {
      label: "plant undefined, check 'errors'",
      plantUnit: undefined as string | undefined,
      raw: { count: 2, unit: 'errors' },
      pattern: /disagrees on unit undefined → 'errors' — incomparable scale/,
    },
  ])(
    'a unit disagreement fails as incomparable scale ($label)',
    async ({ plantUnit, raw, pattern }) => {
      raws[UNIT_SHIFTING_METRIC] = raw;
      await plantBaseline(
        {
          label: 'lower-is-better',
          metric: UNIT_SHIFTING_METRIC,
          ...(plantUnit === undefined ? {} : { unit: plantUnit }),
        },
        3,
      );
      await expect(
        check(checkInput({ metric: UNIT_SHIFTING_METRIC, sourceId: UNIT_SHIFTING_METRIC })),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          path: baselineRelPath(TARGET, UNIT_SHIFTING_METRIC),
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(pattern),
        },
      });
    },
  );

  test('same-unit checks pass untouched — including unit-undefined ≡ unit-undefined', async () => {
    raws[UNIT_SHIFTING_METRIC] = { count: 2 };
    await plantBaseline({ label: 'lower-is-better', metric: UNIT_SHIFTING_METRIC }, 3);
    await expect(
      check(checkInput({ metric: UNIT_SHIFTING_METRIC, sourceId: UNIT_SHIFTING_METRIC })),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, UNIT_SHIFTING_METRIC),
        verdict: 'pass',
        baselineValue: 3,
        currentValue: 2,
      },
    });
  });

  test('a baselines dir symlinked outside the ws fails (P1 containment on reads too)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-check-outside-'));
    try {
      await symlink(outside, join(ws, 'baselines'), 'dir');
      raws[METRIC] = { count: 2 };
      await expect(check(checkInput())).resolves.toEqual({
        status: 'ok',
        value: {
          path: REL,
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(/does not resolve to a strict descendant of the workspace/),
        },
      });
      // Nothing outside was read as evidence and nothing was written there.
      await expect(readFile(join(outside, 'anything.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
