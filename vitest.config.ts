// Vitest 5's default test discovery does not exclude build output, so a
// local `npm run build` before `npm run test` would re-run the stale
// compiled tests under dist/ (CI orders test before build, local runs may
// not). Keep discovery to sources only.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
