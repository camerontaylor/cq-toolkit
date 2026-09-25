// ratchet-check — the ratchet.yml workhorse (lane H slice 1, goal H4; the
// workflow that invokes it lands in slice 2).
//
//   node scripts/ratchet-check.mjs check [--base <ref>]
//
// Checks the TWO live ratchets through the BUILT engine and exits 0 only if
// BOTH pass (exit 1 otherwise, reasons printed — the engine's verdicts are
// data, so the driver just narrates them):
//   (a) typecheck-count — a real `npm run typecheck` run, raw output fed to
//       the typecheckCount adapter (see ratchet-typecheck.mjs / ratchet-lib
//       for the I5 status/evidence rules);
//   (b) coverage — a real `npx vitest run --coverage`, the parsed
//       coverage/coverage-summary.json fed to the coverage adapter
//       (total.lines.pct NORMALIZED TO ONE DECIMAL PLACE by
//       runCoverageRaw/normalizeCoverageSummary — 2-decimal float noise
//       across runners is sub-granularity and must never be a verdict;
//       higher-is-better).
//
// `--base <ref>` ADDITIONALLY runs the monotonic guard over the PR-shaped
// diff: `git diff <ref>...HEAD` is normalized to the readings' one-decimal
// basis (both diff sides, coverage-baseline sections only — see
// engine.normalizeBaselineDiffValues, the ONE implementation shared with the
// ratchet.monotonicGuard CLI op) and fed to
// checkDiffMonotonicity; any baseline movement in the diff that loosens (or
// flips a direction/unit) is named via formatViolations and fails the run —
// thresholds only tighten, both live AND in the diff a branch wants to
// commit.
//
// FUTURE WORK (recorded round-2, no harness this round): a workflow-PR-mode
// e2e — `check --base` driven against a SCRATCH repo (temp clone plus a
// crafted loosening-baseline diff) — would pin the guard's CI shape
// end-to-end; the propose side likewise wants a forge-seam e2e (local bare
// repo as the push target, a fake `gh` shim serving canned pr list/create
// JSON). Neither harness exists yet; the ratchet-lib fixture checks and the
// engine's own guard tests carry the logic in the meantime.
import { spawnSync } from 'node:child_process';
import {
  COVERAGE_SUMMARY_PATH,
  ROOT,
  fail,
  loadEngine,
  runCoverageRaw,
  runTypecheckRaw,
  typecheckEvidence,
} from './ratchet-lib.mjs';

const USAGE = 'usage: node scripts/ratchet-check.mjs check [--base <ref>]';

const argv = process.argv.slice(2);
if (argv[0] !== 'check') {
  fail(`unknown command '${argv[0] ?? ''}' — ${USAGE}`);
}
// STRICT argv walk: everything that is not `check`, `--base`, or its value
// is unrecognized and fails the run BEFORE any leg runs — the guard leg must
// never be silently skipped (or silently downgraded to no-diff mode) by a
// typo like `--bases`.
let base = null;
const unrecognized = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--base') {
    base = argv[i + 1];
    if (typeof base !== 'string' || base === '') {
      fail('--base requires a ref (e.g. --base origin/main)');
    }
    i++; // the ref value is consumed by --base
  } else {
    unrecognized.push(argv[i]);
  }
}
if (unrecognized.length > 0) {
  fail(
    `unrecognized argument(s): ${unrecognized.join(' ')} — refusing to guess ` +
      `(a typo like '--bases' must fail loudly, never run a weaker check) — ${USAGE}`,
  );
}

// Build dist fresh, import the engine, register BOTH metrics the check reads.
const engine = await loadEngine();
engine.registerAdapter(engine.adapters.typecheckCount);
engine.registerAdapter(engine.adapters.coverage);

const failures = [];

// (a) typecheck-count — identical semantics to the ci.yml ratchet step.
const tcRun = runTypecheckRaw();
if (tcRun.error) {
  fail(`cannot run typecheck: ${tcRun.error.message}`);
}
const { evidence: tcEvidence, rawText: tcRaw } = typecheckEvidence(
  engine.adapters.typecheckCount,
  tcRun,
);
if (tcEvidence === null) {
  fail(
    `typecheck exited ${tcRun.status} with no parsable error lines — ` +
      'non-passing evidence, never a pass (I5) — tool output follows:\n' +
      tcRaw.trim(),
  );
}
const checkTypecheck = engine.createCheckRatchet(new Map([['tsc', async () => tcEvidence]]));
const tcOutcome = (
  await checkTypecheck({
    ws: ROOT,
    target: 'typecheck',
    metric: 'typecheck-count',
    sourceId: 'tsc',
  })
).value;
if (tcOutcome.verdict === 'pass') {
  console.error(
    `ratchet-check: typecheck-count pass — ${tcOutcome.currentValue} <= baseline ` +
      `${tcOutcome.baselineValue} (${tcOutcome.path})`,
  );
} else {
  failures.push(tcOutcome);
}

