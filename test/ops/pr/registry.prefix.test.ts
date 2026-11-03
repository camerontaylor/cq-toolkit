// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the run-prefix refinement pins.
import { describe, expect, test } from 'vitest';
import { assembleInput, entryByName, firstPackageOf, reportInput } from './registry.helpers.js';

// ---------------------------------------------------------------------------
// The prefix refinements (UC row 22's fleet namespace at the JSON boundary)
// ---------------------------------------------------------------------------

describe('the run-prefix refinements', () => {
  test('a tracker branch outside the run prefix fails schema validation', () => {
    const input = assembleInput();
    (input['tracker'] as Record<string, unknown>).branch = 'elsewhere/tracker';
    const parsed = entryByName('pr.assemblePrs').inputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toContain(
      "tracker.branch must start with '<runPrefix>/'",
    );
  });

  test('a package branch outside the run prefix fails schema validation', () => {
    const input = assembleInput();
    firstPackageOf(input).branch = 'feature/core';
    const parsed = entryByName('pr.assemblePrs').inputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toContain(
      "every packages[].branch must start with '<runPrefix>/'",
    );
  });

  test('a prefix-matching fleet passes both refinements', () => {
    const input = assembleInput();
    (input['packages'] as Array<Record<string, unknown>>).push({
      name: 'util',
      branch: 'cq/09-16a/fix/util',
      title: 'util fixes',
    });
    expect(entryByName('pr.assemblePrs').inputSchema.safeParse(input).success).toBe(true);
  });

  test('runReport: a zero, negative, or non-integer PR number is refused at the boundary', () => {
    const schema = entryByName('pr.runReport').inputSchema;
    for (const bad of [0, -3, 1.5]) {
      const input = reportInput();
      firstPackageOf(input).number = bad;
      expect(schema.safeParse(input).success).toBe(false);
    }
    const trackerInput = reportInput();
    (trackerInput['tracker'] as Record<string, unknown>).number = 0;
    expect(schema.safeParse(trackerInput).success).toBe(false);
  });
});
