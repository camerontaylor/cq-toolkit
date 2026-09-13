// THROWAWAY: replaced by ops/ratchet in phase 2 (H4)
// Placeholder typecheck ratchet: counts `error TS\d+:` lines from the pinned
// compiler and compares them to baselines/typecheck.json. Thresholds only
// tighten — never raise a baseline to go green (that is not a ratchet). A
// missing baseline, or a nonzero exit whose output has NO parsable error
// lines (missing node_modules, compiler panic, rejected flag), is
// non-passing evidence, never a pass (invariant I5): the tool's output is
// echoed and we exit 1 before counting. A counted run — including an
// errored typecheck with parsable lines — may be persisted with --update.
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

// Invoke tsc6 — the bin OWNED by the pinned alias (typescript =
// npm:@typescript/typescript6, which declares exactly tsc6). The sibling
// .bin/tsc belongs to the floating `@typescript/old: npm:typescript@^6`
// transitive INSIDE that alias, so invoking it would certify evidence with
// whatever ^6 happens to resolve to on a fresh install (an I5 violation).
// On win32 the .cmd shim must be spawned through a shell: since Node's
// CVE-2024-27980 fix, spawning a .cmd/.bat without shell:true throws EINVAL.
const TSC_BIN = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc6.cmd' : 'tsc6');
const res = spawnSync(TSC_BIN, ['--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], {
  cwd: ROOT,
  encoding: 'utf8',
  shell: process.platform === 'win32',
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
  // Safe on any counted run (the unparsable-nonzero guard above already
  // failed those): tsc exits 1 whenever errors remain, so refusing nonzero
  // exits would make a lowered-but-nonzero baseline impossible to persist.
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
