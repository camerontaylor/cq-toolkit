#!/usr/bin/env node
// Named tests under nice, with headroom preflight and optional resource scope.
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
import { enterResourceScope } from './lib/resource-scope.mjs';
import { needsDist } from './lib/dist-tests.mjs';
import {
  DEFAULT_BASE,
  NICE_INCREMENT,
  RUN_TIMEOUT_MS,
  USAGE,
  loggedVitestArgs,
  missingManifestEntries,
  parseArgs,
  planRun,
  projectsOf,
  readReport,
  readPythonReport,
  pythonRunVerdict,
  selectPython,
  runVerdict,
  signalExit,
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
const emit = (fields) => process.stdout.write(`${summaryLine(fields)}\n`);

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
    // relays each signal once and absorbs this immediate duplicate inside
    // its interrupt grace window (only a repeat after the window escalates).
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
// Re-stamped at the start of the combined Python/build/Vitest interval.
const summary = { result: 'error', exit: 1, nice: getPriority(), ...stamp() };
let printed = false;
let child = null;
let childDone = false;
let interruptedBy = null;
const signalChild = (signal) => {
  if (child === null || childDone || child.pid === undefined) return;
  try {
    if (POSIX) process.kill(-child.pid, signal);
    else spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already exited */
  }
};
const sweepChild = () => signalChild('SIGKILL');
const awaitExit = () =>
  new Promise(() => process.stdout.write('', () => process.exit(process.exitCode)));
const finish = async (fields) => {
  Object.assign(summary, fields);
  if (!printed) {
    printed = true;
    emit(summary);
  }
  process.exitCode = summary.exit;
  await awaitExit();
};
process.on('exit', () => sweepChild());
// 2. Arguments --------------------------------------------------------------
const parsed = parseArgs(argv);
if (!parsed.ok && parsed.help) {
  process.stderr.write(`${USAGE}\n`);
  await finish({ result: 'help', exit: 0 });
}
if (!parsed.ok) await finish({ result: 'refused', exit: 2, reason: parsed.reason });
const opts = parsed.options;

if (!opts.dryRun) {
  try {
    const scoped = await enterResourceScope(SCRIPT, argv, {
      onSignalExit: (signal, exit) =>
        emit({
          ...summary,
          result: signal === 'SIGKILL' ? 'error' : 'interrupted',
          exit,
          reason: `scope runner killed by ${signal}`,
        }),
    });
    if (scoped) {
      process.exitCode = scoped.exit;
      await awaitExit();
    }
  } catch (error) {
    await finish({ result: 'refused', exit: error.code === 75 ? 75 : 1, reason: error.message });
  }
}

for (const signal of SIGNALS) {
  process.on(signal, async () => {
    interruptedBy = signal;
    sweepChild();
    await finish({ result: 'interrupted', exit: signalExit(signal), reason: signal });
  });
}

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
  await finish({ result: 'refused', exit: 2, reason: error.message });
}
changed = [...new Set(changed)].sort();
const missing = changed.filter((f) => !existsSync(f));

const manifest = JSON.parse(readFileSync(join(ROOT, 'test/suite-classes.json'), 'utf8'));
const staleEntries = missingManifestEntries(manifest, existsSync);
if (staleEntries.length > 0) {
  const reason = `test/suite-classes.json lists missing files: ${staleEntries.join(',')}`;
  await finish({ result: 'refused', exit: 2, reason });
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

const pythonTests = readdirSync(join(ROOT, 'apps/crq-python'))
  .filter((f) => /^test_[A-Za-z0-9_]+\.py$/.test(f))
  .map((f) => `apps/crq-python/${f}`);
const pythonSelection = selectPython(changed, pythonTests, missing);
const selection = selectAffected({
  changed: changed.filter((f) => !f.startsWith('apps/crq-python/')),
  allTests,
  related,
  missing,
});
selection.files = [...new Set([...selection.files, ...pythonSelection.files])].sort();
if (pythonSelection.fallback) {
  selection.fallback = true;
  selection.reason = pythonSelection.reason;
}
if (relatedError !== null) selection.reason += `: ${relatedError}`;
const plan = planRun({ selection, manifest, include: opts.include });
if (!plan.ok) {
  if (plan.candidates.length > 0) {
    say('selected (choose a subset and name it explicitly):');
    for (const file of plan.candidates) say(`  ${file}`);
  }
  const files = plan.candidates.length > 0 ? plan.candidates : undefined;
  await finish({ result: 'refused', exit: 2, files, reason: plan.reason });
}
const projects = projectsOf(plan.run);
const files = plan.run.map((r) => r.file);
const pythonFiles = plan.run.filter((r) => r.project === 'python').map((r) => r.file);
const tsFiles = files.filter((f) => !pythonFiles.includes(f));
if (pythonFiles.length > 0 && opts.testNamePattern !== null) {
  await finish({
    result: 'refused',
    exit: 2,
    reason: 'test-name filtering is unavailable for Python',
  });
}
Object.assign(summary, { files, projects });
say(`${changed.length} changed file(s) -> ${files.length} test file(s)`);
for (const r of plan.run) say(`  ${r.project.padEnd(11)} ${r.file}`);

if (opts.dryRun) await finish({ result: 'dry-run', exit: 0 });
if (files.length === 0) {
  // Never start vitest with no file filter: that would be the full suite.
  await finish({ result: 'nothing', exit: 0, reason: 'no test file covers the change' });
}

// Run each child in a group owned only by this invocation.
const runGroup = (command, args, { label, timeoutMs, captureStderr = false, ...options }) =>
  new Promise((done) => {
    let timedOut = false;
    let stderr = '';
    childDone = false;
    child = spawn(command, args, { cwd: ROOT, detached: POSIX, ...options });
    if (captureStderr)
      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        stderr = (stderr + chunk.toString()).slice(-1_048_576);
      });
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
      done({ ...outcome, timedOut, stderr });
    };
    child.on('error', (error) => settle({ error }));
    child.on('close', (code, signal) => settle({ code, signal }));
  });

