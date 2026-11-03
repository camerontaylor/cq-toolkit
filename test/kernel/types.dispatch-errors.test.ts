// Split provenance: test/kernel/types.test.ts was split by subject; this file
// holds the dispatch error-class extraction rules. Sibling subjects:
// types.roundtrip.test.ts, types.encoded-couplings.test.ts,
// types.mirror-tightenings.test.ts, types.worker-result-wire.test.ts,
// types.seam.test.ts; shared fixtures live in types.helpers.ts.
import { describe, expect, test } from 'vitest';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';

describe('dispatch error classes (ADR-0002 §2.2 pre-dispatch throws)', () => {
  test('errorClassOf extracts the class from a DispatchError', () => {
    expect(errorClassOf(new DispatchError('config', 'workspace realpath mismatch'))).toBe('config');
    expect(errorClassOf(new DispatchError('auth', 'credentials rejected pre-dispatch'))).toBe(
      'auth',
    );
  });

  test('errorClassOf accepts a plain object tagged with the same field', () => {
    expect(errorClassOf({ dispatchClass: 'config' })).toBe('config');
    expect(errorClassOf({ dispatchClass: 'auth' })).toBe('auth');
  });

  test('errorClassOf returns undefined for untagged or unrecognized throws — never guesses', () => {
    expect(errorClassOf(new Error('plain, untagged'))).toBeUndefined();
    expect(errorClassOf({ dispatchClass: 'fatal' })).toBeUndefined();
    expect(errorClassOf({ class: 'auth' })).toBeUndefined();
    expect(errorClassOf('config')).toBeUndefined();
    expect(errorClassOf(null)).toBeUndefined();
    expect(errorClassOf(undefined)).toBeUndefined();
  });
});
