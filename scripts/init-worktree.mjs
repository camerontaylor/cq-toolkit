#!/usr/bin/env node
// Make a fresh git worktree of this repo ready to work in: install dependencies.
//
// Paseo runs this as `worktree.setup` (paseo.json) for every worktree it creates; run it by hand
// (`node scripts/init-worktree.mjs`) in a worktree made with plain `git worktree add`. It is
// idempotent, so re-running it in a ready worktree is a no-op install.
//
// pnpm-workspace.yaml enables the global virtual store, so on a host whose store is warm the
// install is a symlink pass, not a download. Nothing else is needed: the repo has no env files to
// link (provider keys come from the host environment, never the checkout), apps/crq-python is
// stdlib-only, and `pnpm test:narrow` builds dist itself when a selected test needs it.
//
// Automatic setup skips dependency lifecycle scripts and pnpm hooks: the checkout may be
// untrusted while the host environment contains credentials. This means native addons such as
// fs-ext are not built by setup. In a trusted checkout, run pnpm rebuild fs-ext if needed.
//
// Node rather than shell because Paseo lifecycle commands run through a non-login script shell;
// see Paseo docs/development.md "paseo.json service scripts".
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

console.log(`init-worktree: ${repoRoot}`);

const install = spawnSync(
  'pnpm',
  ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  },
);

if (install.error) {
  console.error(`init-worktree: could not run pnpm (${install.error.message}).`);
  console.error('Install pnpm (mise or corepack) so it is on PATH, then re-run this script.');
  process.exit(1);
}
if (install.status !== 0) {
  console.error(`init-worktree: pnpm install exited ${install.status ?? install.signal}.`);
  process.exit(install.status ?? 1);
}

console.log('init-worktree: ready.');
