// Split provenance: test/driver/strict-token-budget-guard.test.ts was split by subject;
// this file keeps the supported ai-sdk lane unchanged by the guard. Shared
// fixtures live in ./strict-token-budget-guard.helpers.ts.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import {
  FAKE_CAPABILITY,
  invocation,
  scratch,
  textResult,
} from './strict-token-budget-guard.helpers.js';

// ---------------------------------------------------------------------------
// 4. Supported lane (ai-sdk) unchanged
// ---------------------------------------------------------------------------

describe('ai-sdk lane is unchanged by the guard', () => {
  test('ai-sdk lane with an injected capability keeps enforcing the strict budget', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const driver = new AiSdkDriver({
        sessionsDir,
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult() }),
        },
        strictTokenCapability: () => FAKE_CAPABILITY,
      });
      const result = await driver.run(invocation({ provider: 'anthropic', model: 'claude-test' }));
      expect(result.stopReason).toBe('complete');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('default factory (ai-sdk) without a capability still refuses with the ai-sdk message', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const factory = createDriverFactory({
        sessionsDir,
        lanes: {
          aiSdk: {
            providers: {
              anthropic: () =>
                new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult() }),
            },
          },
        },
      });
      const resolved = factory.resolve({
        role: 'fixer',
        modelSpec: { provider: 'anthropic', model: 'claude-test' },
      });
      expect(resolved.lane).toBe('ai-sdk');
      const err = await resolved.driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain('no trusted token capability');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
