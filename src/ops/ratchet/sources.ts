// Metric sources for the ratchet op family — lane C's CheckRunner, wired.
//
// The metric ADAPTER registry (./metricRegistry.js) deliberately imports
// nothing from src/gates; the RUNNER stays injected. This module is the ONE
// place that binds the two: a {@link MetricSourceSpec} (plain JSON, carried
// in the op input — functions cannot survive the kernel's structuredClone)
// is turned into the `(ws) => Promise<unknown | null>` MetricSource the
// adapters read, using lane C's {@link RunCheck} seam. The registry importers
// pass `subprocessRunCheck` at BIND time (never at module scope of the metric
// registry), so baseline capture stays computable without a live toolchain
// and the adapter registry keeps its no-src/gates rule.
//
// Failure direction, named (I5): every absent/unusable source yields `null` —
// "cannot verify this metric", never "the metric passes". A command that
// exits non-zero with no parsable output, a missing/unreadable file, a JSON
// body that does not parse: all null, never a fabricated pass. The
// CheckRunner seam itself never rejects (its shipped runner resolves a
// RawCheckOutput even on spawn failure), and a foreign RunCheck that DOES
// throw is contained one level up by createCaptureBaseline/createCheckRatchet
// — this module never swallows a throw into a reading.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { RawCheckOutput, RunCheck } from '../gates/checkRunner.js';
import type { MetricSource } from './metricRegistry.js';

/**
 * How to obtain the raw data one adapter parses. A discriminated union, all
 * plain JSON:
 *   - `command` — run a check through the injected RunCheck. `parse:'text'`
 *     hands the adapter the combined stdout+stderr, `parse:'json'`
 *     JSON.parses stdout, `parse:'tsc-text'` applies the tsc evidence
 *     classification (a clean exit 0 certifies the authoritative zero
 *     `{count: 0}`; a non-zero with captured diagnostics hands over the raw
 *     text; anything else is null — the `scripts/ratchet-lib.mjs`
 *     `typecheckEvidence` rule, kept here for the JSON op boundary), and
 *     `parse:'coverage-json'` JSON.parses the body and normalizes
 *     `total.lines.pct` to integer percent (the shared granularity law —
 *     sub-1% cross-runner float noise must never become a verdict).
 *   - `file` — read `path` (absolute, or workspace-relative) and parse it
 *     the same way (`parse:'coverage-json'` for an istanbul
 *     coverage-summary).
 *   - `raw` — the raw value itself, verbatim (a caller that already holds
 *     plain JSON evidence).
 */
export type MetricSourceSpec =
  | {
      kind: 'command';
      command: string;
      args: string[];
      cwd?: string;
      timeoutMs?: number;
      parse: 'text' | 'json' | 'tsc-text' | 'coverage-json';
    }
  | { kind: 'file'; path: string; parse: 'text' | 'json' | 'coverage-json' }
  | { kind: 'raw'; raw: unknown };

/**
 * Integer-percent normalization of a coverage summary (the ONE shared
 * rounding point, mirroring `scripts/ratchet-lib.mjs`'s
 * `normalizeCoverageSummary`): v8's 2-decimal `total.lines.pct` is NOT stable
 * across environments (93.46 locally vs 93.38 in CI), so the reading is
 * rounded to integer percent before any adapter sees it. A hostile/missing
 * shape passes through untouched — the adapter rules it unusable (I5), never
 * a fabricated reading.
 */
function normalizeCoverage(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  try {
    const total = (parsed as { total?: unknown }).total;
    if (typeof total !== 'object' || total === null) return parsed;
    const lines = (total as { lines?: unknown }).lines;
    if (typeof lines !== 'object' || lines === null) return parsed;
    const record = lines as { pct?: unknown };
    if (typeof record.pct === 'number' && Number.isFinite(record.pct)) {
      record.pct = Math.round(record.pct);
    }
  } catch {
    // getter/hostile shape: leave as-is (the adapter rules it unusable)
  }
  return parsed;
}

/** Parse captured text per the spec's format; an unparsable JSON body is null (I5). */
function parseCaptured(text: string, parse: 'text' | 'json' | 'coverage-json'): unknown | null {
  if (parse === 'text') return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return parse === 'coverage-json' ? normalizeCoverage(parsed) : parsed;
}

/**
 * Compiler configuration / project-loading failures named by the legacy
 * classifier (`scripts/ratchet-lib.mjs` `typecheckEvidence`): a location-free
 * `error TSxxxx:` (e.g. TS18003) or a `<file>.json(line,col): error TSxxxx:`
 * (e.g. TS5023 unknown option, TS5083 cannot read project). These are
 * NON-PASSING evidence, never counted as ordinary diagnostics — a future
 * non-zero baseline must not let a broken tsconfig masquerade as N errors
 * (I5).
 */
const TSC_CONFIG_ERROR = /^error TS\d+:|^.*\.json\(\d+,\d+\): error TS\d+:/m;

/**
 * The tsc evidence classification over one captured check (the JSON-boundary
 * mirror of `scripts/ratchet-lib.mjs`'s `typecheckEvidence`): exit 0 certifies
 * zero errors, and only over an EMPTY capture (non-empty success output is a
 * configuration/banner fault, never a clean zero); exits 1/2 carry the raw
 * diagnostic text the adapter counts — UNLESS the capture is a compiler
 * configuration/project-loading failure, which is non-passing evidence
 * (null); every other outcome (null exit — signal/timeout/spawn fault — or
 * an abnormal code) is non-passing evidence.
 */
function parseTscCaptured(raw: RawCheckOutput): unknown | null {
  const text = `${raw.stdout}${raw.stderr}`;
  if (raw.exitCode === 0) return text.trim() === '' ? { count: 0 } : null;
  if (raw.exitCode === 1 || raw.exitCode === 2) {
    if (TSC_CONFIG_ERROR.test(text)) return null;
    return text;
  }
  return null;
}

/**
 * Build the MetricSource for `spec` over the injected check runner. The
 * returned source is workspace-parameterized: `command` runs in `cwd` (the
 * spec's absolute cwd, else the workspace), `file` resolves a relative path
 * against the workspace.
 */
export function makeMetricSource(run: RunCheck, spec: MetricSourceSpec): MetricSource {
  return async (ws) => {
    switch (spec.kind) {
      case 'raw':
        return spec.raw;
      case 'command': {
        const raw: RawCheckOutput = await run({
          command: spec.command,
          args: spec.args,
          cwd: spec.cwd ?? ws,
          ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        });
        if (spec.parse === 'tsc-text') return parseTscCaptured(raw);
        // A timed-out / killed / spawn-failed check reports exitCode null: its
        // captured bytes are partial evidence, so it is non-passing evidence
        // regardless of what parsed out of them (the CheckRunner I5 rule,
        // applied at the metric boundary too).
        if (raw.exitCode === null) return null;
        return parseCaptured(`${raw.stdout}${raw.stderr}`, spec.parse);
      }
      case 'file': {
        const path = isAbsolute(spec.path) ? spec.path : join(ws, spec.path);
        let text: string;
        try {
          text = await readFile(path, 'utf8');
        } catch {
          return null; // absent/unreadable summary — non-passing evidence (I5)
        }
        return parseCaptured(text, spec.parse);
      }
    }
  };
}
