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
 *     JSON.parses stdout, and `parse:'tsc-text'` applies the tsc evidence
 *     classification (a clean exit 0 certifies the authoritative zero
 *     `{count: 0}`; a non-zero with captured diagnostics hands over the raw
 *     text; anything else is null — the `scripts/ratchet-lib.mjs`
 *     `typecheckEvidence` rule, kept here for the JSON op boundary).
 *   - `file` — read `path` (absolute, or workspace-relative) and parse it
 *     (`parse:'json'` for an istanbul coverage-summary).
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
      parse: 'text' | 'json' | 'tsc-text';
    }
  | { kind: 'file'; path: string; parse: 'text' | 'json' }
  | { kind: 'raw'; raw: unknown };

/** Parse captured text per the spec's format; an unparsable JSON body is null (I5). */
function parseCaptured(text: string, parse: 'text' | 'json'): unknown | null {
  if (parse === 'text') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The tsc evidence classification over one captured check (the JSON-boundary
 * mirror of `scripts/ratchet-lib.mjs`'s `typecheckEvidence`): exit 0 certifies
 * zero errors, and only over an EMPTY capture (non-empty success output is a
 * configuration/banner fault, never a clean zero); exits 1/2 carry the raw
 * diagnostic text the adapter counts; every other outcome (null exit — signal/
 * timeout/spawn fault — or an abnormal code) is non-passing evidence.
 */
function parseTscCaptured(raw: RawCheckOutput): unknown | null {
  const text = `${raw.stdout}${raw.stderr}`;
  if (raw.exitCode === 0) return text.trim() === '' ? { count: 0 } : null;
  if (raw.exitCode === 1 || raw.exitCode === 2) return text;
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
