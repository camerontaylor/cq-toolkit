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
  -t <pattern>               only tests whose full name matches <pattern>
  --max-wait <seconds>       bound the wait for the host lock (default and
                             ceiling ${MAX_WAIT_CEILING_S})
  -h, --help                 this text

Refused: --watch, --coverage, --ui and any other vitest flag; more than
${MAX_FILES} test files; selections that fall back to every test.`;

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
 *   named: string[],      test files the caller named explicitly
 *   manifest: Record<string, string>,
 *   include: string[],    gated classes the caller opted into
 * }} input
 * @returns {{ ok: true, run: {file: string, project: string}[], dropped: {file: string, project: string}[] }
 *   | { ok: false, reason: string, candidates: string[] }}
 */
export function planRun({ selection, named, manifest, include }) {
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
  const dropped = [];
  for (const file of selection.files) {
    const project = classOf(file, manifest);
    if (!GATED_CLASSES.includes(project) || include.includes(project)) {
      run.push({ file, project });
    } else if (named.includes(file)) {
      return {
        ok: false,
        reason: `${file} is classified ${project}; pass --include-${project} to run it`,
        candidates: [],
      };
    } else dropped.push({ file, project });
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
  return { ok: true, run, dropped };
}

/** Projects in vitest.config.ts group order, restricted to the plan. */
export function projectsOf(run) {
  const order = ['pure', 'process', 'live', 'integration'];
  const used = new Set(run.map((r) => r.project));
  return order.filter((p) => used.has(p));
}

/**
 * The stable one-line summary agents quote. Keys always appear, in this
 * order; absent values print as `-`. Free text (reason) is JSON-quoted.
 */
export function summaryLine(s) {
  const dash = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));
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
    ['source', s.source],
    ['ran', s.ran?.join(',')],
  ];
  const line = fields.map(([k, v]) => `${k}=${dash(v)}`).join(' ');
  return `test:narrow ${line}${s.reason ? ` reason=${JSON.stringify(s.reason)}` : ''}`;
}

/** Read the counts and executed files out of vitest's JSON report. */
export function readReport(report, toRelative) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return null;
  }
  const num = (k) => (Number.isInteger(report[k]) ? report[k] : 0);
  return {
    tests: {
      total: num('numTotalTests'),
      passed: num('numPassedTests'),
      failed: num('numFailedTests'),
      skipped: num('numPendingTests') + num('numTodoTests'),
    },
    ran: report.testResults.map((r) => toRelative(String(r.name))).sort(),
  };
}
