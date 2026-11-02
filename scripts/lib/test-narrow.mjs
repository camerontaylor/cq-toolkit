import { stripVTControlCharacters } from 'node:util';

// Pure policy for scripts/test-narrow.mjs, the ONE permitted local test
// command (AGENTS.md "Local testing"). Everything here is data in, data out
// — argv parsing, the run plan and the summary line — so
// test/scripts/test-narrow.test.ts covers the policy without spawning.
//
// The policy, in one place:
//   - named files under nice; full-suite fallback is refused;
//   - integration and live suites run only when a flag names their class;
//   - no watch mode, no coverage, no passthrough of arbitrary vitest flags;
//   - zero selected files means zero runs (a bare `vitest run` would be the
//     FULL suite, which is CI-only).

import { constants } from 'node:os';

export const NICE_INCREMENT = 5;
/** A narrow run that is still going after this is killed. */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_BASE = 'origin/main';
export const GATED_CLASSES = ['integration', 'live'];

export const USAGE = `usage: pnpm test:narrow [options] [<file>...]

Runs a narrow, host-safe subset of the test suite. The full suite is CI-only.

Selection (pick one):
  <file>...                  explicit files: test files run as named; other
                             files map to their tests via the selector
  --base <ref>               changed files since merge-base(<ref>, HEAD) plus
                             the working tree (the default, <ref> = ${DEFAULT_BASE})
  --range <a>..<b>           changed files in a commit range (no working tree)

Options:
  --dry-run, --list          print the plan, run nothing
  --include-integration      allow suites classified integration
  --include-live             allow suites classified live
  -t <pattern>               diagnostic only: match full test names; successful
                             runs report result="filtered", never gate evidence
  -h, --help                 this text

Refused: watch, coverage, arbitrary vitest flags and full-suite selections.
Exit 75: MemAvailable below 2 GB; move to another host. No lock or waiting.
Runs under nice with --maxWorkers=2 (serial files currently use one worker) and a 2 GB Node heap; where supported,
a systemd user scope caps memory at 3 GB with no swap.
Live drill (classified integration):
  LIVE_GH=1 pnpm test:narrow --include-integration test/e2e/merge/live.test.ts`;

const REFUSED_FLAGS = {
  '--watch': 'watch mode never terminates',
  '-w': 'watch mode never terminates',
  '--coverage': 'coverage instruments all of src/ (the coverage ratchet runs in CI)',
  '--ui': 'the UI server never terminates',
};

/**
 * @returns {{ ok: true, options: object } | { ok: false, help?: true, reason?: string }}
 */
