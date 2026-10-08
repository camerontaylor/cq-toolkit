#!/usr/bin/env node
// test-narrow — the ONE permitted local test command (`pnpm test:narrow`).
// The full suite is CI-only. This script IS the policy: callers do not pick
// vitest flags, projects, priorities or concurrency; they name files (or a
// git range) and the script decides. Usage: `pnpm test:narrow --help`.
//
// Order of operations:
//   1. priority: when below `nice -n 5`, re-exec under it (children inherit);
//      the check reads the real niceness, so no env var can skip it;
//   2. parse argv (scripts/lib/test-narrow.mjs; refusals exit 2);
//   3. the host-wide single-flight lock (scripts/lib/heavy-lock.mjs), bounded
//      wait, exit 75 on timeout; held through selection, build and run;
//   4. selection: explicit files, or the changed files of a git range, mapped
//      to test files by scripts/lib/affected-tests.mjs (import graph ∪
//      reviewed non-import map); fallbacks, oversize selections and
//      integration/live suites are refused (see planRun);
//   5. build once: ensureDist() (#255) rebuilds dist only when stale, then
//      the vitest child gets CQ_DIST_PREPARED=1 so the root globalSetup
//      (test/global-setup.ts, the build-once harvest) does not build again;
//   6. ONE vitest invocation: the plan's projects, serial files, one worker,
//      a JSON report for the counts, in its own process group (recorded in
//      the lock, so a killed runner cannot leave an orphan that runs beside
//      the next one), killed after RUN_TIMEOUT_MS;
//   7. one stable summary line on stdout (`test:narrow result=… exit=…`),
//      printed on every exit path.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { constants, getPriority, loadavg, setPriority, tmpdir, uptime } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectAffected } from './lib/affected-tests.mjs';
import { EX_TEMPFAIL, acquireLock, describeHolder } from './lib/heavy-lock.mjs';
import {
  DEFAULT_BASE,
  NICE_INCREMENT,
  RUN_TIMEOUT_MS,
  USAGE,
  missingManifestEntries,
  parseArgs,
  planRun,
  projectsOf,
  readReport,
  runVerdict,
  summaryLine,
} from './lib/test-narrow.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '..');
const REEXEC_MARK = 'CQ_TEST_NARROW_REEXEC';
const POSIX = process.platform !== 'win32';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const argv = process.argv.slice(2);
const say = (line) => process.stderr.write(`test:narrow: ${line}\n`);
const toPosix = (path) => path.split(sep).join('/');
const repoRelative = (path) => toPosix(relative(ROOT, resolve(ROOT, path)));
const signalExit = (signal) => 128 + (constants.signals[signal] ?? 1);
/** Synchronous: stdout to a pipe is asynchronous on macOS, and we exit next. */
const emit = (fields) => {
  const line = `${summaryLine(fields)}\n`;
  try {
    writeSync(1, line);
  } catch {
    process.stdout.write(line);
  }
};

// 1. Priority ---------------------------------------------------------------
if (getPriority() < NICE_INCREMENT) {
  if (!POSIX) {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  } else if (process.env[REEXEC_MARK] === '1') {
    const reason = `priority ${getPriority()} after nice -n ${NICE_INCREMENT}`;
    emit({ result: 'refused', exit: 2, reason });
    process.exit(2);
  } else {
    const niced = spawn('nice', ['-n', String(NICE_INCREMENT), process.execPath, SCRIPT, ...argv], {
      stdio: 'inherit',
      env: { ...process.env, [REEXEC_MARK]: '1' },
    });
    // A terminal signal reaches both processes (same group); the niced one
    // relays each signal to its vitest group once, so the duplicate is moot.
    for (const signal of SIGNALS) process.on(signal, () => niced.kill(signal));
    niced.on('error', (error) => {
      emit({ result: 'error', exit: 1, reason: `cannot re-exec under nice: ${error.message}` });
      process.exit(1);
    });
    niced.on('exit', (code, signal) => {
      // Killed by a signal, the niced process printed no summary: print one.
      if (signal !== null) {
        const reason = `niced runner killed by ${signal}`;
        emit({ result: 'interrupted', exit: signalExit(signal), reason });
      }
      process.exit(code ?? signalExit(signal));
    });
    // The niced process does the work; this one only relays its exit.
    await new Promise(() => {});
  }
}

