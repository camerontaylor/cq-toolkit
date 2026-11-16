import { describe, expect, it } from 'vitest';
import { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { localReviewFactsEffects } from '../../../src/adapters/crq/localReviewFacts.js';

describe('legacy review facts binding', () => {
  it('resolves both trees before calling the existing identity resolver', async () => {
    const calls: string[][] = [];
    let received: JsonObject | undefined;
    const effects = localReviewFactsEffects({
      historyGit:
        () =>
        async (...args: string[]) => {
          calls.push(args);
          return Buffer.from(args[1] === 'base^{tree}' ? 'tree-base\n' : 'tree-head\n');
        },
      resolveIdentity: async (_repo, inputs) => {
        received = inputs;
        return inputs;
      },
    });
    await effects.resolveFacts('a/b', 'base', 'head', new JsonObject([]));
    expect(calls).toEqual([
      ['rev-parse', 'base^{tree}'],
      ['rev-parse', 'head^{tree}'],
    ]);
    expect(received?.get('base_tree')).toBe('tree-base');
    expect(received?.get('head_tree')).toBe('tree-head');
  });
});
