// THROWAWAY: replaced by ops/ratchet in phase 2 (H4)
// Placeholder typecheck ratchet: counts `error TS\d+:` lines from a clean,
// exit-0 tsc run and compares them to baselines/typecheck.json. Thresholds
// only tighten — never raise a baseline to go green (that is not a ratchet).
// A missing baseline, or ANY nonzero tsc exit (missing node_modules, panic,
// rejected flag), is non-passing evidence, never a pass (invariant I5): the
// tool's output is echoed and we exit 1 before counting. --update is only
// honored on a clean run. Lock a lowered count in with --update.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'baselines/typecheck.json');
const fail = (message) => {
  console.error(`ratchet-typecheck: ${message}`);
  process.exit(1);
};

// Invoke the repo-local tsc binary directly: `npx --no-install tsc` falls
// through to $PATH when the local bin is missing, so a broken node_modules
// plus a global tsc would silently run an unpinned compiler and could
// certify a bogus 0 (the exact I5 violation this gate exists to prevent).
const TSC_BIN = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const res = spawnSync(TSC_BIN, ['--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (res.error || res.status === null) {
  fail(`cannot run tsc: ${res.error ? res.error.message : `signal ${res.signal}`}`);
}
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
const errorLines = output.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line));
const count = errorLines.length;
// Only a run whose errors are parsable may be counted (I5): a nonzero exit
// with NO `error TS` lines (npx missing-package text, a compiler panic, a
// rejected flag) must never certify 0 errors — echo the tool output and
// fail. A nonzero exit WITH error lines is a normal errored typecheck; it
// is counted and judged against the baseline below.
if (res.status !== 0 && count === 0) {
  fail(`tsc exited ${res.status} with no parsable error lines — tool output follows:\n${output.trim()}`);
}

if (process.argv.includes('--update')) {
  if (res.status !== 0) fail('refusing --update: tsc did not exit 0');
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `{"count": ${count}}\n`);
  console.log(`ratchet-typecheck: baseline updated to ${count}`);
  process.exit(0);
}

let baseline;
try {
  ({ count: baseline } = JSON.parse(readFileSync(BASELINE, 'utf8')));
} catch (e) {
  fail(`missing baseline ${BASELINE} (invariant I5: a missing metrics summary is non-passing evidence, never a pass; create it with --update) [${e.code ?? e.message}]`);
}
if (typeof baseline !== 'number') fail('baseline typecheck.json has no numeric "count"');
if (count > baseline) {
  fail(`${count} error TS line(s) exceed baseline ${baseline}; thresholds only tighten — fix the errors, do not raise the baseline. Errors:\n${errorLines.join('\n')}`);
}
console.log(`ratchet-typecheck: ${count} <= baseline ${baseline}${count < baseline ? ' (tighten with --update)' : ''}`);
