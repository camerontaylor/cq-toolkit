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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { deepEqual, equal, ok, rejects, throws } from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const lib = await import(pathToFileURL(join(ROOT, 'scripts/ratchet-lib.mjs')).href);

let failures = 0;
/** Tiny assertion runner: one check = one named expectation, diff on failure. Async-aware. */
async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures++;
    process.stderr.write(`ratchet-lib-selfhost: FAIL ${name}\n${err?.message ?? err}\n`);
  }
}

const engine = await lib.loadEngine();

await check('loadEngine returns the op factories as functions', () => {
  ok(typeof engine.createCheckRatchet === 'function');
  ok(typeof engine.createCaptureBaseline === 'function');
  ok(typeof engine.createProposeBaselineUpdate === 'function');
});
await check('loadEngine returns the registry + format + guard surface', () => {
  ok(typeof engine.registerAdapter === 'function');
  ok(typeof engine.getAdapter === 'function');
  ok(typeof engine.listAdapters === 'function');
  ok(typeof engine.baselineRelPath === 'function');
  ok(typeof engine.parseBaseline === 'function');
  ok(typeof engine.renderBaseline === 'function');
  ok(typeof engine.checkDiffMonotonicity === 'function');
  ok(typeof engine.formatViolations === 'function');
  // The diff-side coverage re-basis normalizer is the ENGINE's single
  // implementation, shared with the ratchet.monotonicGuard CLI op (review
  // finding 1).
  ok(typeof engine.normalizeBaselineDiffValues === 'function');
  ok(typeof engine.roundCoveragePct === 'function');
});
await check('the driver-side adapters are the engine-authored ones', () => {
  equal(engine.adapters.typecheckCount.id, 'typecheck-count');
  equal(engine.adapters.typecheckCount.direction, 'lower-is-better');
  equal(engine.adapters.coverage.id, 'coverage');
  equal(engine.adapters.coverage.direction, 'higher-is-better');
});
await check('registration wires the registry (getAdapter/listAdapters see them)', () => {
  engine.registerAdapter(engine.adapters.typecheckCount);
  engine.registerAdapter(engine.adapters.coverage);
  deepEqual(engine.listAdapters(), ['coverage', 'typecheck-count']);
  equal(engine.getAdapter('typecheck-count')?.direction, 'lower-is-better');
  equal(engine.getAdapter('coverage')?.direction, 'higher-is-better');
});
await check('typecheckCount extracts the structured count (object form)', () => {
  deepEqual(engine.adapters.typecheckCount.extract({ count: 3 }), { value: 3, unit: 'errors' });
});
await check('coverage extracts total.lines.pct with detail', () => {
  deepEqual(
    engine.adapters.coverage.extract({
      total: {
        lines: { pct: 87.5 },
        branches: { pct: 80 },
        functions: { pct: 90 },
        statements: { pct: 88 },
      },
    }),
    { value: 87.5, unit: 'pct', detail: { branches: 80, functions: 90, statements: 88 } },
  );
});
await check('typecheckEvidence: status 0 -> the authoritative object zero', () => {
  deepEqual(
    lib.typecheckEvidence(engine.adapters.typecheckCount, { status: 0, stdout: '', stderr: '' }),
    {
      evidence: { count: 0 },
      rawText: '',
    },
  );
});
await check('typecheckEvidence: errored-but-parsable run -> the raw text itself', () => {
  const stdout = 'src/a.ts(1,7): error TS2322: boom\n';
  deepEqual(
    lib.typecheckEvidence(engine.adapters.typecheckCount, { status: 1, stdout, stderr: '' }),
    { evidence: stdout, rawText: stdout },
  );
});
await check('typecheckEvidence: nonzero exit, no parsable diagnostics -> null (I5)', () => {
  const { evidence } = lib.typecheckEvidence(engine.adapters.typecheckCount, {
    status: 1,
    stdout: 'npm error missing script',
    stderr: '',
  });
  equal(evidence, null);
});
await check(
  'typecheckEvidence rejects abnormal, signaled, noisy-success and configuration runs',
  () => {
    for (const run of [
      { status: 3, stdout: 'src/a.ts(1,7): error TS2322: boom\n', stderr: '' },
      { status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
      { status: 0, stdout: 'unexpected banner', stderr: '' },
      { status: 0, stdout: '', stderr: '', error: new Error('spawn failed') },
      { status: 1, stdout: 'error TS5083: Cannot read project\n', stderr: '' },
      {
        status: 2,
        stdout: 'tsconfig.json(1,2): error TS5023: Unknown compiler option\n',
        stderr: '',
      },
    ]) {
      equal(lib.typecheckEvidence(engine.adapters.typecheckCount, run).evidence, null);
    }
  },
);
await check('normalizeCoverageSummary rounds total.lines.pct to one decimal', () => {
  const rounded = lib.normalizeCoverageSummary({ total: { lines: { pct: 93.46 } } });
  equal(rounded.total.lines.pct, 93.5); // the hundredths digit is cross-runner noise
  const half = lib.normalizeCoverageSummary({ total: { lines: { pct: 93.45 } } });
  equal(half.total.lines.pct, 93.5); // half-up at one decimal
  const below = lib.normalizeCoverageSummary({ total: { lines: { pct: 93.44 } } });
  equal(below.total.lines.pct, 93.4);
  const hostile = lib.normalizeCoverageSummary({ total: {} });
  equal(hostile.total.lines?.pct, undefined); // untouched shape -> adapter rules it unusable (I5)
  for (const pct of [-0.04, 100.04]) {
    const outOfRange = lib.normalizeCoverageSummary({ total: { lines: { pct } } });
    equal(outOfRange.total.lines.pct, pct);
    equal(engine.adapters.coverage.extract(outOfRange), null);
  }
  equal(lib.normalizeCoverageSummary(null), null);
});
await check(
  "normalizeCoverageSummary's local rounding mirror agrees with the engine's roundCoveragePct",
  () => {
    // The driver mirrors src/ops/ratchet/format.ts roundCoveragePct (it is
    // sync, run before/independent of loadEngine); this table pins the two
    // to the same granularity law so they can never drift.
    for (const pct of [
      93.45,
      93.44,
      93.46,
      93.38,
      1.05,
      0.7 + 0.35,
      99.95,
      99.94,
      0,
      0.04,
      0.05,
      100,
      94,
      33.35,
      50.25,
      12.345,
      87.65,
    ]) {
      const driver = lib.normalizeCoverageSummary({ total: { lines: { pct } } }).total.lines.pct;
      equal(driver, engine.roundCoveragePct(pct), `pct ${pct}`);
    }
    equal(engine.roundCoveragePct(1.05), 1.1);
    equal(engine.roundCoveragePct(99.95), 100);
  },
);

// The diff-guard's uniform comparison basis: coverage baseline values on
// BOTH diff sides normalize to the readings' one-decimal pct before the
// guard judges — a re-basis no-op reads as equal, a true loosening still
// fails.
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
await check(
  'normalizeBaselineDiffValues rewrites fractional values on -, + AND context lines only in baselines sections',
  () => {
    const diff = [
      `diff --git a/${BASELINE_FILE} b/${BASELINE_FILE}`,
      `--- a/${BASELINE_FILE}`,
      `+++ b/${BASELINE_FILE}`,
      '@@ -1,3 +1,3 @@',
      '-  "value": 93.46,',
      '+  "value": 93.54,',
      '   "value": 91.64,',
      ' }',
    ].join('\n');
    const normalized = engine.normalizeBaselineDiffValues(diff);
    ok(normalized.includes('-  "value": 93.5,'));
    ok(normalized.includes('+  "value": 93.5,'));
    ok(normalized.includes('   "value": 91.6,'));
    ok(normalized.includes('93.46') === false);
  },
);
await check('normalizeBaselineDiffValues leaves non-baseline files byte-identical', () => {
  const diff = [
    'diff --git a/src/x.ts b/src/x.ts',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1,1 +1,1 @@',
    '-const v = { "value": 1.5 };',
    '+const w = { "value": 2.5 };',
  ].join('\n');
  equal(engine.normalizeBaselineDiffValues(diff), diff);
});
await check('guard verdict (a): re-basis 93.54 -> 93.5 is an equal no-op — pass', () => {
  const verdict = engine.checkDiffMonotonicity(
    engine.normalizeBaselineDiffValues(baselineValueDiff('93.54', '93.5')),
  );
  deepEqual(verdict, { ok: true, violations: [], filesChecked: 1 });
});
await check('guard verdict (b): true loosening 93.4 -> 93.3 still fails', () => {
  const verdict = engine.checkDiffMonotonicity(
    engine.normalizeBaselineDiffValues(baselineValueDiff('93.4', '93.3')),
  );
  equal(verdict.ok, false);
  equal(verdict.violations.length, 1);
  equal(verdict.violations[0].why, 'loosened');
  deepEqual(engine.formatViolations(verdict.violations), [
    `${BASELINE_FILE}: metric coverage loosened 93.4 → 93.3 — only tightening diffs pass`,
  ]);
});
await check(
  'guard verdict (c): 2-decimal tighten 92.44 -> 92.5 passes as a tighten (92.44 -> 92.4)',
  () => {
    const verdict = engine.checkDiffMonotonicity(
      engine.normalizeBaselineDiffValues(baselineValueDiff('92.44', '92.5')),
    );
    deepEqual(verdict, { ok: true, violations: [], filesChecked: 1 });
  },
);

// Coverage-ONLY normalization (PR-105 round-2 finding 4): a fractional
// non-coverage metric (complexity avg-cx, 2 decimals) is a REAL granularity —
// normalizing `2.40 -> 2.49` to equal would mask a genuine loosening.
const COMPLEXITY_FILE = 'baselines/complexity--complexity--c0mplexx12.json';
function baselineValueDiffFor(file, direction, oldValue, newValue) {
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -2,6 +2,6 @@',
    '   "target": "complexity",',
    '   "metric": "complexity",',
    `   "direction": "${direction}",`,
    `-  "value": ${oldValue},`,
    `+  "value": ${newValue},`,
    '   "unit": "avg-cx",',
    '   "capturedAt": "2026-09-15T19:20:25.084Z"',
    ' }',
  ].join('\n');
}
await check('normalizeBaselineDiffValues leaves a complexity section byte-identical', () => {
  const diff = baselineValueDiffFor(COMPLEXITY_FILE, 'lower-is-better', '2.40', '2.49');
  equal(engine.normalizeBaselineDiffValues(diff), diff);
});
await check(
  'normalizeBaselineDiffValues: the coverage flag RESETS per header — a complexity section following a coverage one is never normalized',
  () => {
    // Realistic two-file diff: the complexity section that FOLLOWS the
    // coverage section must not inherit its normalization (the flag is
    // re-assigned per header — and per `diff --git` section boundary).
    const realistic = [
      baselineValueDiff('93.46', '93.5'),
      baselineValueDiffFor(COMPLEXITY_FILE, 'lower-is-better', '2.40', '2.49'),
    ].join('\n');
    const normalizedRealistic = engine.normalizeBaselineDiffValues(realistic);
    ok(normalizedRealistic.includes('-  "value": 93.5,')); // coverage side: normalized
    ok(normalizedRealistic.includes('-  "value": 2.40,')); // complexity side: untouched
    ok(normalizedRealistic.includes('+  "value": 2.49,')); // complexity side: untouched
    // Added-file header reset: `--- /dev/null` assigns the flag FALSE (no
    // path), so only the `+++` side's coverage path can set it again.
    const added = [
      `diff --git a/${COMPLEXITY_FILE} b/${COMPLEXITY_FILE}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${COMPLEXITY_FILE}`,
      '@@ -0,0 +1,8 @@',
      '+  "value": 2.49,',
    ].join('\n');
    equal(engine.normalizeBaselineDiffValues(added), added);
  },
);
await check(
  'guard verdict: complexity 2.40 -> 2.49 is STILL a loosened violation (not normalized away)',
  () => {
    const verdict = engine.checkDiffMonotonicity(
      engine.normalizeBaselineDiffValues(
        baselineValueDiffFor(COMPLEXITY_FILE, 'lower-is-better', '2.40', '2.49'),
      ),
    );
    equal(verdict.ok, false);
    equal(verdict.violations.length, 1);
    equal(verdict.violations[0].why, 'loosened');
    deepEqual(engine.formatViolations(verdict.violations), [
      `${COMPLEXITY_FILE}: metric complexity loosened 2.4 → 2.49 — only tightening diffs pass`,
    ]);
  },
);
await check('guard verdict: a complexity TIGHTEN at 2 decimals still passes untouched', () => {
  const verdict = engine.checkDiffMonotonicity(
    engine.normalizeBaselineDiffValues(
      baselineValueDiffFor(COMPLEXITY_FILE, 'lower-is-better', '2.49', '2.40'),
    ),
  );
  deepEqual(verdict, { ok: true, violations: [], filesChecked: 1 });
});

