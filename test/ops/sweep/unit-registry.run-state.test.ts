// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// run-state namespacing and the dispatch mutex.
import { describe, expect, test } from 'vitest';
import {
  bindingsFromDispatch,
  GUARDED_SECTION_MAX_GIT_CALLS,
  mutexWaiterRetries,
  sweepRunStateDir,
} from '../../../src/ops/sweep/unit.js';
import { fakeFactory, VALID } from './unit-registry.helpers.js';

describe('run-state namespacing and the dispatch mutex (jTPbC / jVgCc)', () => {
  test('run state is namespaced by the sanitized run prefix', () => {
    const one = sweepRunStateDir('/repo', 'worktrees', 'cq/one');
    const two = sweepRunStateDir('/repo', 'worktrees', 'cq/two');
    expect(one).not.toBe(two); // different prefixes → different state dirs
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/one')).toBe(one); // same prefix → same dir (reuse intact)
    // NESTED under worktreesDir as `.cq-state/<prefix>` (one gitignore rule
    // covers the trees AND the state; a dot-prefixed sibling of the kind
    // dirs cannot collide with a derived `<dir>/<kind>/<slug>` tree).
    expect(one).toBe('/repo/worktrees/.cq-state/cq/one');
  });

  test('distinct prefixes that used to fold together get DISTINCT state dirs (#175 item 4)', () => {
    const dot = sweepRunStateDir('/repo', 'worktrees', 'cq/run.one');
    const dash = sweepRunStateDir('/repo', 'worktrees', 'cq/run-one');
    // The old fold mapped both onto `cq/run-one`, so sequential runs
    // overwrote each other's baseline snapshots (fabricated evidence, I7).
    expect(dot).not.toBe(dash);
    expect(dot).toBe('/repo/worktrees/.cq-state/cq/run%2eone');
    // `..` cannot escape the state namespace either.
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/..')).toBe(
      '/repo/worktrees/.cq-state/cq/%2e%2e',
    );
    // An EMPTY segment is reserved: `cq//one` must not collapse onto
    // `cq/one`, and a leading empty segment must not make the namespace
    // ABSOLUTE (which would escape the state dir).
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq//one')).toBe(
      '/repo/worktrees/.cq-state/cq/%empty/one',
    );
    expect(sweepRunStateDir('/repo', 'worktrees', '/one')).toBe(
      '/repo/worktrees/.cq-state/%empty/one',
    );
    // A LITERAL `%2E` segment must not alias the encoded `.`.
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/%2E')).toBe(
      '/repo/worktrees/.cq-state/cq/%252%45',
    );
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/%2E')).not.toBe(
      sweepRunStateDir('/repo', 'worktrees', 'cq/.'),
    );
    // Case-insensitive filesystems: UPPERCASE input is encoded, so `cq/Foo`
    // and `cq/foo` can never share a state dir (r2 minor).
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/Foo')).toBe(
      '/repo/worktrees/.cq-state/cq/%46oo',
    );
    expect(sweepRunStateDir('/repo', 'worktrees', 'cq/Foo')).not.toBe(
      sweepRunStateDir('/repo', 'worktrees', 'cq/foo'),
    );
  });

  test('the dispatch mutex defaults to a repo-level lock; the input overrides', () => {
    const bindings = bindingsFromDispatch(VALID, fakeFactory);
    expect(bindings.mutex).toEqual({
      lockPath: '/repo/.git/cq-git-mutex',
      retries: 16,
    });
    const overridden = bindingsFromDispatch(
      {
        ...VALID,
        mutex: { lockPath: '/locks/custom.lock', staleMs: 5000 },
      },
      fakeFactory,
    );
    expect(overridden.mutex).toEqual({
      lockPath: '/locks/custom.lock',
      staleMs: 5000,
    });
    // The waiter outlasts a live holder that spends the git timeout on EVERY
    // call of the longest guarded section (PR #246 review), not just one.
    expect(GUARDED_SECTION_MAX_GIT_CALLS).toBe(6);
    expect(mutexWaiterRetries(600_000)).toBe(16);
    for (const timeoutMs of [1_000, 30_000, 600_000]) {
      expect(100 * (2 ** mutexWaiterRetries(timeoutMs) - 1)).toBeGreaterThanOrEqual(
        GUARDED_SECTION_MAX_GIT_CALLS * timeoutMs,
      );
    }
    // The crash-recovery floor stands for short timeouts (> the 30s stale window).
    expect(mutexWaiterRetries(1_000)).toBe(9);
    // The resolved segments override rides the bindings (jTPa1).
    const renamed = bindingsFromDispatch({ ...VALID, kind: 'fix', slug: 'a-b-2' }, fakeFactory);
    expect(renamed.segments).toEqual({
      kind: 'fix',
      slug: 'a-b-2',
      branch: 'cq/09-16a/fix/a-b-2',
    });
  });
});
