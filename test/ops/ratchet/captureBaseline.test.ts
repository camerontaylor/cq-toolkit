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
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { typecheckCount } from '../../../src/ops/ratchet/adapters/typecheckCount.js';
import { createCaptureBaseline, pruneBaselines } from '../../../src/ops/ratchet/captureBaseline.js';
import type {
  CaptureBaselineInput,
  SourceCatalog,
} from '../../../src/ops/ratchet/captureBaseline.js';
import { baselineRelPath, parseBaseline, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile, Direction } from '../../../src/ops/ratchet/format.js';
import type { MetricReading, MetricSource } from '../../../src/ops/ratchet/registry.js';
import { registerAdapter } from '../../../src/ops/ratchet/registry.js';

const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
const CAPTURED_AT_2 = '2026-09-15T01:00:00.000Z';
const TARGET = 'typecheck';
const METRIC = 'typecheck-count';
const THROWING_METRIC = 'throwing-adapter';
const OBJECT_THROWING_METRIC = 'object-throwing-adapter';
const CRAFTED_INFINITE_METRIC = 'crafted-infinite';
const UNIT_SHIFTING_METRIC = 'unit-shifting';
const NULL_UNIT_METRIC = 'null-unit';
const BAD_DIRECTION_METRIC = 'bad-direction';
const BIGINT_UNIT_METRIC = 'bigint-unit';
const UNDEFINED_READING_METRIC = 'undefined-reading';
const THROWING_VALUE_GETTER_METRIC = 'throwing-value-getter';
const THROWING_DIRECTION_GETTER_METRIC = 'throwing-direction-getter';
const THROWING_MESSAGE_GETTER_METRIC = 'throwing-message-getter';
const THROWING_UNIT_GETTER_METRIC = 'throwing-unit-getter';
const REL = baselineRelPath(TARGET, METRIC);

let ws: string;
// The raw data the catalog's sources hand to the adapters; set per test.
let sourceRaw: unknown;

beforeAll(() => {
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
});