export function parseArgs(argv) {
  const options = {
    files: [],
    base: null,
    range: null,
    dryRun: false,
    include: [],
    testNamePattern: null,
  };
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  try {
    while (args.length > 0) {
      const arg = args.shift();
      // `--flag=value` and `--flag value` are equivalent; a value given to a
      // boolean flag is an error, never a stray file argument.
      const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
      const flag = eq === -1 ? arg : arg.slice(0, eq);
      let inline = eq === -1 ? undefined : arg.slice(eq + 1);
      const value = () => {
        const next = inline ?? args.shift();
        inline = undefined;
        if (next === undefined || next === '') throw new Error(`${flag} requires a value`);
        // Values reach git and vitest argv: an option-shaped value is refused
        // in both spellings so it can never be read as an option there.
        if (next.startsWith('-')) throw new Error(`${flag} requires a value, got ${next}`);
        return next;
      };
      if (flag === '-h' || flag === '--help') return { ok: false, help: true };
      if (flag in REFUSED_FLAGS) throw new Error(`${flag} is refused: ${REFUSED_FLAGS[flag]}`);
      if (flag.startsWith('--watch')) throw new Error(`${flag} is refused: watch mode`);
      if (flag === '--dry-run' || flag === '--list') options.dryRun = true;
      else if (flag === '--include-integration') options.include.push('integration');
      else if (flag === '--include-live') options.include.push('live');
      else if (flag === '--base') options.base = value();
      else if (flag === '--range') options.range = value();
      else if (flag === '-t' || flag === '--testNamePattern') options.testNamePattern = value();
      else if (flag.startsWith('-')) {
        throw new Error(`unknown option ${flag} (vitest flags are not passed through)`);
      } else options.files.push(arg);
      if (inline !== undefined) throw new Error(`${flag} takes no value`);
    }
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const modes = [options.files.length > 0, options.base !== null, options.range !== null];
  if (modes.filter(Boolean).length > 1) {
    return { ok: false, reason: 'choose one selection: explicit files, --base or --range' };
  }
  if (options.range !== null && !options.range.includes('..')) {
    return { ok: false, reason: `--range needs <a>..<b>, got ${options.range}` };
  }
  return { ok: true, options };
}

/** The vitest project a test file runs in (mirrors vitest.config.ts). */
export function classOf(file, manifest) {
  if (/^apps\/crq-python\/test_[A-Za-z0-9_]+\.py$/.test(file)) return 'python';
  const cls = manifest[file];
  if (cls !== undefined) return cls;
  return file.startsWith('test/e2e/') ? 'integration' : 'process';
}

/**
 * @param {{
 *   selection: { files: string[], fallback: boolean, reason: string },
 *   manifest: Record<string, string>,
 *   include: string[],    gated classes the caller opted into
 * }} input
 * @returns {{ ok: true, run: {file: string, project: string}[] }
 *   | { ok: false, reason: string, candidates: string[] }}
 */
export function planRun({ selection, manifest, include, allTests = [] }) {
  if (allTests.length > 0 && allTests.every((file) => selection.files.includes(file))) {
    return {
      ok: false,
      reason: 'selection covers the full test suite; name a narrower set of files',
      candidates: [],
    };
  }
  if (selection.fallback) {
    return {
      ok: false,
      reason: `selection is unbounded (${selection.reason}); ` + `name test files explicitly`,
      candidates: [],
    };
  }
  const run = [];
  const gated = [];
  for (const file of selection.files) {
    const project = classOf(file, manifest);
    if (!GATED_CLASSES.includes(project) || include.includes(project)) {
      run.push({ file, project });
    } else gated.push({ file, project });
  }
  // A gated file that covers the change is refused, never silently skipped:
  // a run without it would not test the change, so it cannot count as one.
  if (gated.length > 0) {
    const flags = [...new Set(gated.map((g) => `--include-${g.project}`))].sort();
    const listed = gated.map((g) => `${g.file} (${g.project})`).join(', ');
    return {
      ok: false,
      // The flag IS the way through: this is the opt-in gate, not a policy
      // refusal — one line names the exact re-run so a caller never detours
      // into hand-running files (#470 verdict P2 #2).
      reason:
        `gated test files cover the change: ${listed}; pass ${flags.join(' ')} to run them ` +
        `(an opt-in gate, not a refusal — re-run with ${flags.join(' ')})`,
      candidates: [],
    };
  }
  return { ok: true, run };
}

/**
 * test/suite-classes.json keys that name no file on disk. vitest.config.ts
 * throws on them, so the runner refuses rather than filtering them away.
 */
export function missingManifestEntries(manifest, exists) {
  return Object.keys(manifest).filter((file) => !exists(file));
}

/** Projects in vitest.config.ts group order, restricted to the plan. */
export function projectsOf(run) {
  const order = ['python', 'pure', 'process', 'live', 'integration'];
  const used = new Set(run.map((r) => r.project));
  return order.filter((p) => used.has(p));
}

/** Python has no import graph: direct modules only, never discovery locally. */
export function selectPython(changed, allTests, missing = []) {
  const selected = new Set();
  for (const file of changed) {
    if (!file.startsWith('apps/crq-python/')) continue;
    const module = /^apps\/crq-python\/([A-Za-z0-9_]+)\.py$/.exec(file)?.[1];
    const test = module?.startsWith('test_') ? file : `apps/crq-python/test_${module}.py`;
    if (module === undefined || missing.includes(file) || !allTests.includes(test)) {
      return { files: [], fallback: true, reason: `no Python mapping for ${file}` };
    }
    selected.add(test);
  }
  if (selected.size > 0 && selected.size === allTests.length) {
    return { files: [], fallback: true, reason: 'Python selection would run every module' };
  }
  return { files: [...selected].sort(), fallback: false, reason: 'mapped' };
}

/** Read unittest's terminal report; an absent/zero-test report never passes. */
export function readPythonReport(stderr) {
  const matches = [
    ...stripVTControlCharacters(stderr).matchAll(
      /^Ran (\d+) tests? in [^\n]+\n\s*\n(OK|FAILED)(?: \(([^\n]*)\))?\s*$/gm,
    ),
  ];
  const last = matches.at(-1);
  if (last === undefined || Number(last[1]) === 0) return null;
  const total = Number(last[1]);
  const count = (key) => Number(new RegExp(`\\b${key}=(\\d+)`).exec(last[3] ?? '')?.[1] ?? 0);
  const failed = count('failures') + count('errors') + count('unexpected successes');
  const skipped = count('skipped') + count('expected failures');
  return { total, passed: total - failed - skipped, failed, skipped };
}

/** Python uses the same cancellation outcomes as Vitest, before report validation. */
export function pythonRunVerdict({ run, counts, interruptedBy }) {
  if (run.error)
    return { result: 'error', exit: 1, reason: `cannot start Python: ${run.error.message}` };
  const exit = run.code ?? (run.signal ? signalExit(run.signal) : 1);
  if (run.timedOut || interruptedBy !== null) {
    return runVerdict({ exit, report: null, files: [], timedOut: run.timedOut, interruptedBy });
  }
  if (exit !== 0 || counts === null || counts.failed > 0 || counts.passed === 0) {
    return {
      result: 'fail',
      exit: exit || 1,
      reason: 'Python run failed or produced no nonempty report',
    };
  }
  return { result: 'pass', exit: 0 };
}

/**
 * The stable one-line summary agents quote. Keys always appear, in this
 * order; absent values print as `-`. Every string value is JSON-quoted so
 * filenames and refs cannot inject extra evidence lines.
 */
export function summaryLine(s) {
  const dash = (v) =>
    v === undefined || v === null || v === ''
      ? '-'
      : typeof v === 'string'
        ? JSON.stringify(v)
        : String(v);
  const secs = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '-');
  const fields = [
    ['result', s.result],
    ['exit', s.exit],
    ['files', s.files?.length],
    ['projects', s.projects?.join(',')],
    ['tests', s.tests ? `${s.tests.passed}/${s.tests.total}` : undefined],
    ['failed', s.tests?.failed],
    ['skipped', s.tests?.skipped],
    ['duration', secs(s.durationMs)],
    ['nice', s.nice],
    ['load', s.load],
    ['uptime', typeof s.uptimeS === 'number' ? `${Math.floor(s.uptimeS)}s` : undefined],
    ['source', s.source],
    ['ran', s.ran?.join(',')],
  ];
  const line = fields.map(([k, v]) => `${k}=${dash(v)}`).join(' ');
  return `test:narrow ${line}${s.reason ? ` reason=${JSON.stringify(s.reason)}` : ''}`;
}

