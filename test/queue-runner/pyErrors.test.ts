import { describe, expect, it } from 'vitest';
import { PyError, isPyError } from '../../src/queue-runner/pyErrors.js';

describe('isPyError OSError subclasses', () => {
  for (const kind of [
    'FileNotFoundError',
    'IsADirectoryError',
    'FileExistsError',
    'NotADirectoryError',
  ] as const) {
    it(`${kind} is an OSError`, () => {
      expect(isPyError(new PyError(kind, 'x'), 'OSError')).toBe(true);
    });
  }
  it('a ValueError is not an OSError', () => {
    expect(isPyError(new PyError('UnicodeDecodeError', 'x'), 'OSError')).toBe(false);
  });
});