// From here on this process runs niced. ------------------------------------
// pnpm runs scripts from the package root and passes the caller's directory
// as INIT_CWD; explicit relative paths resolve against the caller's.
const CALLER_CWD = process.env.INIT_CWD ?? process.cwd();
process.chdir(ROOT);
const summary = {
  result: 'error',
  exit: 1,
  nice: getPriority(),
  load: loadavg()[0].toFixed(1),
  uptimeS: uptime(),
};
let printed = false;
let releaseLock = () => {};
let child = null;
let childDone = false;
let interruptedBy = null;
const relayed = new Set();

/** Signal vitest's whole process group (its pool workers and their spawns). */
const signalChild = (signal) => {
  if (child === null || childDone || child.pid === undefined) return;
  try {
    if (POSIX) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // the group is gone already
  }
};
const finish = (fields) => {
  Object.assign(summary, fields);
  if (!printed) {
    printed = true;
    emit(summary);
  }
  releaseLock();
  process.exit(summary.exit);
};
// Every exit path — including a library's process.exit (ensureDist's fail)
// and an uncaught exception — stops vitest's group, prints the summary and
// frees the lock, in that order: the lock is never free while tests run.
process.on('exit', (code) => {
  signalChild('SIGKILL');
  if (!printed) {
    printed = true;
    emit({ ...summary, result: 'error', exit: code, reason: summary.reason ?? 'exited early' });
  }
  releaseLock();
});
for (const signal of SIGNALS) {
  process.on(signal, () => {
    if (child === null) finish({ result: 'interrupted', exit: signalExit(signal), reason: signal });
    interruptedBy ??= signal;
    if (relayed.has(signal)) return;
    relayed.add(signal);
    signalChild(signal); // the child's exit handler finishes
  });
}

// 2. Arguments --------------------------------------------------------------
const parsed = parseArgs(argv);
if (!parsed.ok && parsed.help) {
  process.stderr.write(`${USAGE}\n`);
  finish({ result: 'help', exit: 0 });
}
if (!parsed.ok) finish({ result: 'refused', exit: 2, reason: parsed.reason });
const opts = parsed.options;

// 3. Host lock --------------------------------------------------------------
const lock = await acquireLock({
  maxWaitMs: opts.maxWaitS * 1000,
  info: { cwd: ROOT, command: `test:narrow ${argv.join(' ')}`.trim() },
});
summary.waitMs = lock.waitedMs;
if (!lock.acquired) {
  finish({
    result: 'lock-timeout',
    exit: EX_TEMPFAIL,
    reason: `host lock still held by ${describeHolder(lock.holder)}`,
  });
}
releaseLock = lock.release;

