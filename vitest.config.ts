// Vitest 5's default test discovery does not exclude build output, so a
// local `npm run build` before `npm run test` would re-run the stale
// compiled tests under dist/ (CI orders test before build, local runs may
// not). Extend the shipped defaults (node_modules, .git, ...) with dist
// instead of replacing them, so built-in exclusions stay active.
//
// Coverage (H4 ratchet runner): provider v8 (the peer-pinned
// @vitest/coverage-v8), with `json-summary` so `npx vitest run --coverage`
// writes coverage/coverage-summary.json — the file the ratchet's coverage
// adapter reads `total.lines.pct` from (normalized to INTEGER percent by
// scripts/ratchet-lib.mjs: 2-decimal float noise across runners is
// sub-granularity and must never decide a ratchet) — plus `text` for the
// human-readable table. Opt-in per run via --coverage; plain `vitest run` is
// unchanged.
//
// Projects (execution-policy slice 2, component D): every test/**/*.test.ts
// is classified in test/suite-classes.json as pure | process | integration |
// live. The projects below derive their file lists from that manifest, so
// the classification is auditable and a file absent from the manifest falls
// into `process` (conservative: real-process budgets, serial; this includes
// the lint/rules RuleTester suites). The process-backed projects carry
// distinct `sequence.groupOrder`s (process 1, live 2, integration 3) so a
// bare run keeps the old root-level global serialization: same-order
// projects run concurrently, different orders run one after another.
// Selection:
//   npm run test:unit == --project pure --project process --project live
//   npm run test:e2e  == --project integration
// Coverage and reporters stay ROOT-level (they are absent from the
// per-project options), so the ratchet's bare `vitest run --coverage` still
// runs every project and writes one coverage/coverage-summary.json.
import { existsSync, readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

type SuiteClass = 'pure' | 'process' | 'integration' | 'live';

const manifest = JSON.parse(
  readFileSync(new URL('./test/suite-classes.json', import.meta.url), 'utf8'),
) as Record<string, SuiteClass>;
const filesOf = (cls: SuiteClass): string[] =>
  Object.entries(manifest)
    .filter(([, c]) => c === cls)
    .map(([file]) => file);

for (const file of Object.keys(manifest)) {
  // Drift is loud: a stale manifest entry would silently shrink a project.
  if (!existsSync(new URL(`./${file}`, import.meta.url))) {
    throw new Error(`test/suite-classes.json lists a missing file: ${file}`);
  }
}

const classified = [...filesOf('pure'), ...filesOf('integration'), ...filesOf('live')];

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
    projects: [
      {
        // No process, git, network or env/cwd mutation; own tmp dirs only.
        // fileParallelism stays false: the parallel-safety gate (3 green
        // parallel runs + 1 shuffled run of this project) was NOT executed
        // because testing was waived by the owner for this change. Enabling
        // it later means `fileParallelism: true` plus a distinct
        // `sequence.groupOrder` (projects with different worker counts must
        // not share one, and groups run one after another — so a parallel
        // pure group saves at most its own wall time, ~4% ceiling:
        // opportunistic, never a metric).
        extends: true,
        test: {
          name: 'pure',
          include: filesOf('pure'),
          testTimeout: 5_000,
          fileParallelism: false,
        },
      },
      {
        // Real child processes (git, the fake agent CLI, node subprocesses)
        // with genuine startup/termination deadlines: serial files so
        // competing fixtures do not consume those budgets. Also the home of
        // every unclassified file.
        extends: true,
        test: {
          name: 'process',
          sequence: { groupOrder: 1 },
          include: ['test/**/*.test.ts', 'lint/**/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/dist/**', ...classified],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        // Opt-in live-service legs (skipped unless their env flag is set);
        // same budgets as process, which they drive for real.
        extends: true,
        test: {
          name: 'live',
          sequence: { groupOrder: 2 },
          include: filesOf('live'),
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        // Today's `test:e2e` selection. Budgets are pinned to the vitest
        // defaults these files already run under (5s/10s) — they carry their
        // own explicit per-test timeouts, which the project must not shrink
        // or raise.
        extends: true,
        test: {
          name: 'integration',
          sequence: { groupOrder: 3 },
          include: filesOf('integration'),
          testTimeout: 5_000,
          hookTimeout: 10_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      // ALL source files count (review-debt #117): without include, the
      // v8 provider reports only files LOADED during the run — a PR adding
      // a completely untested module never lowered coverage, so the
      // ratchet could not see it.
      include: ['src/**'],
      exclude: ['src/**/*.md', '**/*.prompt'],
    },
  },
});
