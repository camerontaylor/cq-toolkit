// ratchet-lib — shared plumbing for the ratchet runner scripts (lane H, goal
// H4 slice 1; the workflow wiring lands in slice 2).
//
// SELF-HOST SWAP: the runner scripts no longer reimplement the ratchet — they
// consume the BUILT engine (dist/ops/ratchet/*.js, the frozen H1-H3 ops) the
// same way the kernel would: register a metric adapter, feed a raw reading
// through a SourceCatalog, and let createCheckRatchet/createCaptureBaseline
// produce the verdict as data. Everything impure lives here: building dist,
// shelling out to the toolchain, reading coverage output. The op factories
// stay data-in/data-out; the scripts are thin, honest drivers over them.
//
// I5 discipline is inherited, not re-decided: a run whose evidence is absent
// or unparsable (no coverage summary, a typecheck that exits nonzero with no
// parsable diagnostic) reaches the engine as a NULL source reading, which the
// engine rules non-passing evidence, never a pass — and the loud-fail paths
// below echo the tool output so the failure is debuggable, not silent.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Repo root (this file lives in scripts/). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The summary the coverage adapter reads; written by `vitest run --coverage`. */
export const COVERAGE_SUMMARY_PATH = join(ROOT, 'coverage', 'coverage-summary.json');

/** Compiler/vitest output can be megabytes on a red run — never truncate evidence. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Loud, uniform driver failure: narration to stderr, exit 1. */
export function fail(message) {
  console.error(`ratchet: ${message}`);
  process.exit(1);
}

// npm/npx are .cmd shims on win32; since Node's CVE-2024-27980 fix a .cmd
// must be spawned through a shell (the same reasoning the old typecheck
// placeholder applied to tsc6.cmd). POSIX takes the direct binary, no shell.
const SHELL_ON_WINDOWS = process.platform === 'win32';

/**
 * Build the engine the scripts consume. Runs unconditionally (a stale dist
 * would silently certify evidence with an older engine — the self-host trust
 * chain wants dist built from THIS tree, and ci.yml invokes the typecheck
 * ratchet before any build step, so dist/ does not exist there yet). tsc6 is
 * checked-emit: a build error fails loudly here, never downstream.
 */
export function ensureDist() {
  const res = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: SHELL_ON_WINDOWS,
  });
  if (res.error || res.status !== 0) {
    fail(
      `cannot build the ratchet engine (npm run build): ${
        res.error ? res.error.message : `exit ${res.status}`
      }\n${res.stdout ?? ''}${res.stderr ?? ''}`,
    );
  }
}

/**
 * Build (ensureDist) then import the BUILT engine. Returns the op factories,
 * the adapter registry, the format helpers, the diff monotonic guard, the
 * baseline-proposal factory, and the first-party adapters this lane's
 * runners register (registration is the caller's job — registerAdapter
 * throws on a duplicate id, and the registry is per-process runtime wiring,
 * exactly as the engine's own docs require).
 */
export async function loadEngine() {
  ensureDist();
  const imp = (rel) => import(pathToFileURL(join(ROOT, 'dist', 'ops', 'ratchet', rel)).href);
  const [check, capture, registry, format, guard, propose, tcAdapter, covAdapter] =
    await Promise.all([
      imp('checkRatchet.js'),
      imp('captureBaseline.js'),
      imp('registry.js'),
      imp('format.js'),
      imp('monotonicGuard.js'),
      imp('proposeBaselineUpdate.js'),
      imp('adapters/typecheckCount.js'),
      imp('adapters/coverage.js'),
    ]);
  return {
    createCheckRatchet: check.createCheckRatchet,
    createCaptureBaseline: capture.createCaptureBaseline,
    registerAdapter: registry.registerAdapter,
    getAdapter: registry.getAdapter,
    listAdapters: registry.listAdapters,
    baselineRelPath: format.baselineRelPath,
    parseBaseline: format.parseBaseline,
    renderBaseline: format.renderBaseline,
    tightens: format.tightens,
    checkDiffMonotonicity: guard.checkDiffMonotonicity,
    formatViolations: guard.formatViolations,
    createProposeBaselineUpdate: propose.createProposeBaselineUpdate,
    adapters: { typecheckCount: tcAdapter.typecheckCount, coverage: covAdapter.coverage },
  };
}

/**
 * Run the repo's own typecheck script (tsc6 -p tsconfig.json — the pinned
 * compiler alias) and return the RAW outcome: {status, stdout, stderr, error}.
 * No judging here — classification happens in typecheckEvidence below so the
 * caller can echo the tool output before anything is counted.
 */
