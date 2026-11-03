// Split provenance: test/driver/factory.test.ts was split by subject; this
// file keeps the default/configured/wildcard binding resolution subject. The
// suite-wide header and shared fixtures live in ./factory.helpers.ts.
import { describe, expect, test } from 'vitest';
import { createDriverFactory } from '../../src/driver/factory.js';
import { probe } from './factory.helpers.js';

describe('driver factory — resolution', () => {
  test.each(['zai', 'anthropic', 'openai', 'deepseek', 'opencode-go'])(
    'default bindings: %s resolves ANY role to the ai-sdk lane',
    async (provider) => {
      const factory = createDriverFactory();
      for (const role of [
        'fixer',
        'conflict-resolver',
        'remediator',
        'classifier',
        'deploy-role',
      ]) {
        const resolved = factory.resolve({ role, modelSpec: { provider, model: 'm' } });
        expect(resolved.lane).toBe('ai-sdk');
        expect(resolved.modelSpec).toEqual({ provider, model: 'm' });
      }
      // The resolved driver IS the ai-sdk lane (class-named pre-dispatch throw).
      await probe(
        factory.resolve({ role: 'fixer', modelSpec: { provider, model: 'm' } }).driver,
        /ai-sdk driver: unknown provider/,
      );
    },
  );

  test('a configured binding wins over the default; unconfigured roles keep it', async () => {
    const factory = createDriverFactory({ bindings: { fixer: { zai: 'claude-code' } } });
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'zai', model: 'glm-4.6' },
    });
    expect(resolved.lane).toBe('claude-code');
    await probe(resolved.driver, /claude-code driver: unknown provider/); // the CLI transport's router ran
    expect(
      factory.resolve({ role: 'classifier', modelSpec: { provider: 'zai', model: 'glm-4.6' } })
        .lane,
    ).toBe('ai-sdk');
  });

  test("the '*' wildcard binds every provider for its role", async () => {
    const factory = createDriverFactory({ bindings: { classifier: { '*': 'claude-code' } } });
    for (const provider of ['zai', 'openai', 'anything-at-all']) {
      const resolved = factory.resolve({
        role: 'classifier',
        modelSpec: { provider, model: 'm' },
      });
      expect(resolved.lane).toBe('claude-code');
    }
    await probe(
      factory.resolve({ role: 'classifier', modelSpec: { provider: 'zai', model: 'm' } }).driver,
      /claude-code driver: unknown provider/,
    );
  });
});