// (b) coverage — a green suite is the only suite whose coverage certifies
// anything: a vitest failure (or spawn fault) is recorded as THE coverage
// leg's failure (with the output tail echoed) rather than a silent skip or
// an early exit — the other legs' verdicts still print. On success the
// PARSED summary object is the source; an absent/unparsable summary reaches
// the engine as null and is ruled non-passing evidence there (I5).
const covRun = runCoverageRaw();
if (covRun.error || covRun.status !== 0) {
  failures.push({
    path: COVERAGE_SUMMARY_PATH,
    verdict: 'fail',
    reason:
      `ratchet: cannot run coverage (npx vitest run --coverage): ${
        covRun.error ? covRun.error.message : `exit ${covRun.status}`
      } — a red or crashed suite certifies no coverage — output tail:\n` +
      `${`${covRun.stdout}${covRun.stderr}`.slice(-4000).trim()}`,
  });
} else {
  const checkCoverage = engine.createCheckRatchet(
    new Map([['summary', async () => covRun.summary]]),
  );
  const covOutcome = (
    await checkCoverage({ ws: ROOT, target: 'coverage', metric: 'coverage', sourceId: 'summary' })
  ).value;
  if (covOutcome.verdict === 'pass') {
    console.error(
      `ratchet-check: coverage pass — ${covOutcome.currentValue} >= baseline ` +
        `${covOutcome.baselineValue} (${covOutcome.path})`,
    );
  } else {
    failures.push(covOutcome);
  }
  if (covRun.summary === null) {
    console.error(`ratchet-check: note — ${COVERAGE_SUMMARY_PATH} was not readable after the run`);
  }
}

// --base: the diff-mode guard. The diff text is preprocessed by
// normalizeBaselineDiffValues (uniform comparison basis: fractional baseline
// values on BOTH diff sides are rewritten to the same one-decimal pct the
// live readings use — the re-basis hunk `93.46 → 93.5` then reads as the
// equal no-op it is, while a true loosening `93.4 → 93.3` still fails) and the
// REWRITTEN text is what the engine judges; checkDiffMonotonicity itself is
// untouched. The engine's input remains the guard's ONLY input — it still
// judges baseline files alone (src/, workflows, everything else is ignored
// by design, and passes through the normalization byte-identical).
if (base !== null) {
  // The verifier's OWN hardened git argv, reused from dist/ops/ratchet/git.js
  // (F7) instead of an inline copy: the trusted diff pins `--no-color` and
  // `--no-relative` (repository config that would otherwise ANSI-prefix or
  // re-root every `diff --git` line, yielding zero parseable sections and a
  // VACUOUS guard pass). One definition, no drift. A ref starting with `-`
  // would be read as an option — refused.
  if (base.startsWith('-')) fail(`refusing a --base that starts with '-': ${base}`);
  const { GIT_HARDEN, HARDENED_DIFF_FLAGS } = engine;
  const diff = spawnSync(
    'git',
    [
      ...GIT_HARDEN,
      'diff',
      ...HARDENED_DIFF_FLAGS,
      `${base}...HEAD`,
      '--',
      'baselines/',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (diff.error || diff.status !== 0) {
    fail(
      `cannot diff against '${base}': ${
        diff.error ? diff.error.message : `exit ${diff.status}`
      }\n${diff.stderr ?? ''}`,
    );
  }
  // The normalization key is the EXACT coverage-baseline path (review-debt
  // #120), not a path prefix: engine.baselineRelPath computes the same
  // deterministic path the committed baseline must live at.
  const verdict = engine.checkDiffMonotonicity(
    engine.normalizeBaselineDiffValues(diff.stdout, engine.baselineRelPath('coverage', 'coverage')),
  );
  if (verdict.ok === false) {
    for (const line of engine.formatViolations(verdict.violations)) {
      console.error(`ratchet-check: ${line}`);
    }
    failures.push({
      path: `git diff ${base}...HEAD`,
      verdict: 'fail',
      reason: `${verdict.violations.length} baseline violation(s) in the diff against '${base}' — only tightening diffs pass`,
    });
  } else {
    console.error(
      `ratchet-check: monotonic guard pass — ${verdict.filesChecked} baseline file(s) in the diff, nothing loosened`,
    );
  }
}

if (failures.length > 0) {
  for (const outcome of failures) {
    console.error(`ratchet-check: FAIL (${outcome.path})`);
    if (outcome.reason) console.error(outcome.reason);
  }
  process.exit(1);
}
console.error('ratchet-check: all ratchets pass');
