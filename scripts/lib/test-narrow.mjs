// Pure policy for scripts/test-narrow.mjs, the ONE permitted local test
// command (AGENTS.md "Local testing"). Everything here is data in, data out
// — argv parsing, the run plan and the summary line — so
// test/scripts/test-narrow.test.ts covers the policy without spawning.
//
// The policy, in one place:
//   - one vitest invocation per call, files serial, under `nice -n 5` and
//     the host-wide lock (the entry script enforces both);
//   - at most MAX_FILES test files; a selection that fell back to "every
//     test" is refused, never truncated;
//   - integration and live suites run only when a flag names their class;
//   - no watch mode, no coverage, no passthrough of arbitrary vitest flags;
//   - zero selected files means zero runs (a bare `vitest run` would be the
//     FULL suite, which is CI-only).

import { constants } from 'node:os';
import { EX_TEMPFAIL, LOCK_PATH } from './heavy-lock.mjs';

export const MAX_FILES = 10;
export const NICE_INCREMENT = 5;
export const MAX_WAIT_CEILING_S = 1800;
/** A narrow run that is still going after this is killed (frees the host lock). */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_BASE = 'origin/merge-queue';
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
  --dry-run, --list          take the lock, print the plan, run nothing
  --include-integration      allow suites classified integration
  --include-live             allow suites classified live
  -t <pattern>               diagnostic only: match full test names; successful
                             runs report result="filtered", never gate evidence
  --max-wait <seconds>       bound the wait for the host lock (default and
                             ceiling ${MAX_WAIT_CEILING_S})
  -h, --help                 this text

Refused: --watch, --coverage, --ui and any other vitest flag; more than
${MAX_FILES} test files; selections that fall back to every test; selections
that include integration or live suites without their --include flag.
Exit 75: host lock busy or ownership lost before a child spawn; retry later.
Manual recovery for a dead owner with an unrecorded pending child:
  This lock is NEVER auto-reclaimed: the child cannot be identified.
  Pause all test:narrow callers. Read ${LOCK_PATH}/owner.json and inspect
  the host process list for stray runners, builds and test workers; stop
  them and verify they have exited. Only then remove the lock explicitly:
    rm -rf ${LOCK_PATH}
  On Windows remove that directory using your shell. Resume callers afterward.
Live drill (classified integration):
  LIVE_GH=1 pnpm test:narrow --include-integration test/e2e/merge/live.test.ts`;

const REFUSED_FLAGS = {
  '--watch': 'watch mode never terminates and holds the host lock',
  '-w': 'watch mode never terminates and holds the host lock',
  '--coverage': 'coverage instruments all of src/ (the coverage ratchet runs in CI)',
  '--ui': 'the UI server never terminates and holds the host lock',
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
    maxWaitS: MAX_WAIT_CEILING_S,
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
      else if (flag === '--max-wait') {
        const raw = value();
        if (!/^\d+$/.test(raw) || Number(raw) > MAX_WAIT_CEILING_S) {
          throw new Error(`--max-wait takes whole seconds 0..${MAX_WAIT_CEILING_S}, got ${raw}`);
        }
        options.maxWaitS = Number(raw);
      } else if (flag.startsWith('-')) {
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
export function planRun({ selection, manifest, include }) {
  if (selection.fallback) {
    return {
      ok: false,
      reason:
        `selection is unbounded (${selection.reason}); ` +
        `name at most ${MAX_FILES} test files explicitly`,
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
      reason: `gated test files cover the change: ${listed}; pass ${flags.join(' ')} to run them`,
      candidates: [],
    };
  }
  if (run.length > MAX_FILES) {
    return {
      ok: false,
      reason:
        `${run.length} test files selected, the cap is ${MAX_FILES}; ` +
        'name the files that cover your change explicitly',
      candidates: run.map((r) => r.file),
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
  const order = ['pure', 'process', 'live', 'integration'];
  const used = new Set(run.map((r) => r.project));
  return order.filter((p) => used.has(p));
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
    ['wait', secs(s.waitMs)],
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
 * How long a repeat of a terminal signal is still the immediate duplicate:
 * one terminal interrupt reaches the niced runner twice (the terminal
 * signals the whole foreground group, and the un-niced parent relays), a
 * few milliseconds apart. Only a repeat arriving after this window is a
 * human's second Ctrl-C.
 */
export const INTERRUPT_GRACE_MS = 1_000;

/**
 * The response to one received terminal signal while the runner holds the
 * lock, from the per-signal time its first copy was relayed. The first copy
 * of a signal is relayed to the child group gracefully; a repeat inside the
 * grace window is the parent relay's duplicate and is absorbed. A repeat
 * AFTER the window means the graceful relay went unheeded: it escalates to
 * the group sweep (SIGKILL of the verified identity, bounded wait) instead
 * of waiting out the run/build timeout (#283). With no live child the
 * runner finishes at once.
 * @param {{
 *   childLive: boolean,
 *   signal: string,
 *   relayedAt: Record<string, number | undefined>,
 *   now: number,
 * }} input
 * @returns {'relay' | 'absorb' | 'escalate' | 'finish'}
 */
export function interruptAction({ childLive, signal, relayedAt, now }) {
  if (!childLive) return 'finish';
  const first = relayedAt[signal];
  if (first === undefined) return 'relay';
  return now - first >= INTERRUPT_GRACE_MS ? 'escalate' : 'absorb';
}

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

/** Fence each heavy spawn and cover a crash between spawn and child annotation. */
export function spawnLocked(lock, spawnChild, recordGroup = true) {
  lock.annotate({ childPending: true });
  if (!lock.stillHeld()) {
    throw Object.assign(new Error('host lock ownership lost before child spawn'), {
      code: EX_TEMPFAIL,
    });
  }
  const child = spawnChild();
  const identity =
    recordGroup && child.pid !== undefined ? lock.annotate({ childPgid: child.pid }) : undefined;
  return { child, identity };
}