// Python and TypeScript children run serially under the same resource scope.
Object.assign(summary, stamp());
const started = Date.now();
let pythonCounts = null;
if (pythonFiles.length > 0) {
  const modules = pythonFiles.map((f) => f.slice('apps/crq-python/'.length, -3));
  say(`exec python3 -m unittest ${modules.join(' ')}`);
  const run = await runGroup('python3', ['-m', 'unittest', ...modules], {
    label: 'Python run',
    timeoutMs: RUN_TIMEOUT_MS,
    cwd: join(ROOT, 'apps/crq-python'),
    stdio: ['ignore', 'inherit', 'pipe'],
    captureStderr: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHON_COLORS: '0' },
  });
  pythonCounts = readPythonReport(run.stderr);
  const verdict = pythonRunVerdict({ run, counts: pythonCounts, interruptedBy });
  if (verdict.result !== 'pass') {
    await finish({
      ...verdict,
      tests: pythonCounts,
      ran: pythonFiles,
      durationMs: Date.now() - started,
    });
  }
  if (tsFiles.length === 0)
    await finish({
      result: 'pass',
      exit: 0,
      tests: pythonCounts,
      ran: pythonFiles,
      durationMs: Date.now() - started,
    });
}

// 5. Build once --------------------------------------------------------------
const { BUILD_TIMEOUT_MS, distIsFresh } = await import('./ratchet-lib.mjs');
if (needsDist(tsFiles, ROOT) && !distIsFresh()) {
  say('dist is stale: pnpm run build');
  const build = await runGroup('pnpm', ['run', 'build'], {
    label: 'dist build',
    timeoutMs: BUILD_TIMEOUT_MS,
    stdio: ['ignore', 2, 2], // stdout carries only the summary line
    env: scrubbedBuildEnv(process.env), // live suites' credentials stay out of the build
    shell: !POSIX, // pnpm is a .cmd shim on win32
  });
  if (interruptedBy !== null) {
    await finish({ result: 'interrupted', exit: signalExit(interruptedBy), reason: interruptedBy });
  }
  if (build.error !== undefined || build.timedOut || build.code !== 0) {
    const why =
      build.error?.message ??
      (build.timedOut
        ? `timed out after ${BUILD_TIMEOUT_MS / 60_000} min`
        : build.signal
          ? `killed by ${build.signal}`
          : `exit ${build.code}`);
    await finish({
      result: 'error',
      exit: 1,
      reason: `dist build failed (pnpm run build): ${why}`,
    });
  }
}

// 6. One vitest invocation ----------------------------------------------------
const reportDir = mkdtempSync(join(tmpdir(), 'cq-test-narrow-'));
const reportPath = join(reportDir, 'report.json');
const vitestArgs = [
  join(ROOT, 'node_modules/vitest/vitest.mjs'),
  'run',
  ...projects.filter((p) => p !== 'python').flatMap((p) => ['--project', p]),
  '--no-file-parallelism',
  '--maxWorkers=2',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${reportPath}`,
  ...(opts.testNamePattern === null ? [] : [`--testNamePattern=${opts.testNamePattern}`]),
  // Absolute paths: vitest keeps a test file whose path starts with an
  // absolute filter (and whose relative path contains it); the post-run
  // check below catches any extra file such a match would pull in.
  ...tsFiles.map((f) => join(ROOT, f)),
];
say(
  `exec nice(${getPriority()}) node ${loggedVitestArgs(vitestArgs)
    .map((a) => toPosix(relative(ROOT, a)) || a)
    .join(' ')}`,
);

// Retain the stamp sampled at `started`: duration includes Python and the build.
const run = await runGroup(process.execPath, vitestArgs, {
  label: 'run',
  timeoutMs: RUN_TIMEOUT_MS,
  stdio: 'inherit',
  env: { ...process.env, CQ_DIST_PREPARED: '1', NODE_OPTIONS: process.env.NODE_OPTIONS },
});
const durationMs = Date.now() - started;
let report = null;
try {
  const json = JSON.parse(readFileSync(reportPath, 'utf8'));
  report = readReport(json, repoRelative);
  // Opt-in machine evidence for configured checks; does not alter selection,
  // execution or terminal verdicts. The adapter still requires the
  // final wrapper result (including class/run validation).
  if (process.env.CQ_TEST_NARROW_REPORT === '1')
    writeSync(1, `test:narrow report=${JSON.stringify(json)}\n`);
} catch {
  // no report (vitest died early, or never started): counts stay '-'
}
rmSync(reportDir, { recursive: true, force: true });
if (run.error !== undefined) {
  await finish({ result: 'error', exit: 1, reason: `cannot start vitest: ${run.error.message}` });
}
const exit = run.code ?? signalExit(run.signal);
const verdict = runVerdict({
  exit,
  report,
  files: tsFiles,
  timedOut: run.timedOut,
  interruptedBy,
  testNamePattern: opts.testNamePattern,
});
if (report !== null && pythonCounts !== null) {
  report.ran = [...pythonFiles, ...report.ran];
  for (const key of ['total', 'passed', 'failed', 'skipped'])
    report.tests[key] += pythonCounts[key];
}
await finish({ durationMs, ...report, ...verdict });