// Sources are composition-time wiring (round-1 fix): they live in this
// catalog, never in the op input — the input only carries the sourceId.
const sources: SourceCatalog = new Map<string, MetricSource>([
  [METRIC, () => Promise.resolve(sourceRaw)],
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
  [UNIT_SHIFTING_METRIC, () => Promise.resolve(sourceRaw)],
  ['exploding-source', () => Promise.reject(new Error('boom'))],
  ['rejecting-null', () => Promise.reject(null)],
  ['rejecting-string', () => Promise.reject('boom-string')],
]);
const capture = createCaptureBaseline(sources);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-capture-'));
  sourceRaw = undefined;
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function captureInput(overrides: Partial<CaptureBaselineInput> = {}): CaptureBaselineInput {
  return {
    ws,
    target: TARGET,
    metric: METRIC,
    sourceId: METRIC,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

describe('captureBaseline', () => {
  test('the op input is plain data: structuredClone-safe (kernel makeManifest clones Job.input)', () => {
    expect(() => structuredClone(captureInput())).not.toThrow();
  });

  test('created: fresh ws writes the baseline and reports lifecycle created', async () => {
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 3, previous: null, lifecycle: 'created' },
    });
    const expected: BaselineFile = {
      schemaVersion: 1,
      target: TARGET,
      metric: METRIC,
      direction: 'lower-is-better',
      value: 3,
      unit: 'errors',
      capturedAt: CAPTURED_AT,
    };
    expect(await readFile(join(ws, REL), 'utf8')).toBe(renderBaseline(expected));
    expect(parseBaseline(await readFile(join(ws, REL), 'utf8'))).toEqual(expected);
  });

  test('capturedAt defaults to the clock when not injected (parses as ISO-8601)', async () => {
    sourceRaw = { count: 1 };
    const input = captureInput();
    delete input.capturedAt;
    const result = await capture(input);
    expect(result.status).toBe('ok');
    const onDisk = parseBaseline(await readFile(join(ws, REL), 'utf8'));
    expect(Number.isNaN(Date.parse(onDisk.capturedAt))).toBe(false);
  });

  test('updated: a moved value carries previous and rewrites the file', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    sourceRaw = { count: 5 };
    await expect(capture(captureInput({ capturedAt: CAPTURED_AT_2 }))).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 5, previous: 3, lifecycle: 'updated' },
    });
    expect(parseBaseline(await readFile(join(ws, REL), 'utf8')).value).toBe(5);
  });

  test('unchanged: equal value, identical bytes → no rewrite (forced old mtime untouched)', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    const abs = join(ws, REL);
    await utimes(abs, new Date(1000), new Date(1000));
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 3, previous: 3, lifecycle: 'unchanged' },
    });
    expect((await stat(abs)).mtimeMs).toBe(1000);
  });

  test('unchanged: equal value but different bytes (new capturedAt) is rewritten in place', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    await expect(capture(captureInput({ capturedAt: CAPTURED_AT_2 }))).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 3, previous: 3, lifecycle: 'unchanged' },
    });
    expect(parseBaseline(await readFile(join(ws, REL), 'utf8')).capturedAt).toBe(CAPTURED_AT_2);
  });

  test('unknown metric fails with an arg-style error', async () => {
    await expect(capture(captureInput({ metric: 'no-such-metric' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/unknown metric 'no-such-metric'/),
    });
  });

  test('unknown sourceId fails naming the source', async () => {
    await expect(capture(captureInput({ sourceId: 'no-such-source' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/unknown source 'no-such-source' for metric 'typecheck-count'/),
    });
  });

  test('null source fails naming the metric and "no metrics summary" — and fabricates no evidence', async () => {
    sourceRaw = null;
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/metric 'typecheck-count'.*no metrics summary/s),
    });
    // I5 evidence pin: a failed capture must not even create the baselines dir.
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a failed capture leaves a pre-existing baseline byte-for-byte intact (I5)', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    const before = await readFile(join(ws, REL), 'utf8');
    sourceRaw = null;
    await expect(capture(captureInput())).resolves.toMatchObject({ status: 'failed' });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(before);
  });

  test('unusable raw fails with the same no-summary failure and writes nothing', async () => {
    sourceRaw = 'definitely not a compiler log';
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/no metrics summary/s),
    });
    await expect(readFile(join(ws, REL), 'utf8')).rejects.toThrow();
  });

  test('a throwing source fails instead of crashing the op', async () => {
    await expect(capture(captureInput({ sourceId: 'exploding-source' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/source failed.*boom/s),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a THROWING direction getter fails the capture inside the snapshot containment (review-debt #72)', async () => {
    await expect(
      capture(
        captureInput({
          metric: THROWING_DIRECTION_GETTER_METRIC,
          sourceId: THROWING_DIRECTION_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /metric 'throwing-direction-getter' adapter produced an unusable reading.*direction getter exploded/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a thrown value whose MESSAGE getter throws maps to unknown error (review-debt #72)', async () => {
    await expect(
      capture(
        captureInput({
          metric: THROWING_MESSAGE_GETTER_METRIC,
          sourceId: THROWING_MESSAGE_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /metric 'throwing-message-getter' adapter failed.*unknown error/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a throwing adapter fails the capture; no throw crosses the op seam', async () => {
    await expect(
      capture(captureInput({ metric: THROWING_METRIC, sourceId: THROWING_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/metric 'throwing-adapter' adapter failed.*exploded/s),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a type-violating adapter returning undefined fails as no-summary (no throw)', async () => {
    await expect(
      capture(
        captureInput({ metric: UNDEFINED_READING_METRIC, sourceId: UNDEFINED_READING_METRIC }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /metric 'undefined-reading' has no metrics summary.*never a pass/s,
      ),
    });
    // The failure fabricated no evidence — nothing was written.
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a throwing value getter fails as an unusable reading (no rejection, no file)', async () => {
    await expect(
      capture(
        captureInput({
          metric: THROWING_VALUE_GETTER_METRIC,
          sourceId: THROWING_VALUE_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /metric 'throwing-value-getter' adapter produced an unusable reading.*value getter exploded/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a throwing unit getter fails as an unusable reading (no rejection, no file)', async () => {
    await expect(
      capture(
        captureInput({
          metric: THROWING_UNIT_GETTER_METRIC,
          sourceId: THROWING_UNIT_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /metric 'throwing-unit-getter' adapter produced an unusable reading.*unit getter exploded/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a null rejection fails with the fallback message, never a TypeError', async () => {
    await expect(capture(captureInput({ sourceId: 'rejecting-null' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/source failed.*unknown error/s),
    });
  });

  test('a string rejection carries that string', async () => {
    await expect(capture(captureInput({ sourceId: 'rejecting-string' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/source failed.*boom-string/s),
    });
  });

  test('an adapter throwing a plain object fails with its message, not a TypeError', async () => {
    await expect(
      capture(captureInput({ metric: OBJECT_THROWING_METRIC, sourceId: OBJECT_THROWING_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/adapter failed.*plain boom/s),
    });
  });

  test('a non-finite reading fails at the write path and writes nothing', async () => {
    await expect(
      capture(captureInput({ metric: CRAFTED_INFINITE_METRIC, sourceId: CRAFTED_INFINITE_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/metric 'crafted-infinite'.*unusable reading/s),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a probe adapter returning unit null fails the publish self-check (no file)', async () => {
    await expect(
      capture(captureInput({ metric: NULL_UNIT_METRIC, sourceId: NULL_UNIT_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /metric 'null-unit' produced an unparsable baseline — refusing to publish.*unit/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a probe adapter with a bogus direction fails at the snapshot boundary (no file)', async () => {
    // review-debt #72: the direction is materialized with the reading
    // snapshot and validated against the two literals THERE — earlier and
    // clearer than the old render/parse-back self-check, and a throwing
    // direction getter can no longer escape the op seam either.
    await expect(
      capture(captureInput({ metric: BAD_DIRECTION_METRIC, sourceId: BAD_DIRECTION_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /metric 'bad-direction' adapter produced an unusable direction \(sideways\) — baseline not captured/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a probe adapter returning a BigInt unit fails the render containment (no throw, no file)', async () => {
    await expect(
      capture(captureInput({ metric: BIGINT_UNIT_METRIC, sourceId: BIGINT_UNIT_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /metric 'bigint-unit' produced an unparsable baseline — refusing to publish/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('an unparseable capturedAt fails with arg-error semantics', async () => {
    sourceRaw = { count: 1 };
    await expect(capture(captureInput({ capturedAt: 'not-a-date' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/invalid capturedAt 'not-a-date'/),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('non-ISO and calendar-rollover capturedAt fail the strict instant check', async () => {
    sourceRaw = { count: 1 };
    for (const bad of ['September 15, 2026', '2026-02-30T00:00:00Z']) {
      await expect(capture(captureInput({ capturedAt: bad }))).resolves.toEqual({
        status: 'failed',
        error: expect.stringMatching(/invalid capturedAt.*strict ISO-8601/s),
      });
    }
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('strict-but-legitimate capturedAt forms are accepted (numeric offset, nanoseconds)', async () => {
    sourceRaw = { count: 1 };
    await expect(
      capture(captureInput({ capturedAt: '2026-09-15T12:00:00+02:00' })),
    ).resolves.toMatchObject({ status: 'ok' });
    sourceRaw = { count: 2 };
    await expect(
      capture(
        captureInput({ target: 'typecheck-nanos', capturedAt: '2026-09-15T10:00:00.123456789Z' }),
      ),
    ).resolves.toMatchObject({ status: 'ok' });
  });

  test('the publish is atomic: no temp files linger after captures', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    sourceRaw = { count: 5 };
    await capture(captureInput({ capturedAt: CAPTURED_AT_2 }));
    const names = await readdir(join(ws, 'baselines'));
    expect(names).toEqual([basename(REL)]);
  });

  test('a 400+ char deep-nested target captures cleanly (truncated segments, no ENAMETOOLONG)', async () => {
    sourceRaw = { count: 1 };
    const deepTarget = `src/${'a/b/'.repeat(99)}deep.ts`; // 411 chars
    const result = await capture(captureInput({ target: deepTarget }));
    expect(result.status).toBe('ok');
    const relPath = baselineRelPath(deepTarget, METRIC);
    expect(relPath.length).toBeLessThanOrEqual(255);
    for (const segment of relPath.split('/')) {
      expect(segment.length).toBeLessThanOrEqual(255);
    }
    // The write itself succeeded — no ENAMETOOLONG — and the file is readable.
    await expect(readFile(join(ws, relPath), 'utf8')).resolves.toContain('"target"');
  });

  test('corrupt existing baseline fails and is left untouched', async () => {
    sourceRaw = { count: 3 };
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const corrupt = '{"schemaVersion": 999}\n';
    await writeFile(join(ws, REL), corrupt, 'utf8');
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/corrupt and was not overwritten/s),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(corrupt);
  });

  test('a directory squatting at the baseline path fails the leaf check (not a regular file)', async () => {
    sourceRaw = { count: 3 };
    // A DIRECTORY where the file belongs: lstat sees it before any read —
    // not a regular file, so capture refuses outright.
    await mkdir(join(ws, REL), { recursive: true });
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/not a regular file — refusing/),
    });
  });

  test('a symlinked baseline leaf with byte-identical outside content fails the leaf check', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await mkdir(join(ws, 'baselines'), { recursive: true });
      const bytes = renderBaseline({
        schemaVersion: 1,
        target: TARGET,
        metric: METRIC,
        direction: 'lower-is-better',
        value: 3,
        unit: 'errors',
        capturedAt: CAPTURED_AT,
      });
      const outsideFile = join(outside, 'elsewhere-baseline.json');
      await writeFile(outsideFile, bytes, 'utf8');
      await symlink(outsideFile, join(ws, REL));
      sourceRaw = { count: 3 };
      // The leaf is a symlink to a byte-identical file: without the lstat
      // check the read would follow it and return ok/unchanged.
      await expect(capture(captureInput())).resolves.toEqual({
        status: 'failed',
        error: expect.stringMatching(/not a regular file — refusing/),
      });
      expect(await readFile(outsideFile, 'utf8')).toBe(bytes); // outside untouched
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a pre-planted temp-name symlink does not truncate the outside target', async () => {
    // A fresh module instance starts its temp counter at 0, making the
    // EXACT next temp name predictable (...1.tmp).
    vi.resetModules();
    try {
      const captureMod = await import('../../../src/ops/ratchet/captureBaseline.js');
      const registryMod = await import('../../../src/ops/ratchet/registry.js');
      registryMod.registerAdapter(typecheckCount);
      const captureFresh = captureMod.createCaptureBaseline(
        new Map([[METRIC, () => Promise.resolve(sourceRaw)]]),
      );

      const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
      try {
        await mkdir(join(ws, 'baselines'), { recursive: true });
        const outsideFile = join(outside, 'precious.txt');
        await writeFile(outsideFile, 'precious — must not be truncated', 'utf8');
        const planted = join(ws, 'baselines', `.${basename(REL)}.${process.pid}.1.tmp`);
        await symlink(outsideFile, planted);

        sourceRaw = { count: 3 };
        await expect(captureFresh(captureInput())).resolves.toEqual({
          status: 'ok',
          value: { path: REL, value: 3, previous: null, lifecycle: 'created' },
        });
        expect(await readFile(join(ws, REL), 'utf8')).toContain('"value": 3');
        expect(await readFile(outsideFile, 'utf8')).toBe('precious — must not be truncated');

        // Exhaustion: plant EVERY remaining temp name — the bounded retries
        // give up as indeterminate, and the colliding entries stay untouched
        // (cleanup only removes a temp this invocation created).
        for (let c = 3; c <= 7; c++) {
          await symlink(
            outsideFile,
            join(ws, 'baselines', `.${basename(REL)}.${process.pid}.${c}.tmp`),
          );
        }
        sourceRaw = { count: 9 };
        await expect(captureFresh(captureInput({ capturedAt: CAPTURED_AT_2 }))).resolves.toEqual({
          status: 'indeterminate',
          detail: expect.stringMatching(/writing baseline.*failed/s),
        });
        const tempDebris = (await readdir(join(ws, 'baselines')))
          .filter((n) => n.endsWith('.tmp'))
          .sort();
        // Leg 1's planted .1 link and leg 2's planted .3–.7 links: ALL still
        // there — none of them was created by this invocation.
        expect(tempDebris).toEqual(
          [1, 3, 4, 5, 6, 7].map((c) => `.${basename(REL)}.${process.pid}.${c}.tmp`),
        );
        expect(await readFile(outsideFile, 'utf8')).toBe('precious — must not be truncated');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      vi.resetModules(); // later tests keep using the static module bindings
    }
  });

  test('planting ALL five temp names exhausts the retries — indeterminate, all untouched', async () => {
    // A fresh module instance starts its temp counter at 0, so the five
    // candidates are exactly counters 1..5 — plant every one of them.
    vi.resetModules();
    try {
      const captureMod = await import('../../../src/ops/ratchet/captureBaseline.js');
      const registryMod = await import('../../../src/ops/ratchet/registry.js');
      registryMod.registerAdapter(typecheckCount);
      const captureFresh = captureMod.createCaptureBaseline(
        new Map([[METRIC, () => Promise.resolve(sourceRaw)]]),
      );

      const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
      try {
        await mkdir(join(ws, 'baselines'), { recursive: true });
        const outsideFile = join(outside, 'precious.txt');
        await writeFile(outsideFile, 'precious — must not be truncated', 'utf8');
        const plantedNames = [1, 2, 3, 4, 5].map(
          (c) => `.${basename(REL)}.${process.pid}.${c}.tmp`,
        );
        for (const name of plantedNames) {
          await symlink(outsideFile, join(ws, 'baselines', name));
        }
        sourceRaw = { count: 3 };
        await expect(captureFresh(captureInput())).resolves.toEqual({
          status: 'indeterminate',
          detail: expect.stringMatching(/writing baseline.*failed/s),
        });
        // Every colliding entry is untouched — cleanup never deletes a temp
        // this invocation did not create.
        expect((await readdir(join(ws, 'baselines'))).sort()).toEqual([...plantedNames].sort());
        expect(await readFile(outsideFile, 'utf8')).toBe('precious — must not be truncated');
        // And no baseline was published anywhere.
        await expect(stat(join(ws, REL))).rejects.toThrow();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      vi.resetModules(); // later tests keep using the static module bindings
    }
  });

  test('a valid baseline for ANOTHER target at the expected path fails the identity check, untouched', async () => {
    // Mistaken move: a fully valid baseline whose (target, metric, direction)
    // identity disagrees with this capture sits at the expected path.
    const foreign: BaselineFile = {
      schemaVersion: 1,
      target: 'elsewhere',
      metric: METRIC,
      direction: 'lower-is-better',
      value: 9,
      capturedAt: CAPTURED_AT,
    };
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const foreignBytes = renderBaseline(foreign);
    await writeFile(join(ws, REL), foreignBytes, 'utf8');
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      // The foreign baseline differs in target AND unit (it carries none) —
      // the message lists every disagreeing field.
      error: expect.stringMatching(
        /disagrees on target 'elsewhere' → 'typecheck'; unit undefined → 'errors' — incomparable scale — refusing to overwrite/s,
      ),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(foreignBytes);
  });

  test('a unit change fails the identity check as incomparable scale, untouched', async () => {
    const input = captureInput({
      target: 'unit-a',
      metric: UNIT_SHIFTING_METRIC,
      sourceId: UNIT_SHIFTING_METRIC,
    });
    sourceRaw = { count: 3, unit: 'errors' };
    await expect(capture(input)).resolves.toMatchObject({ status: 'ok' });
    sourceRaw = { count: 5 }; // reading now carries NO unit
    await expect(capture(input)).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /for metric 'unit-shifting' disagrees on unit 'errors' → undefined — incomparable scale — refusing to overwrite/,
      ),
    });
    expect(
      parseBaseline(
        await readFile(join(ws, baselineRelPath('unit-a', UNIT_SHIFTING_METRIC)), 'utf8'),
      ).unit,
    ).toBe('errors');
  });

  test('the unit mismatch is symmetric (none → defined also fails)', async () => {
    const input = captureInput({
      target: 'unit-b',
      metric: UNIT_SHIFTING_METRIC,
      sourceId: UNIT_SHIFTING_METRIC,
    });
    sourceRaw = { count: 3 }; // no unit
    await expect(capture(input)).resolves.toMatchObject({ status: 'ok' });
    sourceRaw = { count: 5, unit: 'errors' };
    await expect(capture(input)).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/disagrees on unit undefined → 'errors' — incomparable scale/),
    });
  });

  test('a unit rename (errors → failures) fails the identity check', async () => {
    const input = captureInput({
      target: 'unit-c',
      metric: UNIT_SHIFTING_METRIC,
      sourceId: UNIT_SHIFTING_METRIC,
    });
    sourceRaw = { count: 3, unit: 'errors' };
    await expect(capture(input)).resolves.toMatchObject({ status: 'ok' });
    sourceRaw = { count: 3, unit: 'failures' };
    await expect(capture(input)).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/disagrees on unit 'errors' → 'failures' — incomparable scale/),
    });
  });

  test('a metric-field disagreement fails the identity check, untouched', async () => {
    // Planted at the expected path: a fully valid baseline whose metric
    // field names some other metric.
    const foreign = renderBaseline({
      schemaVersion: 1,
      target: TARGET,
      metric: 'other-metric',
      direction: 'lower-is-better',
      value: 4,
      unit: 'errors',
      capturedAt: CAPTURED_AT,
    });
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, REL), foreign, 'utf8');
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /disagrees on metric 'other-metric' → 'typecheck-count' — incomparable scale/,
      ),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(foreign);
  });

  test('a direction disagreement fails the identity check, untouched', async () => {
    // Adapter direction flipped vs the existing baseline: same target,
    // metric, and unit — only the direction disagrees.
    const flipped = renderBaseline({
      schemaVersion: 1,
      target: TARGET,
      metric: METRIC,
      direction: 'higher-is-better',
      value: 4,
      unit: 'errors',
      capturedAt: CAPTURED_AT,
    });
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, REL), flipped, 'utf8');
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /disagrees on direction 'higher-is-better' → 'lower-is-better' — incomparable scale/,
      ),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(flipped);
  });

  test('a symlinked baselines dir pointing outside ws fails capture (nothing written outside)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await symlink(outside, join(ws, 'baselines'), 'dir');
      sourceRaw = { count: 3 };
      await expect(capture(captureInput())).resolves.toEqual({
        status: 'failed',
        error: expect.stringMatching(
          /does not resolve to a strict descendant of the workspace \('.*cq-outside-[^']*'\) — refusing/s,
        ),
      });
      await expect(readdir(outside)).resolves.toEqual([]); // nothing written outside
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('even a byte-identical baseline outside a symlinked baselines dir fails (no ok/unchanged)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      // The EXACT bytes this capture would write, planted in the outside
      // dir: through the symlink the op would see its own output and take
      // the unchanged fast path — containment must fire first.
      const bytes = renderBaseline({
        schemaVersion: 1,
        target: TARGET,
        metric: METRIC,
        direction: 'lower-is-better',
        value: 3,
        unit: 'errors',
        capturedAt: CAPTURED_AT,
      });
      await writeFile(join(outside, basename(REL)), bytes, 'utf8');
      await symlink(outside, join(ws, 'baselines'), 'dir');
      sourceRaw = { count: 3 };
      const result = await capture(captureInput());
      expect(result.status).toBe('failed');
      await expect(capture(captureInput())).resolves.toEqual({
        status: 'failed',
        error: expect.stringMatching(/does not resolve to a strict descendant of the workspace/),
      });
      expect(await readFile(join(outside, basename(REL)), 'utf8')).toBe(bytes); // untouched
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a symlinked baselines dir pointing outside ws: prune reports the fault, deletes nothing', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await writeFile(join(outside, 'stale.json'), 'precious', 'utf8');
      await symlink(outside, join(ws, 'baselines'), 'dir');
      await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
        deleted: [],
        kept: 0,
        skipped: [],
        unreadable: [],
        error: expect.stringMatching(
          /does not resolve to a strict descendant of the workspace \('.*cq-outside-[^']*'\)/,
        ),
      });
      expect(await readFile(join(outside, 'stale.json'), 'utf8')).toBe('precious');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('baselines symlinked to the ws itself fails capture (strict-descendant containment)', async () => {
    await symlink(ws, join(ws, 'baselines'), 'dir');
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/does not resolve to a strict descendant of the workspace/),
    });
    // The ws root is untouched — no baseline landed at its top level.
    await expect(readdir(ws)).resolves.toEqual(['baselines']);
  });

  test('baselines symlinked to the ws itself: prune reports the fault, scans nothing', async () => {
    await symlink(ws, join(ws, 'baselines'), 'dir');
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
      error: expect.stringMatching(/does not resolve to a strict descendant of the workspace/),
    });
    // The ws root was never scanned (a *.json there would have been
    // classified for deletion) — nothing changed.
    await expect(readdir(ws)).resolves.toEqual(['baselines']);
  });

  test('two CONCURRENT captures of one (target, metric) serialize (review-debt #68): created + unchanged, evidence consistent', async () => {
    // The kernel runner executes a wave of dependency-free jobs
    // concurrently: without the per-path lock both captures read "no
    // existing file", both publish, and the last rename wins — both report
    // 'created' while one reported result disagrees with the persisted
    // evidence. With the lock, the second capture sees the first's file.
    sourceRaw = { count: 3 };
    const results = await Promise.all([
      capture(captureInput({ capturedAt: CAPTURED_AT })),
      capture(captureInput({ capturedAt: CAPTURED_AT })),
    ]);
    const lifecycles = results
      .map((r) => (r.status === 'ok' ? r.value.lifecycle : `not-ok:${r.status}`))
      .sort();
    expect(lifecycles).toEqual(['created', 'unchanged']);
    // The persisted evidence parses and matches BOTH reports' value; the
    // 'unchanged' one carried the first's value as `previous`.
    const persisted = parseBaseline(await readFile(join(ws, REL), 'utf8'));
    expect(persisted.value).toBe(3);
    const unchanged = results.find((r) => r.status === 'ok' && r.value.lifecycle === 'unchanged');
    expect(unchanged?.status === 'ok' && unchanged.value.previous).toBe(3);
    // No lock residue: the released lock dir left nothing behind.
    expect(await readdir(join(ws, 'baselines'))).toEqual([basename(REL)]);
  });

  test('a read-only baselines dir fails fast at the capture lock (indeterminate, no debris — review-debt #68)', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    // Make the dir read-only: the per-path capture lock (review-debt #68)
    // is now the FIRST write attempted, so the failure surfaces at the
    // lock acquire — a fast indeterminate (the short backoff never burns
    // half a minute), never a mid-publish torn state. The temp-cleanup
    // path itself is pinned by the seam-injected mid-write fault test
    // (capture-temp-fault.test.ts).
    const baselinesDir = join(ws, 'baselines');
    await chmod(baselinesDir, 0o555);
    sourceRaw = { count: 5 };
    const result = await capture(captureInput({ capturedAt: CAPTURED_AT_2 }));
    await chmod(baselinesDir, 0o755); // restore before cleanup assertions
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toMatch(/could not acquire the capture lock/);
    }
    const names = await readdir(baselinesDir);
    expect(names).toEqual([basename(REL)]); // original baseline, no *.tmp debris, no *.lock residue
  });
});

describe('pruneBaselines', () => {
  async function captureBaselineFor(target: string, value: number): Promise<void> {
    sourceRaw = { count: value };
    await expect(capture(captureInput({ target }))).resolves.toMatchObject({ status: 'ok' });
  }

  test('stale baselines are deleted (relPath recorded) and live ones kept', async () => {
    await captureBaselineFor('old-target', 1);
    await captureBaselineFor(TARGET, 2);
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [baselineRelPath('old-target', METRIC)],
      kept: 1,
      skipped: [],
      unreadable: [],
    });
    await expect(
      readFile(join(ws, baselineRelPath('old-target', METRIC)), 'utf8'),
    ).rejects.toThrow();
    await expect(readFile(join(ws, REL), 'utf8')).resolves.toBeTruthy();
  });

  test('unparseable content is skipped (never deleted); non-.json files are ignored', async () => {
    await captureBaselineFor(TARGET, 2);
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, 'baselines', 'garbage.json'), 'not json', 'utf8');
    await writeFile(join(ws, 'baselines', 'notes.txt'), 'keep me', 'utf8');
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [],
      kept: 1,
      skipped: ['baselines/garbage.json'],
      unreadable: [],
    });
    expect(await readFile(join(ws, 'baselines', 'garbage.json'), 'utf8')).toBe('not json');
    expect(await readFile(join(ws, 'baselines', 'notes.txt'), 'utf8')).toBe('keep me');
  });

  test('a file whose name disagrees with its content is skipped, never deleted', async () => {
    await captureBaselineFor(TARGET, 2);
    // Valid baseline content for TARGET, stored under a foreign filename:
    // the content classifies to another file's path, so THIS file cannot
    // be classified — skipped, left untouched.
    const misnamed = join(ws, 'baselines', 'misnamed.json');
    await writeFile(
      misnamed,
      renderBaseline({
        schemaVersion: 1,
        target: TARGET,
        metric: METRIC,
        direction: 'lower-is-better',
        value: 9,
        capturedAt: CAPTURED_AT,
      }),
      'utf8',
    );
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [],
      kept: 1,
      skipped: ['baselines/misnamed.json'],
      unreadable: [],
    });
    expect(await readFile(misnamed, 'utf8')).toContain('"value": 9');
  });

  test('a directory entry is skipped (non-regular, never followed)', async () => {
    await captureBaselineFor(TARGET, 2);
    await mkdir(join(ws, 'baselines', 'weird.json'), { recursive: true });
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [],
      kept: 1,
      skipped: ['baselines/weird.json'],
      unreadable: [],
    });
    await expect(stat(join(ws, 'baselines', 'weird.json'))).resolves.toBeTruthy();
  });

  test('a symlinked entry is skipped even when its content matches live (never followed)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await mkdir(join(ws, 'baselines'), { recursive: true });
      const bytes = renderBaseline({
        schemaVersion: 1,
        target: TARGET,
        metric: METRIC,
        direction: 'lower-is-better',
        value: 7,
        unit: 'errors',
        capturedAt: CAPTURED_AT,
      });
      const outsideFile = join(outside, 'live-baseline.json');
      await writeFile(outsideFile, bytes, 'utf8');
      await symlink(outsideFile, join(ws, 'baselines', 'linked.json'));
      // Content matches live: without the lstat check the scan would follow
      // the link and count it kept — it must be skipped instead, and the
      // outside file never touched.
      await expect(
        pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
      ).resolves.toEqual({
        deleted: [],
        kept: 0,
        skipped: ['baselines/linked.json'],
        unreadable: [],
      });
      expect(await readFile(outsideFile, 'utf8')).toBe(bytes);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a FIFO entry is skipped without blocking the scan', async () => {
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const fifo = join(ws, 'baselines', 'pipe.json');
    // node:fs cannot create FIFOs; the POSIX mkfifo tool is the stand-in
    // (repo tests are POSIX-only by convention).
    const made = spawnSync('mkfifo', [fifo], { stdio: 'ignore' });
    expect(made.status).toBe(0);
    // The lstat leaf check classifies it before any readFile — the scan
    // completes instead of blocking on an open with no writer.
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: ['baselines/pipe.json'],
      unreadable: [],
    });
    await expect(stat(fifo)).resolves.toBeTruthy();
  });

  test('an unreadable regular file (I/O fault) is reported unreadable, distinct from skipped', async () => {
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const locked = join(ws, 'baselines', 'locked.json');
    await writeFile(locked, 'locked content', 'utf8');
    await chmod(locked, 0o000);
    const outcome = await pruneBaselines({ ws, live: [] }).finally(() => chmod(locked, 0o644));
    expect(outcome).toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: ['baselines/locked.json'],
    });
    await expect(readFile(locked, 'utf8')).resolves.toBe('locked content');
  });

  test('a scan that cannot start returns the zero outcome with an error, never a throw', async () => {
    // <ws>/baselines exists as a FILE → readdir fails with ENOTDIR, not ENOENT.
    await writeFile(join(ws, 'baselines'), 'i am not a directory', 'utf8');
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
      error: expect.stringMatching(/could not scan/),
    });
  });

  test('rename drill: capture a, capture b, prune live=[b] removes a', async () => {
    await captureBaselineFor(TARGET, 2);
    await captureBaselineFor('typecheck-v2', 2);
    await expect(
      pruneBaselines({ ws, live: [{ target: 'typecheck-v2', metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [REL],
      kept: 1,
      skipped: [],
      unreadable: [],
    });
    await expect(readFile(join(ws, REL), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(ws, baselineRelPath('typecheck-v2', METRIC)), 'utf8'),
    ).resolves.toBeTruthy();
  });

  test('delete drill: an empty live list removes every classifiable baseline', async () => {
    await captureBaselineFor(TARGET, 2);
    await captureBaselineFor('typecheck-v2', 3);
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [REL, baselineRelPath('typecheck-v2', METRIC)],
      kept: 0,
      skipped: [],
      unreadable: [],
    });
  });

  test('a ws with no baselines dir prunes to nothing', async () => {
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
    });
  });
});
