import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LocalReviewNotReady,
  prepareLocalReview,
  type LocalReviewPrepareEffects,
} from '../../../src/ops/crq/localReviewPrepare.js';
function doc(text: string): JsonObject {
  const value = parseJsonValue(text);
  if (!(value instanceof JsonObject)) throw new Error('object expected');
  return value;
}
const identity = doc(
  '{"repo":"a/b","base_commit":"base","head_commit":"head","scope":"full-diff","projection":"full-diff","config_digest":"digest","profile":{"adapter":"coderabbit-cli","revision":"v1"}}',
);
const item = doc(
  '{"identity_inputs":{"repo":"a/b","base_commit":"base","head_commit":"head","scope":"full-diff","projection":"full-diff","config_digest":"digest","profile":{"adapter":"coderabbit-cli","revision":"v1"}},"profile":{"adapter":"coderabbit-cli","revision":"v1","flags":[]},"generation":1}',
);
const record =
  '{"base":"base","head":"head","range_policy":"full-range-once-v1","profile":{"adapter":"coderabbit-cli","revision":"v1","flags":[]},"run_id":"old","ndjson":"runs/old/review.ndjson","completed_at":"then"}';
function effects(): LocalReviewPrepareEffects {
  return {
    ensureObjects: async () => {},
    resolveFacts: async () => identity,
    validateIdentity: () => {},
    readRunMeta: async () => doc(record),
    classifyCompleted: async () => doc('{"counted":true,"outcome":"completed"}'),
    completeFromCycle: async () => {},
    nowIso: () => 'now',
  };
}
describe('local review preparation', () => {
  it('reuses an equivalent completed Python cycle without a new plan', async () => {
    const queue = doc(`{"items":[{"kind":"open","repo":"a/b","cycles":[${record}]}]}`);
    let completed = '';
    const fx = effects();
    const result = await prepareLocalReview(queue, item, 'a/b', false, false, {
      ...fx,
      completeFromCycle: async (run, _cls, at) => {
        completed = `${run}:${at}`;
      },
    });
    expect(result).toBeNull();
    expect(completed).toBe('old:then');
  });
  it('forces repeat and refuses an equivalent live PR run', async () => {
    const repeated = doc(
      '{"identity_inputs":{"repo":"a/b","base_commit":"base","head_commit":"head","scope":"full-diff","projection":"full-diff","config_digest":"digest","profile":{"adapter":"coderabbit-cli","revision":"v1"}},"profile":{"adapter":"coderabbit-cli","revision":"v1","flags":[]},"generation":1,"repeat_requested":true}',
    );
    const queue = doc(
      `{"items":[{"kind":"open","repo":"a/b","cycles":[${record}],"run":{"run_id":"old"}}]}`,
    );
    await expect(
      prepareLocalReview(queue, repeated, 'a/b', false, false, effects()),
    ).rejects.toThrow(LocalReviewNotReady);
    const plan = await prepareLocalReview(queue, repeated, 'a/b', false, true, effects());
    expect(plan?.get('base')).toBe('base');
  });
});
