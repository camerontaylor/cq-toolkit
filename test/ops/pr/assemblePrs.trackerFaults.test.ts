// Split provenance: test/ops/pr/assemblePrs.test.ts was split by subject;
// this file holds the tracker fault tests (a tracker search, create or
// manifest-edit fault fails the whole op before any package PR). Shared
// fixtures live in assemblePrs.helpers.ts.
import { afterAll, describe, expect, test } from 'vitest';
import {
  PKG_CORE,
  PKG_UTIL,
  TRACKER_BRANCH,
  cleanupRepoRoot,
  failedAt,
  fakeGh,
  inputOf,
  makeAssemblePrs,
} from './assemblePrs.helpers.js';

afterAll(cleanupRepoRoot);

// ---------------------------------------------------------------------------
// Fail before any package PR exists
// ---------------------------------------------------------------------------

describe('a tracker fault fails the whole op before any package PR', () => {
  test('a tracker SEARCH fault → failed, zero package searches or creates', async () => {
    const fake = fakeGh();
    fake.gh.searchPrByHead = async (head) => {
      fake.calls.push(`search:${head}`);
      throw new Error('gh api rate-limited');
    };
    const error = await failedAt(makeAssemblePrs(fake.gh), inputOf());
    expect(error).toContain('tracker-first failed');
    expect(error).toContain('rate-limited');
    expect(fake.calls).toEqual([`search:${TRACKER_BRANCH}`]);
  });

  test('a tracker CREATE fault → failed, zero package searches or creates', async () => {
    const fake = fakeGh();
    fake.gh.createPr = async (request) => {
      fake.calls.push(`create:${request.head}`);
      throw new Error('draft PRs disabled on this repo');
    };
    const error = await failedAt(makeAssemblePrs(fake.gh), inputOf());
    expect(error).toContain('tracker-first failed');
    expect(fake.calls).toEqual([`search:${TRACKER_BRANCH}`, `create:${TRACKER_BRANCH}`]);
  });

  test('a tracker MANIFEST-EDIT fault → failed, naming the package PRs already ensured', async () => {
    const fake = fakeGh();
    fake.gh.editPrBody = async (number) => {
      fake.calls.push(`edit:${String(number)}`);
      throw new Error('edit refused');
    };
    const error = await failedAt(makeAssemblePrs(fake.gh), inputOf());
    expect(error).toContain('could not update tracker PR #101');
    expect(error).toContain('#102'); // the second package PR was already created
    expect(fake.calls).toEqual([
      `search:${TRACKER_BRANCH}`,
      `create:${TRACKER_BRANCH}`,
      `search:${PKG_CORE}`,
      `create:${PKG_CORE}`,
      `search:${PKG_UTIL}`,
      `create:${PKG_UTIL}`,
      'edit:101',
    ]);
  });
});
