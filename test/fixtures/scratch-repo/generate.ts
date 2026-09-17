// Scratch fixture repo generator — the D4 e2e's offline, deterministic
// two-package workspace (goal D4). NOT a committed repo: the e2e calls
// generateScratchRepo into a fresh tmpdir per test, which git-inits, seeds
// the two packages, and commits — the D1-family real-git idioms (auto-
// maintenance suppression + bounded retries) copied from
// test/ops/sweep/worktreeFor.test.ts.
//
// THE SEED (the D4 acceptance shape):
//   - packages/alpha — a FAILING suite (sum(1, 1) is 2, the suite expects 3)
//     whose failure the fake fixer can flip to passing by one edit;
//   - packages/beta — a PASSING suite a correct fixer must leave untouched.
// Every package carries a `test/suite.test.js` plain-node script; the probe
// check (`scripts/check.js <pkg>`) runs it and reports failures in the
// tsc-lines wire format (`path(line,col): error TS0000: message`), exit 1 on
// any failure, 0 on clean. Failure coordinates are FIXTURE-STABLE (4,9) —
// the seeded throw's line is part of the deterministic fingerprint.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The seeded alpha failure message — stable across every probe of any run. */
export const ALPHA_FAILURE_MESSAGE = 'expected 3, got 2';

/** The one edit that fixes alpha's seeded failure (the fake fixer's contract). */
export const ALPHA_FIX = {
  file: 'packages/alpha/test/suite.test.js',
  oldText: 'if (sum(1, 1) !== 3) {',
  newText: 'if (sum(1, 1) !== 2) {',
} as const;

/**
 * The one edit that BREAKS beta's passing suite (the dirty-tree scenario):
 * it shifts beta's expectation constant, so the broken suite's assertion AND
 * its thrown message move together — the failure text stays internally
 * consistent with the assertion that produced it.
 */
export const BETA_BREAK = {
  file: 'packages/beta/test/suite.test.js',
  oldText: 'const expected = 4;',
  newText: 'const expected = 5;',
} as const;

/**
 * The beta failure message a breaking edit produces (novel vs its clean
 * baseline): the assertion then expects 5 while sum(2, 2) computes 4.
 */
export const BETA_BREAK_MESSAGE = 'expected 5, got 4';

/** The workspace manifest the e2e sweeps — two packages, git's own path form. */
export const SCRATCH_PACKAGES: Array<{ name: string; path: string }> = [
  { name: 'alpha', path: 'packages/alpha' },
  { name: 'beta', path: 'packages/beta' },
];

/** Each package's known file-set (the planner's packageFiles input). */
export const SCRATCH_PACKAGE_FILES: Record<string, string[]> = {
  alpha: ['packages/alpha/test/suite.test.js'],
  beta: ['packages/beta/test/suite.test.js'],
};

const ALPHA_SUITE = [
  "'use strict';",
  '// alpha: seeded failure — sum(1, 1) is 2, the suite expects 3. The fake',
  '// fixer flips the expectation to 2 and the suite passes.',
  'const sum = (a, b) => a + b;',
  'if (sum(1, 1) !== 3) {',
  "  throw new Error('expected 3, got ' + sum(1, 1));",
  '}',
  '',
].join('\n');

const BETA_SUITE = [
  "'use strict';",
  '// beta: passing suite — a correct fixer leaves this file untouched. The',
  '// expectation lives on its OWN line so the breaking edit shifts the',
  '// assertion and its message together (consistent failure text).',
  'const sum = (a, b) => a + b;',
  'const expected = 4;',
  'if (sum(2, 2) !== expected) {',
  "  throw new Error('expected ' + expected + ', got ' + sum(2, 2));",
  '}',
  '',
].join('\n');

/**
 * The probe check: `node scripts/check.js <pkg>` — runs that package's
 * suite, reports each failure as one tsc-lines diagnostic at the
 * fixture-stable coordinates (4,9), exits 1 on any failure / 0 clean.
 */
const CHECK_SCRIPT = [
  "'use strict';",
  '// Probe check for one scratch package (argv[2]): plain node, offline.',
  "const path = require('node:path');",
  'const pkg = process.argv[2];',
  "const suite = path.join('packages', pkg, 'test', 'suite.test.js');",
  'try {',
  '  require(path.resolve(suite));',
  '  process.exit(0);',
  '} catch (err) {',
  "  const message = String(err && err.message ? err.message : err).split('\\n')[0];",
  "  process.stdout.write(suite + '(4,9): error TS0000: ' + message + '\\n');",
  '  process.exit(1);',
  '}',
  '',
].join('\n');

const ROOT_PACKAGE_JSON = `${JSON.stringify(
  { name: 'scratch-repo', private: true, version: '1.0.0' },
  null,
  2,
)}\n`;

const GITIGNORE = 'worktrees/\n';
// NOTE: no '.cq/' (or any tool-state) entry ON PURPOSE — the unit op must
// write its baseline snapshots OUTSIDE the worktree (the run-state dir). A
// gitignore entry here would mask a regression to in-tree state, and the
// strict-clean/reuse/salvage assertions would not catch it.

const PKG_JSON = (name: string): string =>
  `${JSON.stringify({ name, version: '1.0.0', private: true }, null, 2)}\n`;

/** Beta's seeded package.json content — the rename-side allowlist test renames it verbatim. */
export const BETA_PACKAGE_JSON = PKG_JSON('beta');

// Auto-maintenance suppression, VERBATIM from the worktreeFor test idiom:
// a commit's detached background `gc --auto` inheriting these pipes hangs
// the callback past git's own exit.
const GIT_NO_AUTO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

const GIT_CALL_TIMEOUT_MS = 6_000;
const GIT_CALL_ATTEMPTS = 4;

/** One bounded git call (the worktreeFor.test.ts real-git idiom). */
function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_NO_AUTO_MAINTENANCE, ...args],
      { cwd, timeout: GIT_CALL_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Bounded retry around the git calls — a stalled spawn is retried, never an assertion relaxed. */
async function resilient<T>(step: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= GIT_CALL_ATTEMPTS; attempt++) {
    try {
      return await step();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * Generate the scratch repo at `root` (created recursively): the two
 * packages, the probe check, the ignore rules, then git init -b main +
 * one seed commit. Deterministic content; runs offline.
 */
export async function generateScratchRepo(root: string): Promise<void> {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), ROOT_PACKAGE_JSON);
  writeFileSync(join(root, '.gitignore'), GITIGNORE);
  writeFileSync(join(root, 'scripts', 'check.js'), CHECK_SCRIPT);
  for (const pkg of SCRATCH_PACKAGES) {
    mkdirSync(join(root, pkg.path, 'test'), { recursive: true });
    writeFileSync(join(root, pkg.path, 'package.json'), PKG_JSON(pkg.name));
    writeFileSync(
      join(root, pkg.path, 'test', 'suite.test.js'),
      pkg.name === 'alpha' ? ALPHA_SUITE : BETA_SUITE,
    );
  }
  await resilient(() => run(['init', '-q', '-b', 'main', root], root));
  await resilient(() => run(['-C', root, 'config', 'user.email', 'e2e@example.invalid'], root));
  await resilient(() => run(['-C', root, 'config', 'user.name', 'D4 e2e'], root));
  await resilient(() => run(['-C', root, 'config', 'commit.gpgsign', 'false'], root));
  await resilient(() => run(['-C', root, 'add', '-A'], root));
  await resilient(() =>
    run(['-C', root, 'commit', '-q', '-m', 'seed: scratch fixture repo'], root),
  );
}
