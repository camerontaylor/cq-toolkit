// fetchReviewState unit tests — input validation: the owner/repo charset
// (including "." and ".." dot segments) and the pr positive-safe-integer
// guard, both refused before any fetch.
// Split provenance: test/ops/review/fetchReviewState.test.ts was split by
// subject into fetchReviewState.{pagination,caps,lag,inputValidation,
// wireMapping,slurpShapes,failClosed}.test.ts; the injected gh seam and
// payload builders live in fetchReviewState.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchReviewState } from '../../../src/adapters/forge-github/fetchReviewState.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';

describe('fetchReviewState', () => {
  test('rejects an owner/repo that does not match ^[A-Za-z0-9_.-]+$', async () => {
    const run: GhFn = async () => ({ code: 0, stdout: '[]', stderr: '' });
    await expect(
      fetchReviewState({ owner: 'octo/x', repo: 'widget', pr: 7 }, {}, run),
    ).rejects.toThrow(/owner\/repo must match/);
    await expect(
      fetchReviewState({ owner: 'octo', repo: '../escape', pr: 7 }, {}, run),
    ).rejects.toThrow(/owner\/repo must match/);
    // DOT SEGMENTS: "." and ".." pass the charset but ride into the request
    // path as relative segments — rejected like any other bad spelling.
    await expect(fetchReviewState({ owner: '.', repo: 'widget', pr: 7 }, {}, run)).rejects.toThrow(
      /owner\/repo must match/,
    );
    await expect(fetchReviewState({ owner: 'octo', repo: '..', pr: 7 }, {}, run)).rejects.toThrow(
      /owner\/repo must match/,
    );
  });

  test('rejects a pr that is not a positive safe integer (string-pr JS callers included)', async () => {
    const run: GhFn = async () => ({ code: 0, stdout: '[]', stderr: '' });
    // A JS caller (or JSON.parse'd data) can smuggle a string past the type.
    const stringPr = '7?per_page=1#' as unknown as number;
    await expect(
      fetchReviewState({ owner: 'octo', repo: 'widget', pr: stringPr }, {}, run),
    ).rejects.toThrow(/pr must be a positive safe integer/);
    await expect(
      fetchReviewState({ owner: 'octo', repo: 'widget', pr: 0 }, {}, run),
    ).rejects.toThrow(/pr must be a positive safe integer/);
    await expect(
      fetchReviewState({ owner: 'octo', repo: 'widget', pr: -3 }, {}, run),
    ).rejects.toThrow(/pr must be a positive safe integer/);
  });
});
