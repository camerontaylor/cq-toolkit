// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// task-worker harness cwd binding.
import { expect, test } from 'vitest';
import { bindingsFromDispatch } from '../../../src/ops/sweep/unit.js';
import { FAKE_RESOLVED, fakeFactory, VALID } from './unit-registry.helpers.js';

test('task worker carries nested check cwd into its exact-command harness', () => {
  const configurations: unknown[] = [];
  const bindings = bindingsFromDispatch(
    { ...VALID, check: { ...VALID.check!, cwd: 'packages/demo' }, taskLoop: {} },
    {
      resolve: (config) => {
        configurations.push(config.harness);
        return FAKE_RESOLVED;
      },
    },
  );
  bindings.taskWorker?.(
    { id: 'a', files: ['packages/demo/a.ts'], failures: [] },
    { command: 'node', args: ['scripts/check.cjs'], cwd: '/repo/packages/demo' },
  );
  expect(configurations.at(-1)).toMatchObject({
    tools: {
      bash: { defaultCwd: 'packages/demo', commandPatterns: ['re:^node scripts/check\\.cjs$'] },
    },
  });
  expect(() =>
    bindingsFromDispatch(
      { ...VALID, check: { ...VALID.check!, cwd: '../outside' }, taskLoop: {} },
      fakeFactory,
    ),
  ).toThrow('inside the unit workspace');
});
