// THROWAWAY: replaced by ops/ratchet in phase 2 (H4)
// Placeholder typecheck ratchet: counts `error TS` lines from tsc --noEmit
// and compares them to baselines/typecheck.json. Thresholds only tighten —
// never raise a baseline to go green (that is not a ratchet). A missing
// baseline is non-passing evidence, never a pass (invariant I5). Lock a
// lowered count in with --update.
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

const res = spawnSync('npx', ['--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (res.error || res.status === null) {
  fail(`cannot run tsc: ${res.error ? res.error.message : `signal ${res.signal}`}`);
}
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
const count = output.split(/\r?\n/).filter((line) => /error TS/.test(line)).length;

if (process.argv.includes('--update')) {
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
if (count > baseline) fail(`${count} error TS line(s) exceed baseline ${baseline}; thresholds only tighten — fix the errors, do not raise the baseline`);
console.log(`ratchet-typecheck: ${count} <= baseline ${baseline}${count < baseline ? ' (tighten with --update)' : ''}`);
