import { expect, test } from 'vitest';
import { FixRunInputSchema } from '../../../src/ops/fix/registry.js';
import { SweepUnitDispatchInputSchema } from '../../../src/ops/sweep/registry.js';

test('fix.run defaults to local gated work and requires an explicit selector', () => {
  const input = { repoRoot: '/fixture', source: 'tests', selector: { mode: 'workspace-all' } };
  expect(FixRunInputSchema.parse(input)).toMatchObject({
    push: false,
    pushFailed: false,
    pr: false,
    proposeOnly: false,
    protectTests: false,
    concurrency: 1,
  });
  expect(FixRunInputSchema.safeParse({ ...input, selector: undefined }).success).toBe(false);
  expect(FixRunInputSchema.safeParse({ ...input, maxTokens: 0 }).success).toBe(false);
  expect(FixRunInputSchema.safeParse({ ...input, unexpected: true }).success).toBe(false);
  expect(FixRunInputSchema.parse({ ...input, pushFailed: true }).pushFailed).toBe(true);
});
test('sweep rejects invalid related argv before dispatch', () => {
  const input = {
    repoRoot: '/fixture',
    runPrefix: 'cq/run',
    base: 'HEAD',
    package: 'fixture',
    fixer: 'test',
    files: [],
    taskLoop: { relatedArgs: ['embedded-{files}'] },
  };
  expect(SweepUnitDispatchInputSchema.safeParse(input).success).toBe(false);
});
