// The test lanes, derived from the committed process-entry inventory (plan
// 003 F3). `test:unit` is every test file NOT in the inventory — the
// process-free lane; `test:e2e` is exactly the inventory — every file that
// launches a real process. test/driver/process-inventory.test.ts keeps the
// documented list equal to the known-entry-point scan, and
// test/scripts/test-lanes.test.ts proves the lanes are disjoint and cover
// every test file.
import { globSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { configDefaults } from 'vitest/config';

/**
 * Vitest's discovery for this repo: the default include, and the default
 * exclude plus build output — vitest.config.ts's `exclude`, which
 * test/scripts/test-lanes.test.ts pins to this value.
 */
export const TEST_EXCLUDE = [...configDefaults.exclude, '**/dist/**'];

/** Where the inventory lives: the list under this heading. */
export const INVENTORY_DOC = 'docs/test-performance-notes.md';
const INVENTORY_HEADING = '## Process-entry inventory';

/** The documented process-backed test files (repo-relative, posix, sorted). */
export function documentedProcessTestFiles(root) {
  const docs = readFileSync(join(root, INVENTORY_DOC), 'utf8');
  const section = docs.split(INVENTORY_HEADING)[1]?.split(/^## /m)[0] ?? '';
  const files = [...section.matchAll(/^- `([^`]+\.test\.ts)`$/gm)].map((match) => match[1]);
  if (files.length === 0) throw new Error('Process-entry inventory section is empty');
  return files.sort();
}

/** Every test file vitest discovers (repo-relative, posix, sorted). */
export function allTestFiles(root) {
  return globSync(configDefaults.include, { cwd: root, exclude: TEST_EXCLUDE })
    .map((file) => file.split(sep).join('/'))
    .sort();
}

/** The two lanes' members: unit = all − inventory, e2e = inventory. */
export function laneFiles(root) {
  const inventory = documentedProcessTestFiles(root);
  const listed = new Set(inventory);
  return { unit: allTestFiles(root).filter((file) => !listed.has(file)), e2e: inventory };
}

/**
 * The vitest CLI arguments selecting a lane: the unit lane EXCLUDES every
 * inventory file (exact paths, as globs); the e2e lane passes them as
 * filters (vitest matches a filter as a path substring).
 */
export function laneArgs(lane, root) {
  const inventory = documentedProcessTestFiles(root);
  if (lane === 'unit') return inventory.flatMap((file) => ['--exclude', file]);
  if (lane === 'e2e') return inventory;
  throw new Error(`unknown test lane '${String(lane)}' (expected unit or e2e)`);
}
