// checkRatchet — lane H slice 1 (goal H2, ws-h scope items 5–6).
//
// createCheckRatchet is a kernel Op factory (data-in/data-out, OpResult
// taxonomy): it reads ONE live metric reading through a MetricSource and
// compares it against the committed baseline in <ws>/baselines, returning a
// pass/fail VERDICT as data. The ratchet has exactly one direction of
// travel: thresholds only tighten. `loosens` from format.ts is the sole
// comparator — equal values pass (an unchanged metric never blocks the
// run), anything that regresses fails with expected vs actual in the
// reason.
//
// I5 — the failure direction, named and load-bearing (UC §5 row 56's
// `no-summary` lesson, enforced here as a hard rule): absent evidence is
// NEVER passing evidence. A null source reading, an adapter that yields
// null/undefined/a non-object, a throwing source or adapter, a missing or
// corrupt baseline, an unresolved sourceId, a baselines dir that escapes
// the workspace — EVERY failure mode below lands on verdict:'fail' with a
// `reason` naming what failed (file + metric + expected vs actual, or the
// no-summary/I5 wording). The corollary is pinned by construction: the
// pass verdict is reachable ONLY through the loosens() comparison of two
// usable numbers, so an absent summary can never ride a would-have-passed
// baseline to a pass. The op never throws and never returns a non-ok
// status: the verdict is plain data, so a failing check composes like any
// other outcome instead of crashing the run.
//
// CODEX P1 (op-input serializability), the same seam as
// createCaptureBaseline: the input carries only ids (metric, sourceId) —
// plain data that survives the kernel's structuredClone of Job.input; the
// MetricSource functions live in the SourceCatalog injected once at
// composition time. Every boundary is contained the same way too: a
// throwing source or adapter, a type-violating reading, and throwing
// adapter-owned getters are all mapped to fail verdicts by the small
// errorMessage helper (rejections are not assumed to be Errors); nothing
// crosses the op seam. Baseline reads go through captureBaseline's
// resolveBaselinesDir (shared this slice — additive export, no behavior
// change), so the P1 strict-descendant containment applies to reads
// exactly as it does to writes: a symlinked baselines dir pointing outside
// the workspace is a fail, never a source of evidence.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Op, OpResult } from '../../kernel/types.js';
import { resolveBaselinesDir } from './captureBaseline.js';
import type { SourceCatalog } from './captureBaseline.js';
import { baselineRelPath, loosens, parseBaseline } from './format.js';
import type { BaselineFile } from './format.js';
import { getAdapter } from './registry.js';

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Any thrown value → a message string (the same containment helper
 * captureBaseline uses, copied locally rather than refactored out this
 * slice): Error → .message; object with a non-empty string message → it;
 * string → itself; anything else (null/undefined/plain object) → 'unknown
 * error'.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
    return 'unknown error';
  }
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/** Check one (target, metric) reading against its committed baseline. Fully serializable: survives structuredClone. */
export interface CheckRatchetInput {
  ws: string;
  target: string;
  metric: string;
  /** Key into the check catalog injected via createCheckRatchet. */
  sourceId: string;
}

export interface CheckRatchetOutcome {
  /** Repo-relative baseline path that was checked, e.g. 'baselines/typecheck--typecheck-count--7caef1e76077.json'. */
  path: string;
  /** 'pass' ONLY when two usable numbers were compared and did not loosen — never on absent evidence (I5). */
  verdict: 'pass' | 'fail';
  /** The committed baseline value; null unless the comparison ran (no usable baseline). */
  baselineValue: number | null;
  /** The live reading; null unless the comparison ran (no usable reading). */
  currentValue: number | null;
  /** Required on fail: names WHAT failed (file + metric + expected vs actual, or the no-summary/I5 wording). */
  reason?: string;
}