export function runTypecheckRaw() {
  const res = spawnSync('npm', ['run', 'typecheck'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: SHELL_ON_WINDOWS,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

/**
 * Classify a raw typecheck run into the metric source the engine will read.
 *
 * - status 0: the compiler certified zero errors — the caller KNOWS the
 *   count, so the source is the adapter's authoritative OBJECT form
 *   ({count: 0}); a structured zero is a real zero. Text evidence could not
 *   say this (a clean run has no diagnostic headers and the adapter's text
 *   mode returns null for exactly that reason).
 * - status nonzero WITH parsable diagnostics: the raw text itself — the
 *   adapter's anchored header count turns it into the reading.
 * - anything else (status null/nonzero, no parsable diagnostics): evidence
 *   null — the caller must fail loudly (echoing the tool output) instead of
 *   feeding the engine a would-be-pass reading (I5: non-passing evidence,
 *   never a pass).
 */
export function typecheckEvidence(typecheckCountAdapter, run) {
  const rawText = `${run.stdout}${run.stderr}`;
  if (run.status === 0) return { evidence: { count: 0 }, rawText };
  const counted = typecheckCountAdapter.extract(rawText);
  return { evidence: counted === null ? null : rawText, rawText };
}

/**
 * Integer-percent normalization of a coverage summary — THE one shared
 * rounding point (ratchet-check, ratchet-propose, and the baseline capture
 * all read through runCoverageRaw, so all three apply it identically).
 *
 * Rationale: the ratcheted quantity is total.lines.pct, and v8's 2-decimal
 * figure is NOT stable across environments — the same tree measured 93.46
 * locally and 93.38 in CI (provider/instrumentation noise), which failed a
 * 93.46 baseline as a spurious 0.08 "loosening". Granularity is the fix: the
 * reading is rounded to INTEGER percent (Math.round), in place, before any
 * adapter sees it. A ratchet step smaller than 1% is noise anyway — real
 * coverage work moves whole percentages — so 93.46 and 93.38 are both simply
 * 93, and cross-runner float noise can never turn into a ratchet verdict.
 * A hostile/missing shape is left untouched: the adapter rules it unusable
 * (I5), never a fabricated reading.
 */
export function normalizeCoverageSummary(summary) {
  if (typeof summary !== 'object' || summary === null) return summary;
  try {
    const pct = summary?.total?.lines?.pct;
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      summary.total.lines.pct = Math.round(pct);
    }
  } catch {
    // Getter/hostile shape: leave as-is — the adapter's containment rules
    // it unusable (I5), never a fabricated reading.
  }
  return summary;
}

// The diff-side twin of normalizeCoverageSummary's granularity law. The
// value-token shape mirrors the engine guard's own VALUE_RE (monotonicGuard)
// exactly — strict JSON number, terminator lookahead — so normalization can
// only ever rewrite a token the guard would read.
const DIFF_VALUE_TOKEN = /("value"\s*:\s*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[,}\s]|$)/g;
const BASELINE_SECTION_PATH = /^baselines\/.+\.json$/;
const DIFF_PATH_PREFIXES = ['b/', 'a/', 'i/', 'w/', 'c/', 'o/'];

/** Path after a `+++ `/`--- ` header, prefix- and timestamp-stripped; null for /dev/null. */
function diffHeaderPath(line) {
  const raw = line.slice(4);
  if (raw.startsWith('/dev/null')) return null;
  const path = raw.split('\t')[0];
  for (const prefix of DIFF_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/**
 * Uniform comparison basis for the diff-mode guard: rewrite every
 * `"value": <non-integer>` token to the SAME integer normalization the live
 * readings use (Math.round), on every `-`/`+`/context line inside
 * baselines/*.json sections only.
 *
 * Rationale: a baseline and a reading must be compared in the SAME
 * granularity. Readings are integer-pct (normalizeCoverageSummary), so a
 * fractional committed baseline would be judged against a differently-scaled
 * number — the re-basis hunk `93.46 → 93` must read as the no-op it is
 * (both sides normalize to 93: equal passes), while a TRUE loosening
 * (`93 → 92`) still fails and a genuine tighten in fractional clothing
 * (`92.4 → 93`, old side normalizes to 92) still passes as a tighten.
 *
 * This is a symmetric COMPARISON-BASIS normalization applied to both diff
 * sides alike — never a guard exception: it cannot flip a loosening into a
 * pass, only remove sub-granularity float noise from both sides. The engine
 * (monotonicGuard) is untouched; the rewritten text is what it judges.
 * Sections are attributed by their `---`/`+++` file headers (before the
 * first `@@` — after it, `---`-prefixed lines are removed CONTENT and are
 * normalized like any other content line); every other file's diff passes
 * through byte-identical, so a `"value": 1.5` in a source-file hunk is
 * never touched.
 */
export function normalizeBaselineDiffValues(diff) {
  const out = [];
  let isBaselineSection = false;
  let inHunk = false;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      isBaselineSection = false; // re-resolved by this section's own headers
      inHunk = false;
      out.push(line);
      continue;
    }
    if (inHunk === false && (line.startsWith('+++ ') || line.startsWith('--- '))) {
      const path = diffHeaderPath(line);
      if (path !== null && BASELINE_SECTION_PATH.test(path)) isBaselineSection = true;
      out.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true; // from here on, `---`-prefixed lines are removed content
      out.push(line);
      continue;
    }
    if (isBaselineSection && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      out.push(
        line.replace(DIFF_VALUE_TOKEN, (_, head, num) => head + String(Math.round(Number(num)))),
      );
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Run the suite under the v8 coverage provider, then read the emitted
 * coverage/coverage-summary.json. Returns {status, stdout, stderr, error,
 * summary} where summary is the PARSED summary object, normalized to
 * INTEGER percent by normalizeCoverageSummary (the coverage adapter reads
 * total.lines.pct from it), or null when the file is absent or unparsable —
 * the engine rules a null reading non-passing evidence (I5). A stale summary
 * is removed BEFORE the run so a failed or crashed vitest can never leave
 * yesterday's numbers behind as today's evidence.
 */
export function runCoverageRaw() {
  rmSync(COVERAGE_SUMMARY_PATH, { force: true });
  const res = spawnSync('npx', ['vitest', 'run', '--coverage'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: SHELL_ON_WINDOWS,
  });
  let summary = null;
  try {
    summary = JSON.parse(readFileSync(COVERAGE_SUMMARY_PATH, 'utf8'));
  } catch {
    summary = null; // absent or unparsable — never stale-passing evidence
  }
  summary = normalizeCoverageSummary(summary);
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
    summary,
  };
}
