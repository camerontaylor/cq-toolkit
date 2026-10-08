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
//   5. build once: dist is rebuilt only when stale (ratchet-lib's
//      distIsFresh, #255), as a child process group recorded in the lock
//      like vitest's (below), killed after BUILD_TIMEOUT_MS; the vitest child
//      then gets CQ_DIST_PREPARED=1 so the root globalSetup
//      (test/global-setup.ts, the build-once harvest) does not build again;
//   6. ONE vitest invocation: the plan's projects, serial files, one worker,
//      a JSON report for the counts, in its own process group (recorded in
//      the lock with its leader's start time, so a killed runner cannot
//      leave an orphan that runs beside the next one), killed after
//      RUN_TIMEOUT_MS; load= and uptime= are sampled just before it starts;
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
import { isTest, selectAffected } from './lib/affected-tests.mjs';
import { scrubbedBuildEnv } from './lib/build-env.mjs';
import { EX_TEMPFAIL, acquireLock, canSignalGroup, describeHolder } from './lib/heavy-lock.mjs';
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
  signalExit,
  spawnLocked,
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
const stamp = () => ({ load: loadavg()[0].toFixed(1), uptimeS: uptime() });
// Re-stamped just before vitest starts; this sample stands only when no run happens.
const summary = { result: 'error', exit: 1, nice: getPriority(), ...stamp() };
let printed = false;
let releaseLock = () => {};
let child = null;
let childDone = false;
let childIdentity = null;
let interruptedBy = null;
const relayed = new Set();

/** Signal the current child's whole process group (vitest's pool workers, the build's tsc). */
const signalChild = (signal) => {
  if (child === null || childDone || child.pid === undefined) return;
  try {
    if (POSIX) {
      if (!canSignalGroup(childIdentity)) {
        say(
          `skipping ${signal} for process group ${child.pid}: gone or leader identity unverified`,
        );
        return;
      }
      process.kill(-child.pid, signal);
    }
    // Windows has no process groups and child.kill() ends only the leader:
    // end the whole tree (cmd/pnpm/tsc, vitest's workers) while it is alive.
    else spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // the group is gone already
  }
};
/** How long cleanup waits for a group to disappear before the lock is pinned. */
const SWEEP_WAIT_MS = 10_000;
/** Set when a child group survives cleanup: the lock is then never released. */
let lockPinned = false;
/**
 * True once no RUNNABLE process of the group led by `pid` remains. A zombie
 * cannot run, and from the 'exit' handler our own killed leader stays an
 * unreaped zombie (the event loop never runs again) — which kill(-pgid, 0)
 * still reports (Linux: success; macOS: EPERM). So anything but ESRCH asks
 * ps whether a non-zombie member is left.
 */
const groupGone = (pid) => {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return true;
  }
  const res = spawnSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' });
  if (res.status !== 0) return false;
  return !res.stdout.split('\n').some((line) => {
    const [pgid, stat] = line.trim().split(/\s+/);
    return Number(pgid) === pid && stat !== undefined && !stat.startsWith('Z');
  });
};
/**
 * SIGKILL only a group whose live leader matches its recorded start time,
 * then wait — bounded, synchronously (also from the 'exit' handler) — until
 * it is gone. An unverifiable group is never signalled. SIGKILL is asynchronous,
 * and the lock must not free while a member still runs. A group that outlives
 * the wait pins the lock: its record stays for the next waiter to judge.
 */
