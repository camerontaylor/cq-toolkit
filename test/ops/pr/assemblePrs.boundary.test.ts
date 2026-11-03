// Split provenance: test/ops/pr/assemblePrs.test.ts was split by subject;
// this file holds the boundary-validation tests (bad inputs are `failed`
// results naming the field, before any gh call). Shared fixtures live in
// assemblePrs.helpers.ts.
import { afterAll, describe, expect, test } from 'vitest';
import type { AssemblePrsInput } from '../../../src/ops/pr/assemblePrs.js';
import {
  PKG_CORE,
  PKG_UTIL,
  TRACKER_BRANCH,
  cleanupRepoRoot,
  failedAt,
  fakeGh,
  inputOf,
  makeAssemblePrs,
  okReport,
} from './assemblePrs.helpers.js';

afterAll(cleanupRepoRoot);

// ---------------------------------------------------------------------------
// Boundary validation — `failed` naming the field
// ---------------------------------------------------------------------------

describe('boundary validation refuses bad inputs before any gh call', () => {
  test.each(['cq/09-16a/core.', 'cq/09-16a/core./fix'])(
    'refuses trailing-dot branch components: %s',
    async (branch) => {
      const fake = fakeGh();
      expect(
        await failedAt(
          makeAssemblePrs(fake.gh),
          inputOf({
            packages: [{ name: 'core', branch, title: 'fix' }],
          }),
        ),
      ).toContain('packages[0].branch');
      expect(fake.calls).toEqual([]);
    },
  );

  test('refuses a trailing-dot run prefix before any gh call', async () => {
    const fake = fakeGh();
    expect(await failedAt(makeAssemblePrs(fake.gh), inputOf({ runPrefix: 'cq/run.' }))).toContain(
      'runPrefix',
    );
    expect(fake.calls).toEqual([]);
  });

  test('a package branch outside the run prefix is refused naming the entry', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'core', branch: 'feature/core', title: 'core fixes' }] }),
    );
    expect(error).toContain('packages[0].branch');
    expect(error).toContain("must start with the run prefix 'cq/09-16a/'");
    expect(fake.calls).toEqual([]);
  });

  test('the tracker branch outside the run prefix is refused naming the field', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ tracker: { title: 't', branch: 'elsewhere/tracker' } }),
    );
    expect(error).toContain('tracker.branch');
    expect(fake.calls).toEqual([]);
  });

  test('a branch segment that impersonates a git flag is refused', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'core', branch: 'cq/09-16a/-exec', title: 'x' }] }),
    );
    expect(error).toContain('packages[0].branch');
    expect(fake.calls).toEqual([]);
  });

  test('a whitespace-only package title, a non-boolean draft, and a non-object input are refused', async () => {
    const op = makeAssemblePrs(fakeGh().gh);
    const titleResult = await op(
      inputOf({ packages: [{ name: 'c', branch: PKG_CORE, title: '   ' }] }),
    );
    expect(titleResult.status).toBe('failed');
    expect(titleResult.status === 'failed' && titleResult.error).toContain('packages[0].title');
    const draftResult = await op(inputOf({ draft: 'yes' as unknown as boolean }));
    expect(draftResult.status).toBe('failed');
    expect(draftResult.status === 'failed' && draftResult.error).toContain('draft');
    const nullResult = await op(null as unknown as AssemblePrsInput);
    expect(nullResult.status).toBe('failed');
    expect(nullResult.status === 'failed' && nullResult.error).toContain('input must be an object');
  });

  test('a control character in a string fed to gh is refused', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ tracker: { title: 'fleet\nrun', branch: TRACKER_BRANCH } }),
    );
    expect(error).toContain('tracker.title');
    expect(fake.calls).toEqual([]);
  });

  test('a control character in a package NAME is refused (it feeds the tracker markdown)', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'core\n---', branch: PKG_CORE, title: 'x' }] }),
    );
    expect(error).toContain('packages[0].name');
    expect(error).toContain('control characters');
    expect(fake.calls).toEqual([]);
  });

  test('two packages sharing a branch are refused, naming both entries', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({
        packages: [
          { name: 'core', branch: PKG_CORE, title: 'core fixes' },
          { name: 'core-two', branch: PKG_CORE, title: 'another core PR' },
        ],
      }),
    );
    expect(error).toContain('packages[0] and packages[1]');
    expect(error).toContain(PKG_CORE);
    expect(fake.calls).toEqual([]);
  });

  test('a package on the tracker’s own branch is refused', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'core', branch: TRACKER_BRANCH, title: 'x' }] }),
    );
    expect(error).toContain('packages[0].branch');
    expect(error).toContain("is the tracker's own branch");
    expect(fake.calls).toEqual([]);
  });

  test('every search is base-threaded — the PR identity is head AND base', async () => {
    // PR-165 r1#2: a PR from an earlier run against a DIFFERENT base must
    // never be adopted as this fleet's member, so the op passes its own
    // base on every search.
    const fake = fakeGh();
    await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(fake.searches).toEqual([
      { head: TRACKER_BRANCH, base: 'origin/merge-queue' },
      { head: PKG_CORE, base: 'origin/merge-queue' },
      { head: PKG_UTIL, base: 'origin/merge-queue' },
    ]);
  });
});
