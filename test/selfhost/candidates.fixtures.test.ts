// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this file keeps the fixture-compatibility subject. Shared fixtures live in
// ./candidates.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchReviewState } from '../../src/adapters/forge-github/fetchReviewState.js';
import {
  OWNER,
  REPO,
  fakeGh,
  graphqlPayload,
  reviewNode,
  threadNode,
} from './candidates.helpers.js';

// Keep the direct-import guard honest: fetchReviewState is reachable only
// through the candidates module; this assertion pins that the fake's
// graphql shapes (./candidates.helpers.ts) stay compatible with the real
// consumer's document.
describe('fixture compatibility', () => {
  test('the test graphql fixtures satisfy the real fetchReviewState', async () => {
    const pr = 7;
    const gh = fakeGh({
      graphql: () => graphqlPayload(pr, [threadNode('T1')], [reviewNode('R1')]),
    });
    const state = await fetchReviewState({ owner: OWNER, repo: REPO, pr }, undefined, gh);
    expect(state.truncated).toBe(false);
    expect(state.threads.map((thread) => thread.id)).toEqual(['T1']);
  });
});
