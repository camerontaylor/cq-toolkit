// The honest lanes (plan 003 F3): `test:unit` and `test:e2e` are derived
// from the process-entry inventory (scripts/lib/test-lanes.mjs). CI runs
// both lanes in place of `npm run test`, so they must be DISJOINT and their
// UNION must be every file vitest discovers — or a test silently stops
// running (or runs twice). Pure: reads files, launches nothing.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import config from '../../vitest.config.js';
import {
  allTestFiles,
  documentedProcessTestFiles,
  laneArgs,
  laneFiles,
  TEST_EXCLUDE,
} from '../../scripts/lib/test-lanes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('test lanes', () => {
  test('unit and e2e are disjoint and together cover every discovered test file', () => {
    const { unit, e2e } = laneFiles(ROOT);
    expect(unit.filter((file) => e2e.includes(file))).toEqual([]);
    expect([...unit, ...e2e].sort()).toEqual(allTestFiles(ROOT));
    expect(e2e).toEqual(documentedProcessTestFiles(ROOT));
  });

  test('the lane CLI args select exactly the lane members under vitest semantics', () => {
    const all = allTestFiles(ROOT);
    const { unit, e2e } = laneFiles(ROOT);
    // unit: vitest appends each --exclude to its ignore globs, so discovery
    // under those globs must be exactly the unit lane (an inventory path with
    // glob metacharacters, e.g. `[1]`, would also exclude a sibling here).
    const unitArgs = laneArgs('unit', ROOT);
    const excluded = unitArgs.filter((_, index) => unitArgs[index - 1] === '--exclude');
    expect(unitArgs.filter((arg) => arg === '--exclude')).toHaveLength(excluded.length);
    expect(excluded).toEqual(e2e);
    expect(allTestFiles(ROOT, excluded)).toEqual(unit);
    // e2e: vitest matches a filter as a case-insensitive path SUBSTRING —
    // each filter must select exactly its own file, never a sibling.
    const filters = laneArgs('e2e', ROOT);
    const selects = (filter: string) => (file: string) =>
      file.toLowerCase().includes(filter.toLowerCase());
    for (const filter of filters) expect(all.filter(selects(filter))).toEqual([filter]);
    expect(all.filter((file) => filters.some((filter) => selects(filter)(file)))).toEqual(e2e);
    expect(() => laneArgs('everything', ROOT)).toThrow(/unknown test lane 'everything'/);
  });

  test('the discovery model matches vitest.config.ts (default include, pinned exclude)', () => {
    expect(config.test?.include).toBeUndefined();
    expect(config.test?.exclude).toEqual(TEST_EXCLUDE);
  });

  test('package.json runs the lanes through the derived selection; test runs everything', () => {
    const scripts = (
      JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['test']).toBe('vitest run');
    expect(scripts['test:unit']).toBe('node scripts/test-lane.mjs unit');
    expect(scripts['test:e2e']).toBe('node scripts/test-lane.mjs e2e');
  });
});
