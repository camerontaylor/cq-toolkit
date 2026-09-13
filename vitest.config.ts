// Vitest 5's default test discovery does not exclude build output, so a
// local `npm run build` before `npm run test` would re-run the stale
// compiled tests under dist/ (CI orders test before build, local runs may
// not). Extend the shipped defaults (node_modules, .git, ...) with dist
// instead of replacing them, so built-in exclusions stay active.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
