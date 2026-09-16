// Vitest 5's default test discovery does not exclude build output, so a
// local `npm run build` before `npm run test` would re-run the stale
// compiled tests under dist/ (CI orders test before build, local runs may
// not). Extend the shipped defaults (node_modules, .git, ...) with dist
// instead of replacing them, so built-in exclusions stay active.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Process-backed suites have real startup and termination deadlines.
    // Run files serially so competing fixtures do not consume those budgets.
    fileParallelism: false,
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
