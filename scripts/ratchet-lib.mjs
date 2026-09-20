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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// must be spawned through a shell. Package JS entrypoints run directly with
// Node so absolute paths never undergo shell parsing.
const SHELL_ON_WINDOWS = process.platform === 'win32';

/**
 * Newest file mtime under src/ (recursive), or 0 when unreadable — the
 * freshness baseline for the ensureDist reuse heuristic. Any stat fault
 * degrades to "never fresh", i.e. rebuild.
 */
function newestSrcMtimeMs() {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else newest = Math.max(newest, statSync(abs).mtimeMs);
    }
  };
  try {
    walk(join(ROOT, 'src'));
  } catch {
    return 0;
  }
  return newest;
}

/**
 * Build the engine the scripts consume — ONLY when dist is stale: dist is
 * reused when `dist/index.js` (and the ratchet engine entry the scripts
 * import) exists and is NEWER than every file under src/; anything else
 * (missing, unreadable, or any src file newer than dist) triggers a rebuild.
 *
 * TRADEOFF, deliberate: a CI cold checkout has no dist and always builds
 * (correct and expected — ci.yml invokes the typecheck ratchet before any
 * build step); a local run saves the ~4s rebuild whenever dist is genuinely
 * fresh. The mtime heuristic's known weakness is a hand-touched dist (or a
 * clock skew) masking a stale engine — accepted for the LOCAL fast path
 * because the engine is frozen between lane merges; CI's cold checkout is
 * the trust-critical path and it never reuses. TS7 is checked-emit: a build
 * error fails loudly here, never downstream.
 */
export function ensureDist() {
  try {
    const marker = statSync(join(ROOT, 'dist', 'index.js'));
    const engineEntry = statSync(join(ROOT, 'dist', 'ops', 'ratchet', 'checkRatchet.js'));
    if (marker.isFile() && engineEntry.isFile() && marker.mtimeMs >= newestSrcMtimeMs()) {
      return; // dist exists and is newer than every src file — reuse it
    }
  } catch {
    // no dist yet (CI cold checkout) or unreadable — fall through to build
  }
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
 * Parse `gh` CLI output per its ACTUAL shapes (PR-105 round-1 finding: the
 * old code JSON.parse'd the `-q` query output, which is a BARE STRING, so
 * the happy path always threw). Rules: output is trimmed; EMPTY output maps
 * to the caller's fallback (a `gh pr list` with no matches prints nothing —
 * that is zero PRs, not an error); a `--json` payload (e.g. `gh pr list
 * --json number,url` emitting a JSON array) parses as JSON; malformed
 * non-empty output THROWS — mangled forge output is a loud driver failure,
 * never silently-empty evidence.
 */
export function parseGhJson(text, fallback = null) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return fallback;
  return JSON.parse(trimmed);
}

/**
 * Run `fn` with a git child-env that authenticates over HTTPS via
 * GIT_ASKPASS — the token NEVER appears in a URL, argv, or .git/config (the
 * set-url approach this replaces embedded it in all three). The askpass
 * script's BYTES contain no token either: it echoes $CQ_AUTOMATION_TOKEN
 * from ITS environment (git prompts are fed the token as both username and
 * password — the form GitHub accepts), and the script is written 0700 into a
 * fresh temp dir. `fn`'s returned value passes through; the temp dir is
 * removed in a finally, so an abnormal exit (any throw) cannot leave the
 * token-bearing plumbing behind. GIT_TERMINAL_PROMPT=0 keeps a credential
 * failure a loud error, never an interactive hang.
 */
