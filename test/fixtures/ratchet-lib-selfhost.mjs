// Fixture for the ratchet self-host swap e2e (run by node, spawned by
// test/scripts/ratchet-baseline.test.ts — never picked up by vitest
// discovery): imports the REAL scripts/ratchet-lib.mjs and walks the exact
// wiring the runner scripts use —
//   loadEngine()            → npm run build, then import dist/ops/ratchet/*
//   registerAdapter(...)    → the registry is runtime-only composition wiring
//   adapters' extract       → the MetricReading each metric reads
//   typecheckEvidence(...)  → the status → evidence classification (I5)
// Straight-line assertions, exit 1 with the diff on stderr on any failure.
// No bare node globals (console/process/URL): the suite's eslint config
// defines only the timer globals for fixtures, so everything here comes
// through node: imports — the same style the runner scripts use.
import process from 'node:process';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const lib = await import(pathToFileURL(join(ROOT, 'scripts/ratchet-lib.mjs')).href);

let failures = 0;
/** Tiny assertion runner: one check = one named expectation, diff on failure. */
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures++;
    process.stderr.write(`ratchet-lib-selfhost: FAIL ${name}\n${err?.message ?? err}\n`);
  }
}

const engine = await lib.loadEngine();

check('loadEngine returns the op factories as functions', () => {
  ok(typeof engine.createCheckRatchet === 'function');
  ok(typeof engine.createCaptureBaseline === 'function');
  ok(typeof engine.createProposeBaselineUpdate === 'function');
});
check('loadEngine returns the registry + format + guard surface', () => {
  ok(typeof engine.registerAdapter === 'function');
  ok(typeof engine.getAdapter === 'function');
  ok(typeof engine.listAdapters === 'function');
  ok(typeof engine.baselineRelPath === 'function');
  ok(typeof engine.parseBaseline === 'function');
  ok(typeof engine.renderBaseline === 'function');
  ok(typeof engine.checkDiffMonotonicity === 'function');
  ok(typeof engine.formatViolations === 'function');
});
check('the driver-side adapters are the engine-authored ones', () => {
  equal(engine.adapters.typecheckCount.id, 'typecheck-count');
  equal(engine.adapters.typecheckCount.direction, 'lower-is-better');
  equal(engine.adapters.coverage.id, 'coverage');
  equal(engine.adapters.coverage.direction, 'higher-is-better');
});
check('registration wires the registry (getAdapter/listAdapters see them)', () => {
  engine.registerAdapter(engine.adapters.typecheckCount);
  engine.registerAdapter(engine.adapters.coverage);
  deepEqual(engine.listAdapters(), ['coverage', 'typecheck-count']);
  equal(engine.getAdapter('typecheck-count')?.direction, 'lower-is-better');
  equal(engine.getAdapter('coverage')?.direction, 'higher-is-better');
});
check('typecheckCount extracts the structured count (object form)', () => {
  deepEqual(engine.adapters.typecheckCount.extract({ count: 3 }), { value: 3, unit: 'errors' });
});
check('coverage extracts total.lines.pct with detail', () => {
  deepEqual(
    engine.adapters.coverage.extract({
      total: { lines: { pct: 87.5 }, branches: { pct: 80 }, functions: { pct: 90 }, statements: { pct: 88 } },
    }),
    { value: 87.5, unit: 'pct', detail: { branches: 80, functions: 90, statements: 88 } },
  );
});
check('typecheckEvidence: status 0 -> the authoritative object zero', () => {
  deepEqual(lib.typecheckEvidence(engine.adapters.typecheckCount, { status: 0, stdout: '', stderr: '' }), {
    evidence: { count: 0 },
    rawText: '',
  });
});
check('typecheckEvidence: errored-but-parsable run -> the raw text itself', () => {
  const stdout = 'src/a.ts(1,7): error TS2322: boom\n';
  deepEqual(
    lib.typecheckEvidence(engine.adapters.typecheckCount, { status: 1, stdout, stderr: '' }),
    { evidence: stdout, rawText: stdout },
  );
});
check('typecheckEvidence: nonzero exit, no parsable diagnostics -> null (I5)', () => {
  const { evidence } = lib.typecheckEvidence(engine.adapters.typecheckCount, {
    status: 1,
    stdout: 'npm error missing script',
    stderr: '',
  });
  equal(evidence, null);
});
check('normalizeCoverageSummary rounds total.lines.pct to integer percent', () => {
  const rounded = lib.normalizeCoverageSummary({ total: { lines: { pct: 93.46 } } });
  equal(rounded.total.lines.pct, 93); // 93.46 and CI's 93.38 are the same ratchet reading
  const half = lib.normalizeCoverageSummary({ total: { lines: { pct: 92.5 } } });
  equal(half.total.lines.pct, 93); // Math.round: half-up
  const hostile = lib.normalizeCoverageSummary({ total: {} });
  equal(hostile.total.lines?.pct, undefined); // untouched shape -> adapter rules it unusable (I5)
  equal(lib.normalizeCoverageSummary(null), null);
});

