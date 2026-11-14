import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LocalReviewNotReady,
  prepareLocalReview,
  type LocalReviewPrepareEffects,
} from '../../../src/ops/crq/internal/localReviewPrepare.js';
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
    completeFromCycle: async (queue) => queue,
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
      completeFromCycle: async (_queue, run, _cls, at) => {
        completed = `${run}:${at}`;
        return doc('{"items":[],"updated":true}');
      },
    });
    expect(result.plan).toBeNull();
    expect(result.queue.get('updated')).toBe(true);
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
    expect(plan.plan?.get('base')).toBe('base');
  });
  it('skips empty historical profiles and empty live runs', async () => {
    const queue = doc(
      `{"items":[{"kind":"open","repo":"a/b","cycles":[${record.replace('"profile":{"adapter":"coderabbit-cli","revision":"v1","flags":[]}', '"profile":{}')}],"run":{}}]}`,
    );
    const result = await prepareLocalReview(queue, item, 'a/b', false, false, effects());
    expect(result.plan?.get('base')).toBe('base');
  });
  it('refuses invalid or mismatched pinned facts', async () => {
    const queue = doc('{"items":[]}');
    await expect(
      prepareLocalReview(queue, item, 'a/b', false, false, {
        ...effects(),
        validateIdentity: () => {
          throw new Error('invalid');
        },
      }),
    ).rejects.toThrow('pinned-local-review-facts-mismatch');
    await expect(
      prepareLocalReview(queue, item, 'a/b', false, false, {
        ...effects(),
        resolveFacts: async () => doc('{}'),
      }),
    ).rejects.toThrow('pinned-local-review-facts-mismatch');
  });
  it('skips non-counted evidence and does not classify or mutate during dry reuse', async () => {
    const queue = doc(`{"items":[{"kind":"open","repo":"a/b","cycles":[${record}]}]}`);
    let calls = 0;
    const fx = {
      ...effects(),
      classifyCompleted: async () => {
        calls++;
        return doc('{"counted":false,"outcome":"error"}');
      },
    };
    expect((await prepareLocalReview(queue, item, 'a/b', false, false, fx)).plan?.get('base')).toBe(
      'base',
    );
    expect((await prepareLocalReview(queue, item, 'a/b', true, false, fx)).plan).toBeNull();
    expect(calls).toBe(1);
  });
  it('forces implicit repeated generations and uses the clock for a missing completion time', async () => {
    const queue = doc(
      `{"items":[{"kind":"open","repo":"a/b","cycles":[${record.replace(',"completed_at":"then"', '')}]}]}`,
    );
    const repeated = doc(
      '{"identity_inputs":{"repo":"a/b","base_commit":"base","head_commit":"head","scope":"full-diff","projection":"full-diff","config_digest":"digest","profile":{"adapter":"coderabbit-cli","revision":"v1"}},"profile":{"adapter":"coderabbit-cli","revision":"v1","flags":[]},"generation":2}',
    );
    expect(
      (await prepareLocalReview(queue, repeated, 'a/b', false, false, effects())).plan?.get('base'),
    ).toBe('base');
    let timestamp = '';
    const result = await prepareLocalReview(queue, item, 'a/b', false, false, {
      ...effects(),
      completeFromCycle: async (q, _run, _cls, at) => {
        timestamp = at;
        return q;
      },
    });
    expect(result.plan).toBeNull();
    expect(timestamp).toBe('now');
  });
});
