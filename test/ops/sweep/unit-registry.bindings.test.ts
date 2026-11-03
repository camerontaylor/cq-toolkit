// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// bindingsFromDispatch factory resolution, defaults and literal substitution.
import { describe, expect, test } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { bindingsFromDispatch, DEFAULT_UNIT_PROMPT_TEMPLATE } from '../../../src/ops/sweep/unit.js';
import { FAKE_RESOLVED, fakeFactory, VALID } from './unit-registry.helpers.js';

describe('sweep.unit registry entry (jSKJF)', () => {
  test('bindingsFromDispatch resolves through the factory ONCE and carries the RESOLVED form', () => {
    let resolves = 0;
    const countingFactory: DriverFactory = {
      resolve: () => {
        resolves += 1;
        return FAKE_RESOLVED;
      },
    };
    const bindings = bindingsFromDispatch(VALID, countingFactory);
    // ONE resolve per dispatch (the binder's preferred shape, ADR-0002
    // checklist §2.3), role 'fixer'.
    expect(resolves).toBe(1);
    // The RESOLVED form: the factory's driver and the factory's NORMALISED
    // spec — never the input's raw spec.
    expect(bindings.driver).toBe(FAKE_RESOLVED.driver);
    expect(bindings.modelSpec).toEqual(FAKE_RESOLVED.modelSpec);
    expect(bindings.modelSpec).not.toEqual(VALID.driver);
    // No sessionsDir binding survived the migration: the workspace-bound run
    // creates its fresh record inside the worktree (factory retention).
    expect('sessionsDir' in bindings).toBe(false);
  });

  test('bindingsFromDispatch defaults the push leg ON (push:false opts out)', () => {
    expect(bindingsFromDispatch(VALID, fakeFactory).pushBranch).toBeDefined();
    expect(bindingsFromDispatch({ ...VALID, push: false }, fakeFactory).pushBranch).toBeUndefined();
    // The prompt template: the shipped default, placeholders substituted.
    const bindings = bindingsFromDispatch(VALID, fakeFactory);
    expect(bindings.sandboxPolicy).toEqual({ level: 'workspace-write' });
    expect(() =>
      bindingsFromDispatch({ ...VALID, driver: { ...VALID.driver!, budget: {} } }, fakeFactory),
    ).toThrow(/driver.budget is required/);
    expect(() =>
      bindingsFromDispatch(
        { ...VALID, driver: { ...VALID.driver!, budget: { maxTokens: 1000 } } },
        fakeFactory,
      ),
    ).toThrow(/wallClockMs is required — it is the only cap enforced while the fixer runs/);
    expect(() =>
      bindingsFromDispatch(
        { ...VALID, driver: { ...VALID.driver!, budget: { maxAttempts: 2 } } },
        fakeFactory,
      ),
    ).toThrow(/maxAttempts is not enforceable/);
    const expected = DEFAULT_UNIT_PROMPT_TEMPLATE.replaceAll('{package}', 'alpha')
      .replaceAll('{fixer}', 'fix')
      .replaceAll('{worktree}', '/worktrees/fix/alpha');
    expect(
      bindings.prompt({ package: 'alpha', fixer: 'fix', files: [] }, {
        path: '/worktrees/fix/alpha',
      } as never),
    ).toBe(expected);
  });

  test('placeholder substitution is literal — `$&`/`` $` `` never become replacement tokens (#175 item 7)', () => {
    const bindings = bindingsFromDispatch(
      {
        ...VALID,
        promptTemplate: 'pkg={package} fixer={fixer} wt={worktree}',
      },
      fakeFactory,
    );
    const unit = { package: 'a$&b', fixer: 'f$`g', files: [] };
    // The OLD string-replacer form would turn `$&` into the matched
    // placeholder and `` $` `` into the pre-match text — corrupting the prompt.
    expect(bindings.prompt(unit, { path: '/wt/$&x`y' } as never)).toBe(
      'pkg=a$&b fixer=f$`g wt=/wt/$&x`y',
    );
    // The check-command args use the same literal substitution.
    expect(bindings.checkCommand(unit, '/wt').args).toEqual(['scripts/check.js', 'a$&b']);
  });
});