const sweepChild = () => {
  if (child === null || childDone || child.pid === undefined) return;
  signalChild('SIGKILL');
  if (!POSIX) return; // taskkill /T /F has already ended the tree
  const tick = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + SWEEP_WAIT_MS;
  while (!groupGone(child.pid)) {
    if (Date.now() >= deadline) {
      say(`process group ${child.pid} still runs after cleanup; leaving the host lock held`);
      lockPinned = true;
      releaseLock = () => {};
      return;
    }
    Atomics.wait(tick, 0, 0, 25);
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
// Every exit path — including a library's process.exit and an uncaught
// exception — stops the child's group, prints the summary and frees the
// lock, in that order: the lock is never free while a child runs. An
// unplanned exit is never a success, even when the event loop just drained.
process.on('exit', (code) => {
  sweepChild();
  if (!printed) {
    printed = true;
    const exit = code || 1;
    process.exitCode = exit;
    emit({ ...summary, result: 'error', exit, reason: summary.reason ?? 'exited early' });
  }
  releaseLock();
});
for (const signal of SIGNALS) {
  process.on(signal, () => {
    if (child === null || childDone) {
      finish({ result: 'interrupted', exit: signalExit(signal), reason: signal });
    }
    interruptedBy ??= signal;
    if (relayed.has(signal)) return;
    relayed.add(signal);
    signalChild(signal); // the code awaiting the child finishes
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
  .filter((file) => isTest(file) && existsSync(file))
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

/**
 * Run one child in its own process group, recorded in the lock (pgid and
 * leader start time) before anything waits on it, so a runner killed
 * mid-child leaves a group the next waiter can verify and kill, or wait
 * out. Resolves once it exits and its group is gone (sweepChild); after that
 * the pgid is never signalled again (it could be reused).
 */
const runGroup = (command, args, { label, timeoutMs, ...options }) =>
  new Promise((done) => {
    let timedOut = false;
    childDone = false;
    try {
      const spawned = spawnLocked(
        lock,
        () => {
          child = spawn(command, args, { cwd: ROOT, detached: POSIX, ...options });
          // Keep local identity even if writing the lock annotation throws.
          childIdentity = { childPgid: child.pid, childStartedAt: new Date().toISOString() };
          return child;
        },
        POSIX,
      );
      child = spawned.child;
      childIdentity = spawned.identity ?? childIdentity;
    } catch (error) {
      if (error.code === EX_TEMPFAIL) {
        finish({ result: 'lock-lost', exit: EX_TEMPFAIL, reason: error.message });
      }
      throw error;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      say(`${label} exceeded ${timeoutMs / 60_000} min; terminating`);
      signalChild('SIGTERM');
      setTimeout(() => signalChild('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    timer.unref();
    const settle = (outcome) => {
      clearTimeout(timer);
      sweepChild(); // whatever the child left behind in its group, until gone
      childDone = true;
      done({ ...outcome, timedOut });
    };
    child.on('error', (error) => settle({ error }));
    child.on('exit', (code, signal) => settle({ code, signal }));
  });

// 5. Build once --------------------------------------------------------------
const { BUILD_TIMEOUT_MS, distIsFresh } = await import('./ratchet-lib.mjs');
if (!distIsFresh()) {
  say('dist is stale: pnpm run build');
  const build = await runGroup('pnpm', ['run', 'build'], {
    label: 'dist build',
    timeoutMs: BUILD_TIMEOUT_MS,
    stdio: ['ignore', 2, 2], // stdout carries only the summary line
    env: scrubbedBuildEnv(process.env), // live suites' credentials stay out of the build
    shell: !POSIX, // pnpm is a .cmd shim on win32
  });
  if (lockPinned) {
    finish({
      result: 'error',
      exit: 1,
      reason: 'the dist build left processes that survived cleanup',
    });
  }
  lock.annotate({ childPgid: null });
  if (interruptedBy !== null) {
    finish({ result: 'interrupted', exit: signalExit(interruptedBy), reason: interruptedBy });
  }
  if (build.error !== undefined || build.timedOut || build.code !== 0) {
    const why =
      build.error?.message ??
      (build.timedOut
        ? `timed out after ${BUILD_TIMEOUT_MS / 60_000} min`
        : build.signal
          ? `killed by ${build.signal}`
          : `exit ${build.code}`);
    finish({ result: 'error', exit: 1, reason: `dist build failed (pnpm run build): ${why}` });
  }
}

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

// The load stamp belongs to the timed interval: sampled at its start.
Object.assign(summary, stamp());
const started = Date.now();
const run = await runGroup(process.execPath, vitestArgs, {
  label: 'run',
  timeoutMs: RUN_TIMEOUT_MS,
  stdio: 'inherit',
  env: { ...process.env, CQ_DIST_PREPARED: '1' },
});
const durationMs = Date.now() - started;
let report = null;
try {
  report = readReport(JSON.parse(readFileSync(reportPath, 'utf8')), repoRelative);
} catch {
  // no report (vitest died early, or never started): counts stay '-'
}
rmSync(reportDir, { recursive: true, force: true });
if (lockPinned) {
  finish({
    result: 'error',
    exit: 1,
    reason: 'the test run left processes that could not be safely swept',
  });
}
if (run.error !== undefined) {
  finish({ result: 'error', exit: 1, reason: `cannot start vitest: ${run.error.message}` });
}
const exit = run.code ?? signalExit(run.signal);
const verdict = runVerdict({ exit, report, files, timedOut: run.timedOut, interruptedBy });
finish({ durationMs, ...report, ...verdict });
