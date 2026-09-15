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

if (failures > 0) {
  process.stderr.write(`ratchet-lib-selfhost: ${failures} failure(s)\n`);
  process.exit(1);
}
process.stderr.write('ratchet-lib-selfhost: ok — engine wired, adapters registered, evidence classified\n');