/** Build the check op over a fixed source catalog (see the CODEX P1 note above). */
export function createCheckRatchet(
  sources: SourceCatalog,
): Op<CheckRatchetInput, CheckRatchetOutcome> {
  return async (input) => {
    // Top input guard (round 2): the kernel's input schema should make
    // malformed inputs unreachable, but the op seam owns its own
    // defensiveness — baselineRelPath would throw on a non-string
    // (toLowerCase), and a throw must never cross the op seam. A missing or
    // non-typed field becomes a fail VERDICT with arg-error wording; no
    // path is constructed, so the outcome's path is empty.
    for (const [name, value] of [
      ['ws', input.ws],
      ['target', input.target],
      ['metric', input.metric],
      ['sourceId', input.sourceId],
    ] as const) {
      if (typeof value !== 'string') {
        return {
          status: 'ok',
          value: {
            path: '',
            verdict: 'fail',
            baselineValue: null,
            currentValue: null,
            reason: `ratchet: invalid input — '${name}' must be a string`,
          },
        };
      }
    }
    const relPath = baselineRelPath(input.target, input.metric);
    // Every failure mode funnels through here: a fail VERDICT delivered as
    // a ok-status OpResult — never a throw, never a fabricated pass.
    // baselineValue/currentValue stay null unless the comparison actually
    // ran: that is the only point at which both sides are usable evidence
    // (an incomparable or absent side is exactly what I5 forbids passing
    // on, so it is not reported as a number).
    const fail = (reason: string): OpResult<CheckRatchetOutcome> => ({
      status: 'ok',
      value: { path: relPath, verdict: 'fail', baselineValue: null, currentValue: null, reason },
    });
    // Rule 4 wording, shared by the missing-file and missing-dir cases: the
    // path is named, and the lesson is spelled out — this is non-passing
    // evidence, never a pass.
    const notFound =
      `ratchet: baseline '${relPath}' not found — ` +
      `metric '${input.metric}' baseline not found (non-passing evidence)`;

    // Rule 1: unknown metric — arg-error semantics in the reason, still a
    // verdict, not a throw.
    const adapter = getAdapter(input.metric);
    if (adapter === undefined) {
      return fail(`ratchet: unknown metric '${input.metric}' — no registered adapter`);
    }
    // Rule 2: source unresolved from the catalog injected at composition
    // time (runtime-only wiring; never part of the op input).
    const source = sources.get(input.sourceId);
    if (source === undefined) {
      return fail(
        `ratchet: unknown source '${input.sourceId}' for metric '${input.metric}' — ` +
          'not in the check catalog',
      );
    }

    // Rule 2 (containment): a throwing/rejecting source is mapped to a fail
    // verdict; rejections are not assumed to be Errors.
    let raw: unknown;
    try {
      raw = await source(input.ws);
    } catch (err) {
      return fail(`ratchet: metric '${input.metric}' source failed — ${errorMessage(err)}`);
    }
    // Rule 3 (containment): a throwing adapter is likewise a fail verdict.
    let reading: ReturnType<typeof adapter.extract>;
    try {
      reading = raw === null ? null : adapter.extract(raw);
    } catch (err) {
      return fail(`ratchet: metric '${input.metric}' adapter failed — ${errorMessage(err)}`);
    }
    // Rule 3: null raw, null/undefined extract, and any non-object where a
    // MetricReading was declared (a type-violating adapter) are ALL the same
    // I5 non-passing evidence — the exact UC §5 row 56 `no-summary` lesson —
    // never a TypeError on a later dereference and never a pass.
    if (reading == null || typeof reading !== 'object') {
      return fail(
        `ratchet: metric '${input.metric}' has no metrics summary ` +
          '(I5: non-passing evidence, never a pass)',
      );
    }
    // The reading is ADAPTER-OWNED: its fields may be getters or a hostile
    // Proxy that throws on access, so BOTH fields are materialized ONCE
    // inside this containment — a throwing getter (unit included) must fail
    // the check here, mapped to a fail verdict, never escape the op seam.
    // `unit` rides along for the identity check against the committed
    // baseline; only `value` participates in the comparison. A non-finite
    // value is unusable comparison evidence, so it fails the same way.
    let value: number;
    let unit: string | undefined;
    try {
      const materialized = { value: reading.value, unit: reading.unit };
      value = materialized.value;
      unit = materialized.unit;
      if (!Number.isFinite(value)) {
        return fail(
          `ratchet: metric '${input.metric}' adapter produced an unusable reading ` +
            `(${value}) — nothing to compare`,
        );
      }
    } catch (err) {
      return fail(
        `ratchet: metric '${input.metric}' adapter produced an unusable reading — ` +
          `${errorMessage(err)}`,
      );
    }

    // Rule 4 (P1 containment before any read): the baselines dir must be a
    // strict descendant of the ws. A missing dir is the ordinary
    // no-baseline-yet case — non-passing evidence, not a pass; an escape
    // fails with the resolver's message naming the resolved path.
    const containment = await resolveBaselinesDir(input.ws);
    if (containment.ok === false) {
      if (containment.missing) return fail(notFound);
      return fail(containment.error);
    }
    // Read through the RESOLVED dir: relPath's 'baselines/' prefix is the
    // virtual repo-relative form; containment guarantees it maps here.
    const absPath = join(containment.dir, relPath.slice('baselines/'.length));
    // Leaf check BEFORE the read (the same guard captureBaseline's write
    // path and prune's scan carry): lstat — not stat — so a symlink at the
    // leaf is seen as itself. Anything that is not a regular file
    // (symlink/fifo/dir) is refused as evidence, even when its bytes would
    // have parsed; an ENOENT here falls through to the readFile containment
    // below for the ordinary not-found wording.
    // RESIDUAL (recorded, round 2): the lstat→readFile pair is a TOCTOU
    // window (a leaf swapped to a symlink between the two calls would be
    // read); accepted for this read-only check path under the same merged
    // pattern as captureBaseline — tracked with the H2 review findings
    // (PR #74 review thread, round 2).
    try {
      const leafStat = await lstat(absPath);
      if (leafStat.isFile() === false) {
        return fail(
          `ratchet: baseline '${relPath}' is not a regular file — refusing to read as evidence`,
        );
      }
    } catch {
      // Inspectability faults (ENOENT, EACCES, ...) land on the readFile
      // containment below — every path from here is a fail naming the path.
    }
    let text: string;
    try {
      text = await readFile(absPath, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return fail(notFound);
      return fail(`ratchet: could not read baseline '${relPath}' — ${errorMessage(err)}`);
    }
    // Rule 4: corrupt/unparsable baseline — fail naming the path. Committed
    // evidence that cannot be parsed cannot vouch for anything.
    let baseline: BaselineFile;
    try {
      baseline = parseBaseline(text);
    } catch (err) {
      return fail(`ratchet: baseline '${relPath}' is corrupt — ${errorMessage(err)}`);
    }

    // Rule 5: identity check BEFORE the value is trusted — a baseline whose
    // (target, metric, direction) disagrees with the current capture context
    // is incomparable evidence, and every disagreeing field is named with
    // both sides.
    const disagreements: string[] = [];
    if (baseline.target !== input.target) {
      disagreements.push(`target '${baseline.target}' → '${input.target}'`);
    }
    if (baseline.metric !== input.metric) {
      disagreements.push(`metric '${baseline.metric}' → '${input.metric}'`);
    }
    if (baseline.direction !== adapter.direction) {
      disagreements.push(`direction '${baseline.direction}' → '${adapter.direction}'`);
    }
    if (disagreements.length > 0) {
      return fail(
        `ratchet: baseline '${relPath}' for metric '${input.metric}' disagrees on ` +
          `${disagreements.join('; ')} — incomparable evidence`,
      );
    }
    // Unit identity: values in different units — undefined counting as a
    // value on BOTH sides — are never the same ratchet evidence
    // ('incomparable scale'), the check-side twin of captureBaseline's
    // write-time unit refusal. A number re-scaled from errors to failures,
    // or a unit appearing/vanishing between capture and check, would
    // otherwise compare incommensurables.
    if (baseline.unit !== unit) {
      const renderUnit = (u: string | undefined): string => (u === undefined ? 'undefined' : `'${u}'`);
      return fail(
        `ratchet: baseline '${relPath}' for metric '${input.metric}' disagrees on ` +
          `unit ${renderUnit(baseline.unit)} → ${renderUnit(unit)} — incomparable scale`,
      );
    }

    // Rule 6: the ONLY path to 'pass'. Equal or tightening passes with both
    // values; loosening fails with expected vs actual in the reason.
    if (loosens(baseline.value, value, adapter.direction)) {
      return {
        status: 'ok',
        value: {
          path: relPath,
          verdict: 'fail',
          baselineValue: baseline.value,
          currentValue: value,
          reason:
            `ratchet: metric '${input.metric}' loosened: baseline ${baseline.value} → ` +
            `current ${value} (${adapter.direction}) — only tightening passes`,
        },
      };
    }
    return {
      status: 'ok',
      value: {
        path: relPath,
        verdict: 'pass',
        baselineValue: baseline.value,
        currentValue: value,
      },
    };
  };
}
