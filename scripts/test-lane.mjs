// `npm run test:unit` / `npm run test:e2e`: run one lane of the suite, with
// membership derived from the process-entry inventory (scripts/lib/
// test-lanes.mjs). Extra arguments pass through to `vitest run`; vitest ORs
// positional filters, so a filter narrows `unit` but only widens `e2e`.
import { laneArgs } from './lib/test-lanes.mjs';
import { ROOT, run } from './lib/owned-files.mjs';

const [lane, ...rest] = process.argv.slice(2);
try {
  process.exitCode = run('node_modules/vitest/vitest.mjs', [
    'run',
    ...laneArgs(lane, ROOT),
    ...rest,
  ]);
} catch (error) {
  console.error(`test-lane: ${error.message}`);
  process.exitCode = 1;
}
