/**
 * Shared reader for the `process()`-helpers oracle fixture
 * (apps/crq-python/fixtures/crq-process-helpers/cases.json, emitted by
 * apps/crq-python/repair_process_helpers_vectors.py from the PRODUCTION
 * Python) and the message-comparison rule both differential tests use.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

import {
  JsonNumber,
  parseJsonValue,
  pythonNonFinite,
  toPlainJsonRetainingNumbers,
} from '../../src/policy/crq/jsonValue.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';

const FIXTURE = fileURLToPath(
  new URL('../../apps/crq-python/fixtures/crq-process-helpers/cases.json', import.meta.url),
);

export interface Recorded {
  readonly name: string;
  readonly result?: unknown;
  readonly raises?: string;
  readonly message?: string;
  readonly is_value_error?: boolean;
  readonly [key: string]: unknown;
}

export interface Fixture {
  readonly schema: string;
  readonly default_ref: string;
  readonly job: string;
  readonly failure_class: readonly unknown[];
  readonly judge_required: readonly unknown[];
  readonly revalidation: readonly unknown[];
  readonly verify: readonly unknown[];
  readonly retain: readonly unknown[];
  readonly nested: readonly unknown[];
}

/** The fixture as plain values; numbers stay `JsonNumber` (int/float kinds). */
export function loadFixture(): Fixture {
  const text = readFileSync(FIXTURE, 'utf8');
  return toPlainJsonRetainingNumbers(
    parseJsonValue(text, { parseConstant: pythonNonFinite }),
  ) as Fixture;
}

/** Plain-number view of a retained value, for comparing recorded results. */
export function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      entry instanceof JsonNumber
        ? entry.kind === 'int'
          ? Number(entry.integer)
          : entry.float
        : entry,
    ),
  );
}

/**
 * Run `call` and assert it ended as Python did: the same exception class, the
 * message where the code under test authored it (`ValueError`, `KeyError`,
 * `UnsupportedUntracked`, and the `git <sub> failed:` prefix of
 * `RuntimeError`), or the same result.
 */
export function expectSameOutcome(
  call: () => unknown,
  expected: Recorded,
  mapResult: (value: unknown) => unknown = (value) => value,
): void {
  let actual: unknown;
  let thrown: unknown;
  try {
    actual = call();
  } catch (e) {
    thrown = e;
  }
  if (expected.raises !== undefined) {
    expect(thrown, `${expected.name}: expected ${expected.raises}`).toBeInstanceOf(PyError);
    const kind = (thrown as PyError).kind;
    if (expected.raises === 'UnicodeDecodeError') {
      expect(kind, expected.name).toBe('ValueError');
      return;
    }
    expect(kind, expected.name).toBe(expected.raises);
    const message = (thrown as PyError).message;
    if (expected.raises === 'RuntimeError') {
      expect(message.split(' failed: ')[0] + ' failed: ', expected.name).toBe(expected.message);
    } else if (expected.message !== undefined) {
      expect(message, expected.name).toBe(expected.message);
    }
    return;
  }
  expect(thrown, `${expected.name}: unexpected ${String(thrown)}`).toBeUndefined();
  expect(plain(mapResult(actual)), expected.name).toEqual(plain(expected.result));
}