// 4. Selection --------------------------------------------------------------
const git = (args) => {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (res.error || res.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${res.error?.message ?? res.stderr.trim()}`);
  }
  return res.stdout;
};
const zsplit = (out) => out.split('\0').filter(Boolean);
const diffNames = (...revs) =>
  zsplit(git(['diff', '--name-only', '--no-renames', '-z', '--end-of-options', ...revs]));

let changed;
try {
  if (opts.files.length > 0) {
    summary.source = 'explicit';
    changed = opts.files.map((file) => {
      const abs = resolve(CALLER_CWD, file);
      const rel = relative(ROOT, abs);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`not inside the repository: ${file}`);
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`no such file: ${file}`);
      return toPosix(rel);
    });
  } else if (opts.range !== null) {
    summary.source = `range:${opts.range}`;
    changed = diffNames(opts.range);
  } else {
    const ref = opts.base ?? DEFAULT_BASE;
    const mergeBase = git(['merge-base', '--end-of-options', ref, 'HEAD']).trim();
    summary.source = `base:${ref}@${mergeBase.slice(0, 10)}`;
    changed = [
      ...diffNames(`${mergeBase}..HEAD`),
      ...diffNames('HEAD'),
      ...zsplit(git(['ls-files', '--others', '--exclude-standard', '-z'])),
    ];
  }
} catch (error) {
  finish({ result: 'refused', exit: 2, reason: error.message });
}
changed = [...new Set(changed)].sort();
const missing = changed.filter((f) => !existsSync(f));

const manifest = JSON.parse(readFileSync(join(ROOT, 'test/suite-classes.json'), 'utf8'));
const staleEntries = missingManifestEntries(manifest, existsSync);
if (staleEntries.length > 0) {
  const reason = `test/suite-classes.json lists missing files: ${staleEntries.join(',')}`;
  finish({ result: 'refused', exit: 2, reason });
}
// Every test file on disk, classified or not (unclassified ones run in the
// conservative `process` project), so the class gate sees all of them.
const allTests = [
  ...new Set([
    ...Object.keys(manifest),
    ...['test', 'lint'].flatMap((dir) =>
      readdirSync(dir, { recursive: true }).map((f) => `${dir}/${toPosix(String(f))}`),
    ),
  ]),
]
  .filter((file) => file.endsWith('.test.ts') && existsSync(file))
  .sort();

// The import-graph query loads vitest's module graph (no tests execute); it
// runs only for changed sources that still exist (deleted ones fall back).
let related = [];
let relatedError = null;
const sources = changed.filter(
  (f) => /^(src|scripts)\//.test(f) && /\.(ts|mts|js|mjs)$/.test(f) && !missing.includes(f),
);
if (sources.length > 0) {
  try {
    const { createVitest } = await import('vitest/node');
    const vitest = await createVitest('test', { related: sources, watch: false, run: true });
    try {
      const specs = await vitest.getRelevantTestSpecifications();
      related = specs.map((spec) => repoRelative(spec.moduleId));
    } finally {
      await vitest.close();
    }
  } catch (error) {
    related = null;
    relatedError = error instanceof Error ? error.message.split('\n')[0] : String(error);
  }
}

const selection = selectAffected({ changed, allTests, related, missing });
if (relatedError !== null) selection.reason += `: ${relatedError}`;
const plan = planRun({ selection, manifest, include: opts.include });
if (!plan.ok) {
  if (plan.candidates.length > 0) {
    say('selected (choose a subset and name it explicitly):');
    for (const file of plan.candidates) say(`  ${file}`);
  }
  const files = plan.candidates.length > 0 ? plan.candidates : undefined;
  finish({ result: 'refused', exit: 2, files, reason: plan.reason });
}
const projects = projectsOf(plan.run);
const files = plan.run.map((r) => r.file);
Object.assign(summary, { files, projects });
say(`${changed.length} changed file(s) -> ${files.length} test file(s)`);
for (const r of plan.run) say(`  ${r.project.padEnd(11)} ${r.file}`);

if (opts.dryRun) finish({ result: 'dry-run', exit: 0 });
if (files.length === 0) {
  // Never start vitest with no file filter: that would be the full suite.
  finish({ result: 'nothing', exit: 0, reason: 'no test file covers the change' });
}

// 5. Build once --------------------------------------------------------------
const { ensureDist } = await import('./ratchet-lib.mjs');
summary.reason = 'dist build failed (pnpm run build)'; // ensureDist exits on failure
ensureDist();
delete summary.reason;

// 6. One vitest invocation ----------------------------------------------------
const reportDir = mkdtempSync(join(tmpdir(), 'cq-test-narrow-'));
const reportPath = join(reportDir, 'report.json');
const vitestArgs = [
  join(ROOT, 'node_modules/vitest/vitest.mjs'),
  'run',
  ...projects.flatMap((p) => ['--project', p]),
  '--no-file-parallelism',
  '--maxWorkers=1',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${reportPath}`,
  ...(opts.testNamePattern === null ? [] : [`--testNamePattern=${opts.testNamePattern}`]),
  // Absolute paths: vitest keeps a test file whose path starts with an
  // absolute filter (and whose relative path contains it); the post-run
  // check below catches any extra file such a match would pull in.
  ...files.map((f) => join(ROOT, f)),
];
say(
  `exec nice(${getPriority()}) node ${vitestArgs.map((a) => toPosix(relative(ROOT, a)) || a).join(' ')}`,
);

const started = Date.now();
child = spawn(process.execPath, vitestArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, CQ_DIST_PREPARED: '1' },
  detached: POSIX, // own process group: signalChild reaches every descendant
});
if (POSIX && child.pid !== undefined) lock.annotate({ childPgid: child.pid });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  say(`run exceeded ${RUN_TIMEOUT_MS / 60_000} min; terminating`);
  signalChild('SIGTERM');
  setTimeout(() => signalChild('SIGKILL'), 10_000).unref();
}, RUN_TIMEOUT_MS);
timer.unref();

child.on('error', (error) => {
  rmSync(reportDir, { recursive: true, force: true });
  finish({ result: 'error', exit: 1, reason: `cannot start vitest: ${error.message}` });
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  // Sweep anything the run left behind in its group before the lock frees;
  // after that the pgid is never signalled again (it could be reused).
  signalChild('SIGKILL');
  childDone = true;
  let report = null;
  try {
    report = readReport(JSON.parse(readFileSync(reportPath, 'utf8')), repoRelative);
  } catch {
    // no report (vitest died early): counts stay '-'
  }
  rmSync(reportDir, { recursive: true, force: true });
  const exit = code ?? signalExit(signal);
  const verdict = runVerdict({ exit, report, files, timedOut, interruptedBy });
  finish({ durationMs: Date.now() - started, ...report, ...verdict });
});
