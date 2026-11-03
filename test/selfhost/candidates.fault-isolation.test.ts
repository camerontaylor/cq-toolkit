// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this file keeps the fault-isolation subject: per-PR enrichment isolation, the
// loud listing failure, and input validation before any gh call. Shared
// fixtures live in ./candidates.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchMergeCandidates } from '../../src/selfhost/candidates.js';
import { GhError } from '../../src/adapters/forge-github/gh.js';
import { OWNER, REPO, fakeGh, flagValue, pullRow } from './candidates.helpers.js';

// ---------------------------------------------------------------------------
// fetchMergeCandidates
// ---------------------------------------------------------------------------

describe('fetchMergeCandidates', () => {
  test('per-PR fault isolation: a failing enrichment excludes that PR alone, one-line reason', async () => {
    const gh = fakeGh({
      list: () => [pullRow(1), pullRow(2), pullRow(3)],
      fail: (args) =>
        args.some((a) => a.includes('/commits/sha-2')) ||
        (args[0] === 'api' && args[1] === 'graphql' && flagValue(args, 'pr') === '3'),
    });

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.candidates.map((candidate) => candidate.pr)).toEqual([1]);
    expect(result.excluded).toHaveLength(2);
    const commitsFailure = result.excluded.find((row) => row.pr === 2);
    expect(commitsFailure?.reason.startsWith('fetch-failed: gh exit 1: injected gh failure')).toBe(
      true,
    );
    expect(commitsFailure?.reason.includes('stderr continues')).toBe(false); // ONE line only
    const graphqlFailure = result.excluded.find((row) => row.pr === 3);
    expect(graphqlFailure?.reason.startsWith('fetch-failed:')).toBe(true);
  });

  test('a failing listing call throws (never a fabricated empty success)', async () => {
    const gh = fakeGh({ fail: (args) => args.some((a) => a.includes('pulls?state=open')) });

    await expect(fetchMergeCandidates({ gh, owner: OWNER, repo: REPO })).rejects.toThrow(GhError);
  });

  test('owner/repo are validated before any gh call', async () => {
    const calls: string[] = [];
    const gh = fakeGh({}, calls);

    await expect(fetchMergeCandidates({ gh, owner: '../evil', repo: REPO })).rejects.toThrow(
      /owner\/repo must match/,
    );
    expect(calls).toEqual([]);
  });
});