// The diff-guard's uniform comparison basis: fractional baseline values on
// BOTH diff sides normalize to the readings' integer pct before the guard
// judges — a re-basis no-op reads as equal, a true loosening still fails.
const BASELINE_FILE = 'baselines/coverage--coverage--a8ceec8f7024.json';
function baselineValueDiff(oldValue, newValue) {
  return [
    `diff --git a/${BASELINE_FILE} b/${BASELINE_FILE}`,
    'index 1111111..2222222 100644',
    `--- a/${BASELINE_FILE}`,
    `+++ b/${BASELINE_FILE}`,
    '@@ -2,6 +2,6 @@',
    '   "target": "coverage",',
    '   "metric": "coverage",',
    '   "direction": "higher-is-better",',
    `-  "value": ${oldValue},`,
    `+  "value": ${newValue},`,
    '   "unit": "pct",',
    '   "capturedAt": "2026-09-15T19:20:25.084Z"',
    ' }',
  ].join('\n');
}
check('normalizeBaselineDiffValues rewrites fractional values on -, + AND context lines only in baselines sections', () => {
  const diff = [
    `diff --git a/${BASELINE_FILE} b/${BASELINE_FILE}`,
    `--- a/${BASELINE_FILE}`,
    `+++ b/${BASELINE_FILE}`,
    '@@ -1,3 +1,3 @@',
    '-  "value": 93.46,',
    '+  "value": 93.4,',
    '   "value": 91.6,',
    ' }',
  ].join('\n');
  const normalized = lib.normalizeBaselineDiffValues(diff);
  ok(normalized.includes('-  "value": 93,'));
  ok(normalized.includes('+  "value": 93,'));
  ok(normalized.includes('   "value": 92,'));
  ok(normalized.includes('93.46') === false);
});
check('normalizeBaselineDiffValues leaves non-baseline files byte-identical', () => {
  const diff = [
    'diff --git a/src/x.ts b/src/x.ts',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1,1 +1,1 @@',
    '-const v = { "value": 1.5 };',
    '+const w = { "value": 2.5 };',
  ].join('\n');
  equal(lib.normalizeBaselineDiffValues(diff), diff);
});
check('guard verdict (a): re-basis 93.46 -> 93 is an equal no-op — pass', () => {
  const verdict = engine.checkDiffMonotonicity(
    lib.normalizeBaselineDiffValues(baselineValueDiff('93.46', '93')),
  );
  deepEqual(verdict, { ok: true, violations: [], filesChecked: 1 });
});
check('guard verdict (b): true loosening 93 -> 92 still fails', () => {
  const verdict = engine.checkDiffMonotonicity(
    lib.normalizeBaselineDiffValues(baselineValueDiff('93', '92')),
  );
  equal(verdict.ok, false);
  equal(verdict.violations.length, 1);
  equal(verdict.violations[0].why, 'loosened');
  deepEqual(engine.formatViolations(verdict.violations), [
    `${BASELINE_FILE}: metric coverage loosened 93 → 92 — only tightening diffs pass`,
  ]);
});
check('guard verdict (c): fractional tighten 92.4 -> 93 passes as a tighten (92.4 -> 92)', () => {
  const verdict = engine.checkDiffMonotonicity(
    lib.normalizeBaselineDiffValues(baselineValueDiff('92.4', '93')),
  );
  deepEqual(verdict, { ok: true, violations: [], filesChecked: 1 });
});

if (failures > 0) {
  process.stderr.write(`ratchet-lib-selfhost: ${failures} failure(s)\n`);
  process.exit(1);
}
process.stderr.write('ratchet-lib-selfhost: ok — engine wired, adapters registered, evidence classified\n');