export async function withGitAskpass(token, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-askpass-'));
  const askpass = join(dir, 'askpass.sh');
  writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$CQ_AUTOMATION_TOKEN"\n', { mode: 0o700 });
  try {
    return await fn({
      ...process.env,
      CQ_AUTOMATION_TOKEN: token, // the askpass reads the token from ITS env
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: '0',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
      imp('metricRegistry.js'),
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
 * Run the pinned TS7 compiler directly (the typecheck alias runs this ratchet
 * and must not recurse) and return the RAW outcome: {status, stdout, stderr, error}.
 * No judging here — classification happens in typecheckEvidence below so the
 * caller can echo the tool output before anything is counted.
 */
export function runTypecheckRaw() {
  const res = spawnSync(
    process.execPath,
    [
      resolve(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '-p',
      'tsconfig.json',
      '--pretty',
      'false',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    },
  );
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
    signal: res.signal,
  };
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
  if (run.error || run.signal || ![0, 1, 2].includes(run.status))
    return { evidence: null, rawText };
  if (/^error TS\d+:|^.*\.json\(\d+,\d+\): error TS\d+:/m.test(rawText))
    return {
      evidence: null,
      rawText: `compiler configuration or project-loading failure:\n${rawText}`,
    };
  if (run.status === 0) return { evidence: rawText.trim() === '' ? { count: 0 } : null, rawText };
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

// The diff-side twin of normalizeCoverageSummary's granularity law — and it
// applies to COVERAGE baselines ONLY: integer-pct is the coverage reading's
// granularity (normalizeCoverageSummary rounds the live reading the same
// way), so only a fractional COVERAGE baseline is normalized on the diff
// side. A fractional NON-coverage metric (complexity avg-cx lives at 2
// decimals) must pass through untouched — normalizing it would round
// `2.40 → 2.49` into an equal no-op and MASK a real loosening; complexity's
// meaningful step is far below 1. The value-token shape mirrors the engine
// guard's own VALUE_RE (monotonicGuard) exactly — strict JSON number,
// terminator lookahead — so normalization can only ever rewrite a token the
// guard would read.
const DIFF_VALUE_TOKEN =
  /("value"\s*:\s*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[,}\s]|$)/g;
const COVERAGE_BASELINE_SECTION = /^baselines\/coverage/;
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
 * Uniform comparison basis for the diff-mode guard — COVERAGE baselines
 * only: rewrite every `"value": <non-integer>` token to the SAME integer
 * normalization the live coverage readings use (Math.round), on every
 * `-`/`+`/context line inside baselines/coverage* sections only.
 *
 * Rationale: a baseline and a reading must be compared in the SAME
 * granularity, and integer-pct is the COVERAGE reading's granularity
 * (normalizeCoverageSummary) — a fractional committed coverage baseline
 * would be judged against a differently-scaled number. The re-basis hunk
 * `93.46 → 93` must read as the no-op it is (both sides normalize to 93:
 * equal passes), while a TRUE loosening (`93 → 92`) still fails and a
 * genuine tighten in fractional clothing (`92.4 → 93`, old side normalizes
 * to 92) still passes as a tighten.
 *
 * SCOPE IS DELIBERATELY NARROW (PR-105 round-2 finding 4): other metrics'
 * granularity is their own — complexity avg-cx lives at 2 decimals, where
 * `2.40 → 2.49` is a REAL change, not noise — so their sections pass through
 * byte-identical and the guard judges them at full precision. Normalizing
 * them would round the loosening into an equal no-op and mask it.
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
export function normalizeBaselineDiffValues(diff, exactCoverageBaselinePath) {
  const out = [];
  let isCoverageSection = false;
  let inHunk = false;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      isCoverageSection = false; // re-resolved by this section's own headers
      inHunk = false;
      out.push(line);
      continue;
    }
    if (inHunk === false && (line.startsWith('+++ ') || line.startsWith('--- '))) {
      const path = diffHeaderPath(line);
      // Assigned PER HEADER, never only-if-matches: a sibling file's header
      // must RESET the flag, so a non-coverage section following a coverage
      // one can never inherit its normalization. Keyed on the EXACT
      // coverage-baseline path when the caller provides it (review-debt
      // #120: a path-prefix regex would also catch an unrelated baseline
      // whose target merely starts with 'coverage' — exact identity, not
      // similarity); the prefix remains the fallback for callers without
      // an engine at hand.
      isCoverageSection =
        path !== null &&
        (exactCoverageBaselinePath !== undefined
          ? path === exactCoverageBaselinePath
          : COVERAGE_BASELINE_SECTION.test(path));
      out.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true; // from here on, `---`-prefixed lines are removed content
      out.push(line);
      continue;
    }
    if (
      isCoverageSection &&
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
    ) {
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
 * Edit-then-create recovery for the proposal upsert (PR-105 round-2 finding
 * 5): an open-PR hit is edited in place, but a PR found open can be
 * closed/merged between the list and the edit — a FAILED edit falls back to
 * a FRESH create instead of surfacing indeterminate. The outcome reports the
 * recovery honestly: `{ created, recovered }` where `recovered` is true only
 * when an edit was attempted and failed before the fresh create (the driver
 * has already narrated the failure at the moment it happened).
 */
export async function upsertProposalPr({ existing, edit, create }) {
  if (existing !== null) {
    try {
      await edit();
      return { created: false, recovered: false };
    } catch (err) {
      process.stderr.write(
        `ratchet-propose: note — gh pr edit failed for PR #${existing.number} ` +
          `(${err?.message ?? err}); creating a fresh proposal PR\n`,
      );
    }
  }
  await create();
  return { created: true, recovered: existing !== null };
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
