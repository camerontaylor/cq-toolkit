// Split provenance: test/driver/factory.test.ts was split by subject; this
// file keeps the resolved-shape and resolve-time request-gate subject. The
// suite-wide header and shared fixtures live in ./factory.helpers.ts.
import { describe, expect, test } from 'vitest';
import { createDriverFactory } from '../../src/driver/factory.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { scratch, subprocessConfig } from './factory.helpers.js';

describe('driver factory — resolved shape', () => {
  test('resolve() is synchronous and returns the lane plus a runnable driver', () => {
    const factory = createDriverFactory();
    const resolved = factory.resolve({ role: 'fixer', modelSpec: { provider: 'zai', model: 'm' } });
    expect(resolved).not.toBeInstanceOf(Promise); // resolve is sync — construction throws, never rejects
    expect(resolved.lane).toBe('ai-sdk');
    expect(resolved.driver.run).toBeTypeOf('function');
  });
});

test('a scoped request scanner refuses lanes without the pre-send hook', async () => {
  const root = await scratch();
  const factory = createDriverFactory(subprocessConfig(root, []));
  let thrown: unknown;
  try {
    factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'construction', model: 'construction-model' },
      beforeRequest: async () => {},
    });
  } catch (err) {
    thrown = err;
  }
  // Pre-dispatch misconfiguration is a STRUCTURED 'config' throw, never a
  // plain Error that errorClassOf cannot classify.
  expect(thrown).toBeInstanceOf(DispatchError);
  expect(errorClassOf(thrown)).toBe('config');
  expect((thrown as Error).message).toContain('upload scanning requires the ai-sdk request gate');
  expect((thrown as Error).message).toContain("lane 'claude-code'");
});
