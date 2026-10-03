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
 * the adapter registry, the format helpers (including the shared diff-side
 * coverage re-basis normalizer `normalizeBaselineDiffValues` and the
 * coverage granularity law `roundCoveragePct` this file mirrors), the diff
 * monotonic guard, the baseline-proposal factory, and the first-party
 * adapters this lane's runners register (registration is the caller's job —
 * registerAdapter throws on a duplicate id, and the registry is per-process
 * runtime wiring, exactly as the engine's own docs require).
 */
export async function loadEngine() {
  ensureDist();
  const imp = (rel) => import(pathToFileURL(join(ROOT, 'dist', 'ops', 'ratchet', rel)).href);
  const [check, capture, registry, format, guard, propose, tcAdapter, covAdapter, git] =
    await Promise.all([
      imp('checkRatchet.js'),
      imp('captureBaseline.js'),
      imp('metricRegistry.js'),
      imp('format.js'),
      imp('monotonicGuard.js'),
      imp('proposeBaselineUpdate.js'),
      imp('adapters/typecheckCount.js'),
      imp('adapters/coverage.js'),
      imp('git.js'),
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
    normalizeBaselineDiffValues: format.normalizeBaselineDiffValues,
    roundCoveragePct: format.roundCoveragePct,
    checkDiffMonotonicity: guard.checkDiffMonotonicity,
    formatViolations: guard.formatViolations,
    createProposeBaselineUpdate: propose.createProposeBaselineUpdate,
    // The verifier's hardened git argv, reused (NOT re-spelled) by the
    // runner scripts so a local guard diff can never drift from the trusted
    // one — composition F7: an inline copy that omitted `--no-color` /
    // `--no-relative` made `checkDiffMonotonicity` pass vacuously under
    // `color.diff=always`.
    GIT_HARDEN: git.GIT_HARDEN,
    HARDENED_DIFF_FLAGS: git.HARDENED_DIFF_FLAGS,
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
 * LOCAL MIRROR of the engine's `roundCoveragePct`
 * (src/ops/ratchet/format.ts — the source of truth): half-up to ONE decimal
 * with a fixed absolute 1e-9 epsilon on the ×10 scale, so a decimal half
 * that lands a hair below itself in binary still rounds up (1.05 → 1.1).
 * Mirrored rather than imported because normalizeCoverageSummary is SYNC
 * and runs inside runCoverageRaw, independent of the async loadEngine build;
 * test/fixtures/ratchet-lib-selfhost.mjs asserts the two agree on a table
 * of values, so they can never drift silently.
 */
function roundCoveragePct(pct) {
  if (!Number.isFinite(pct)) return pct;
  return Math.floor(pct * 10 + 0.5 + 1e-9) / 10;
}

/**
 * One-decimal normalization of a coverage summary — the driver-side
 * application of the shared granularity law (ratchet-check,
 * ratchet-propose, and the baseline capture all read through
 * runCoverageRaw, so all three apply it identically, and the engine's
 * `coverage-json` source applies the same rounding).
 *
 * Rationale: the ratcheted quantity is total.lines.pct, and v8's 2-decimal
 * figure is NOT stable across environments — the same tree measured 93.46
 * locally and 93.38 in CI (provider/instrumentation noise), which failed a
 * 93.46 baseline as a spurious 0.08 "loosening". Granularity is the fix: the
 * reading is rounded half-up to ONE DECIMAL (roundCoveragePct above), in
 * place, before any adapter sees it — the hundredths digit is noise, while
 * the tenths digit keeps a small real coverage gain ratchetable (93.46 →
 * 93.5, 93.44 → 93.4). A hostile/missing shape is left untouched: the
 * adapter rules it unusable (I5), never a fabricated reading.
 */
export function normalizeCoverageSummary(summary) {
  if (typeof summary !== 'object' || summary === null) return summary;
  try {
    const pct = summary?.total?.lines?.pct;
    // Preserve out-of-range evidence for the adapter to reject (I5):
    // 100.04 → 100.0 or -0.04 → 0.0 would fabricate a valid reading.
    if (typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      summary.total.lines.pct = roundCoveragePct(pct);
    }
  } catch {
    // Getter/hostile shape: leave as-is — the adapter's containment rules
    // it unusable (I5), never a fabricated reading.
  }
  return summary;
}

// The diff-side coverage re-basis normalizer now lives ONCE in the engine
// (dist/ops/ratchet/format.js: normalizeBaselineDiffValues) and is surfaced
// through loadEngine above, so the required-workflow CLI op
// (ratchet.monotonicGuard) and this local driver share one implementation
// (review finding 1).

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
 * ONE-DECIMAL percent by normalizeCoverageSummary (the coverage adapter reads
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

/** Byte cap on the ratchet-propose measurement artifact (numbers only — tiny). */
export const PROPOSE_MEASUREMENT_MAX_BYTES = 64 * 1024;

/** The metric keys a propose measurement may carry, each with its value law. */
const PROPOSE_METRIC_CHECKS = {
  coverage: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100,
  'typecheck-count': (v) => Number.isSafeInteger(v) && v >= 0,
};

/**
 * Validate the ratchet-propose measurement artifact as UNTRUSTED DATA (W1.7).
 * The artifact is produced by the credential-free measure leg, which ran the
 * suite; the privileged proposer consumes it only through this function.
 * `size` is the byte length the caller observed (fstat/read); over
 * PROPOSE_MEASUREMENT_MAX_BYTES is refused before parsing. The shape is
 * strict — exactly `{schemaVersion: 1, metrics: {...}}`, metric keys limited
 * to `coverage` (finite, [0,100]) and `typecheck-count` (non-negative safe
 * integer). An UNKNOWN metric key is refused, never ignored: the proposer
 * must not act on a shape it does not know. Returns a null-prototype
 * `{ coverage?, 'typecheck-count'? }`; an absent metric is simply absent (the
 * caller notes it and proposes nothing from it — I5). Throws an Error with a
 * clear message on any violation.
 */
export function parseProposeMeasurement(text, size) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`measurement size is not a byte count: ${String(size)}`);
  }
  if (size > PROPOSE_MEASUREMENT_MAX_BYTES) {
    throw new Error(
      `measurement is ${size} bytes — over the ${PROPOSE_MEASUREMENT_MAX_BYTES}-byte cap`,
    );
  }
  if (typeof text !== 'string') throw new Error('measurement text is not a string');
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`measurement is not valid JSON — ${err?.message ?? err}`);
  }
  const isPlainObject = (v) => typeof v === 'object' && v !== null && Array.isArray(v) === false;
  if (!isPlainObject(doc)) throw new Error('measurement must be a JSON object');
  const topKeys = Object.keys(doc).sort();
  if (topKeys.length !== 2 || topKeys[0] !== 'metrics' || topKeys[1] !== 'schemaVersion') {
    throw new Error(
      `measurement must have exactly the keys schemaVersion and metrics (got: ${JSON.stringify(topKeys)})`,
    );
  }
  if (doc.schemaVersion !== 1) {
    throw new Error(`unsupported measurement schemaVersion ${JSON.stringify(doc.schemaVersion)}`);
  }
  if (!isPlainObject(doc.metrics)) throw new Error('measurement.metrics must be a JSON object');
  const out = Object.create(null);
  for (const key of Object.keys(doc.metrics)) {
    const check = Object.hasOwn(PROPOSE_METRIC_CHECKS, key) ? PROPOSE_METRIC_CHECKS[key] : null;
    if (check === null) {
      throw new Error(`measurement carries unknown metric ${JSON.stringify(key)} — refusing`);
    }
    const value = doc.metrics[key];
    if (!check(value)) {
      throw new Error(`measurement metric '${key}' has an invalid value ${JSON.stringify(value)}`);
    }
    out[key] = value;
  }
  return out;
}
