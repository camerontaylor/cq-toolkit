#!/usr/bin/env node
// affected-tests — advisory per-PR test selection (policy/templates/
// affected-tests.md; I4: a reduced-selection run is ADVISORY and never a
// required check — the unfiltered suite stays the required check).
//
// Usage:
//   node scripts/affected-tests.mjs [--base <ref>] [--json] [<changed-file>...]
//   files=$(node scripts/affected-tests.mjs --base origin/merge-queue)
//   [ -z "$files" ] || npx vitest run $files   # empty = nothing to run; a bare
//                                              # `vitest run` would be the FULL suite
//
// With no explicit files, the changed set is `git diff --name-only <base>...HEAD`
// (default base origin/merge-queue). Output: one test file per line, or with
// --json {"files":[...],"fallback":bool,"reason":"..."}. Selection = the static
// import graph (vitest's `getRelevantTestSpecifications` with `related` set —
// the query behind `vitest related`, minus running the tests; the `list`
// command has no `--related` flag) ∪ the reviewed
// non-import map in scripts/lib/affected-tests.mjs; unknown impact — or a failed
// import-graph query — falls back to EVERY unit test file (the whole suite).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createVitest } from 'vitest/node';
import { selectAffected } from './lib/affected-tests.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const baseAt = argv.indexOf('--base');
const base = baseAt === -1 ? 'origin/merge-queue' : argv[baseAt + 1];
if (base === undefined || base.startsWith('--')) {
  process.stderr.write('affected-tests: --base requires a ref\n');
  process.exit(2);
}
const explicit = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--base');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const changed =
  explicit.length > 0
    ? explicit
    : run('git', ['diff', '--name-only', '-z', `${base}...HEAD`])
        .split('\0')
        .filter(Boolean);

// Classified files plus every discovered test absent from the manifest: those
// run in the conservative `process` project (vitest.config.ts), so a PR that
// adds an unclassified suite must still select it.
const discovered = ['test', 'lint']
  .flatMap((dir) => readdirSync(dir, { recursive: true }).map((f) => `${dir}/${f}`))
  .filter((f) => f.endsWith('.test.ts'));
const allTests = [
  ...new Set([
    ...Object.keys(JSON.parse(readFileSync('test/suite-classes.json', 'utf8'))),
    ...discovered,
  ]),
].filter((file) => !file.startsWith('test/e2e/') && file !== 'test/driver/acp.test.ts');

let related = [];
const sources = changed.filter((f) => /^(src|scripts)\//.test(f) && /\.(ts|mts|js|mjs)$/.test(f));
if (sources.length > 0) {
  try {
    const vitest = await createVitest('test', { related: sources, watch: false, run: true });
    try {
      const specs = await vitest.getRelevantTestSpecifications();
      related = specs.map((spec) => relative(process.cwd(), spec.moduleId));
    } finally {
      await vitest.close();
    }
  } catch {
    related = null;
  }
}

const result = selectAffected({ changed, allTests, related });
process.stdout.write(
  json ? `${JSON.stringify(result)}\n` : result.files.map((f) => `${f}\n`).join(''),
);
