import { describe, expect, test } from 'vitest';
import { deepFreeze } from '../../src/shared/deepFreeze.js';

describe('deepFreeze', () => {
  test('traverses a shallow-frozen parent and freezes nested objects and arrays', () => {
    const child = { enabled: true };
    const value = Object.freeze({ nested: [child] });
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
    expect(() => {
      child.enabled = false;
    }).toThrow();
  });

  test.each([false, true])('handles cycles with an initially frozen root: %s', (frozen) => {
    const value: { self?: unknown; child: { enabled: boolean } } = {
      child: { enabled: true },
    };
    value.self = value;
    if (frozen) Object.freeze(value);
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.child)).toBe(true);
  });

  test('handles mutual cycles and shared children', () => {
    const child: { parent?: unknown } = {};
    const value = { first: child, second: child };
    child.parent = value;
    deepFreeze(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
  });

  test.each([null, undefined, true, 42, 'value'])('preserves primitive %s', (value) => {
    expect(deepFreeze(value)).toBe(value);
  });
});