// Proposal upsert recovery (PR-105 round-2 finding 5): a PR found open can
// vanish between the list and the edit — the failed edit falls back to a
// FRESH create, reported honestly.
await check(
  'upsertProposalPr: no existing PR -> create only (created, not recovered)',
  async () => {
    let edits = 0;
    let creates = 0;
    const out = await lib.upsertProposalPr({
      existing: null,
      edit: async () => {
        edits++;
      },
      create: async () => {
        creates++;
      },
    });
    deepEqual(out, { created: true, recovered: false });
    equal(edits, 0);
    equal(creates, 1);
  },
);
await check(
  'upsertProposalPr: existing PR + successful edit -> edit only (no recovery)',
  async () => {
    let edits = 0;
    let creates = 0;
    const out = await lib.upsertProposalPr({
      existing: { number: 105, url: 'https://github.com/o/r/pull/105' },
      edit: async () => {
        edits++;
      },
      create: async () => {
        creates++;
      },
    });
    deepEqual(out, { created: false, recovered: false });
    equal(edits, 1);
    equal(creates, 0);
  },
);
await check(
  'upsertProposalPr: edit FAILURE (PR closed between list and edit) -> fresh create, honestly reported',
  async () => {
    let edits = 0;
    let creates = 0;
    const out = await lib.upsertProposalPr({
      existing: { number: 105, url: 'https://github.com/o/r/pull/105' },
      edit: async () => {
        edits++;
        throw new Error('Pull request is not open (closed between list and edit)');
      },
      create: async () => {
        creates++;
      },
    });
    deepEqual(out, { created: true, recovered: true });
    equal(edits, 1);
    equal(creates, 1);
  },
);
// The git contract behind the proposal effects' missing-ref probes (PR-105
// round-2 finding 3): `rev-parse --verify --quiet` exits NONZERO with EMPTY
// stdout exactly when the ref is absent — the allowFail+empty-check pattern
// treats that as "branch absent" (create path), never a driver failure.
await check(
  'missing-ref probe contract: absent ref -> nonzero + empty stdout; present ref -> oid',
  () => {
    const absent = spawnSync(
      'git',
      ['rev-parse', '--verify', '--quiet', 'refs/heads/ratchet/propose-definitely-absent'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    equal(absent.status === 0, false);
    equal((absent.stdout ?? '').trim(), '');
    const present = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    equal(present.status, 0);
    equal(present.stdout.trim().length, 40);
  },
);

// gh output parsing (PR-105 round-1 finding 2): `gh pr list --json number,url`
// emits a JSON ARRAY (empty array / NOTHING when no matches — an empty string
// means zero PRs, not an error); `gh ... -q <query>` emits a BARE STRING that
// must never be JSON.parsed; malformed non-empty output throws loudly.
await check(
  'parseGhJson: literal gh pr list output shapes (array, empty, whitespace, garbage)',
  () => {
    deepEqual(
      lib.parseGhJson(
        '[{"number":105,"url":"https://github.com/camerontaylor/cq-toolkit/pull/105"}]',
        [],
      ),
      [{ number: 105, url: 'https://github.com/camerontaylor/cq-toolkit/pull/105' }],
    );
    deepEqual(lib.parseGhJson('[]', []), []);
    deepEqual(lib.parseGhJson('', []), []); // no open PRs — gh prints nothing
    deepEqual(lib.parseGhJson('  \n\t ', []), []); // whitespace-only = empty
    deepEqual(lib.parseGhJson(undefined, []), []);
    throws(() => lib.parseGhJson('no open PRs', []), SyntaxError); // mangled output: loud, never silent-empty
  },
);
await check('parseGhJson: -q query output is a bare string and is NOT force-parsed as JSON', () => {
  equal(String('camerontaylor/cq-toolkit'.trim()), 'camerontaylor/cq-toolkit'); // the repoSlug path: trim, no parse
  throws(() => lib.parseGhJson('camerontaylor/cq-toolkit'), SyntaxError); // JSON.parse here was the bug
});

// GIT_ASKPASS auth (PR-105 round-1 finding 5): the token reaches git through
// the askpass file's ENVIRONMENT — never its bytes, never a URL/argv/config.
await check(
  'withGitAskpass: env-only token, no token bytes on disk, cleanup on success AND injected failure',
  async () => {
    const TOKEN = 'fake-token-abc123';
    let askpassPath = null;
    await lib.withGitAskpass(TOKEN, async (gitEnv) => {
      askpassPath = gitEnv.GIT_ASKPASS;
      equal(gitEnv.GIT_TERMINAL_PROMPT, '0');
      equal(gitEnv.CQ_AUTOMATION_TOKEN, TOKEN);
      ok(existsSync(askpassPath));
      // The script's BYTES never contain the token (env-only); running it with
      // the token in ITS env prints exactly the token (the askpass contract).
      ok(readFileSync(askpassPath, 'utf8').includes(TOKEN) === false);
      const out = spawnSync('sh', [askpassPath], { env: gitEnv, encoding: 'utf8' });
      equal(out.stdout.trim(), TOKEN);
    });
    ok(existsSync(askpassPath) === false); // cleaned up on success
    // Abnormal exit (injected failure): the temp plumbing is still removed.
    await rejects(
      lib.withGitAskpass(TOKEN, async (gitEnv) => {
        askpassPath = gitEnv.GIT_ASKPASS;
        throw new Error('injected failure');
      }),
      /injected failure/,
    );
    ok(existsSync(askpassPath) === false);
    // And the git-config channel carries no token — there is no authed URL by
    // construction; this pins the invariant against regressions.
    const cfg = spawnSync('git', ['config', '-l'], { cwd: ROOT, encoding: 'utf8' });
    ok(cfg.stdout.includes(TOKEN) === false);
  },
);

if (failures > 0) {
  process.stderr.write(`ratchet-lib-selfhost: ${failures} failure(s)\n`);
  process.exit(1);
}
process.stderr.write(
  'ratchet-lib-selfhost: ok — engine wired, adapters registered, evidence classified\n',
);
