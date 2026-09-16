import { expect } from 'vitest';

// Vitest asymmetric matchers are expectation data, never typed application
// values. Contain their `any` return at this boundary and expose only unknown.
export const match = {
  stringMatching: (value: string | RegExp): unknown => expect.stringMatching(value),
  stringContaining: (value: string): unknown => expect.stringContaining(value),
  any: (value: unknown): unknown => expect.any(value),
  objectContaining: (value: Record<string, unknown>): unknown => expect.objectContaining(value),
};
