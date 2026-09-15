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
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