/** Keep internal worker-count controls out of operator run records. */
export function loggedVitestArgs(args) {
  return args.filter((arg) => !arg.startsWith('--maxWorkers='));
}

/**
 * Read the counts, the executed files and, per file, how many tests actually
 * executed (assertion status passed or failed; skipped, pending, todo and
 * disabled tests did not) out of vitest's JSON report.
 */
export function readReport(report, toRelative) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return null;
  }
  const num = (k) => (Number.isInteger(report[k]) ? report[k] : 0);
  const executed = {};
  for (const result of report.testResults) {
    const file = toRelative(String(result.name));
    const statuses = Array.isArray(result.assertionResults)
      ? result.assertionResults.map((a) => a?.status)
      : [];
    executed[file] =
      (executed[file] ?? 0) + statuses.filter((s) => s === 'passed' || s === 'failed').length;
  }
  return {
    tests: {
      total: num('numTotalTests'),
      passed: num('numPassedTests'),
      failed: num('numFailedTests'),
      skipped: num('numPendingTests') + num('numTodoTests'),
    },
    ran: Object.keys(executed).sort(),
    executed,
  };
}

/** The conventional exit status of a process killed by `signal`. */
export const signalExit = (signal) => 128 + (constants.signals[signal] ?? 1);
/** timeout(1)'s status for a run it had to stop. */
const EXIT_TIMEOUT = 124;

/**
 * The verdict on a finished vitest run. A pass must prove itself: a report,
 * every selected file in it, nothing unselected, and in EVERY selected file
 * at least one executed test — skipped and todo tests (all of a file's,
 * under a `-t` that matches only other files) prove nothing. A timeout or an
 * interrupt never exits 0, even when vitest raced it to a clean exit.
 * Name-filtered successes are diagnostic only, never gate passes.
 */
export function runVerdict({
  exit,
  report,
  files,
  timedOut,
  interruptedBy,
  testNamePattern = null,
}) {
  const ran = report?.ran ?? [];
  const unexpected = ran.filter((f) => !files.includes(f));
  const unrun = files.filter((f) => !ran.includes(f));
  const fail = (reason) => ({ result: 'fail', exit: exit || 1, reason });
  if (timedOut) {
    return { result: 'timeout', exit: exit || EXIT_TIMEOUT, reason: 'RUN_TIMEOUT_MS exceeded' };
  }
  if (interruptedBy !== null) {
    return {
      result: 'interrupted',
      exit: exit || signalExit(interruptedBy),
      reason: interruptedBy,
    };
  }
  if (unexpected.length > 0) return fail(`ran unselected files: ${unexpected.join(',')}`);
  if (exit !== 0) return { result: 'fail', exit };
  if (report === null) return fail('vitest wrote no JSON report');
  if (unrun.length > 0) return fail(`selected files did not run: ${unrun.join(',')}`);
  const idle = files.filter((f) => (report.executed[f] ?? 0) === 0);
  if (idle.length > 0) return fail(`no tests executed in: ${idle.join(',')}`);
  if (testNamePattern !== null) {
    return {
      result: 'filtered',
      exit,
      reason: `diagnostic only; not gate evidence: testNamePattern=${JSON.stringify(testNamePattern)}`,
    };
  }
  return { result: 'pass', exit };
}
