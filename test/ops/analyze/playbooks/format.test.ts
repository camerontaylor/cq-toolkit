// Analyze lane G3 — test evidence for the authored-playbook format: the
// strict schema accepts the full asset and only it (unknown keys rejected
// at every level), the id pattern holds (start alphanumeric, safe charset,
// 64-char bound — uniqueness is the REGISTRY's job, not the schema's), the
// rule must be a non-empty JSON OBJECT with finite JSON values (engine
// semantics are validated at dispatch, not here), and the verifier command
// mirrors the gates CheckCommand shape (optional cwd/timeoutMs — no
// default; an explicit undefined is not a value).
import { describe, expect, test } from 'vitest';
import {
  PLAYBOOK_ID_PATTERN,
  PLAYBOOK_SCHEMA_VERSION,
  PlaybookSchema,
} from '../../../../src/ops/analyze/playbooks/format.js';

/** A minimal valid playbook (the tests mutate one field at a time). */
const VALID = {
  schemaVersion: 1,
  id: 'fix-foo-bar',
  description: 'rename foo_bar to fooBar at every match',
  rule: { id: 'fix-foo-bar', language: 'ts', rule: { pattern: 'foo_bar' }, fix: 'fooBar' },
  verifier: { command: { command: 'npm', args: ['test'] } },
};

describe('PlaybookSchema (the authored format, full input and only it)', () => {
  test('parses the full valid playbook unchanged', () => {
    expect(PlaybookSchema.parse(VALID)).toEqual(VALID);
  });

  test('the schema version constant is 1 and only the literal parses', () => {
    expect(PLAYBOOK_SCHEMA_VERSION).toBe(1);
    expect(PlaybookSchema.safeParse({ ...VALID, schemaVersion: 2 }).success).toBe(false);
  });

  test('the id pattern: valid ids pass, hostile ones fail', () => {
    expect(PLAYBOOK_ID_PATTERN.test('a')).toBe(true);
    expect(PLAYBOOK_ID_PATTERN.test('fix-foo_bar.7')).toBe(true);
    expect(PLAYBOOK_ID_PATTERN.test('7fix')).toBe(true);
    expect('x'.repeat(64)).toMatch(PLAYBOOK_ID_PATTERN);
    // Must start alphanumeric; no whitespace, slashes, or separators.
    expect(PLAYBOOK_ID_PATTERN.test('-fix')).toBe(false);
    expect(PLAYBOOK_ID_PATTERN.test('.fix')).toBe(false);
    expect(PLAYBOOK_ID_PATTERN.test('fix bar')).toBe(false);
    expect(PLAYBOOK_ID_PATTERN.test('fix/bar')).toBe(false);
    expect(PLAYBOOK_ID_PATTERN.test('')).toBe(false);
    expect('x'.repeat(65)).not.toMatch(PLAYBOOK_ID_PATTERN);
    for (const bad of ['-fix', '', 'fix bar']) {
      expect(PlaybookSchema.safeParse({ ...VALID, id: bad }).success).toBe(false);
    }
  });

  test('the rule: a non-empty JSON object; arrays, empties, and non-JSON values fail', () => {
    expect(PlaybookSchema.safeParse({ ...VALID, rule: {} }).success).toBe(false);
    expect(PlaybookSchema.safeParse({ ...VALID, rule: [] }).success).toBe(false);
    expect(PlaybookSchema.safeParse({ ...VALID, rule: 'id: r' }).success).toBe(false);
    // Non-finite numbers are not JSON — a rule carrying them would
    // stringify losslessly-false at dispatch time.
    expect(PlaybookSchema.safeParse({ ...VALID, rule: { n: Number.NaN } }).success).toBe(false);
    // Nested structure and JSON nulls are the rule's business — accepted.
    expect(PlaybookSchema.safeParse({ ...VALID, rule: { a: { b: [1, null, 'x'] } } }).success).toBe(
      true,
    );
  });

  test('the verifier command: the gates CheckCommand shape, optional fields stay optional', () => {
    expect(PlaybookSchema.parse(VALID).verifier.command.args).toEqual(['test']);
    const withAll = {
      ...VALID,
      verifier: {
        command: { command: 'npm', args: ['test'], cwd: 'ws', timeoutMs: 60_000 },
      },
    };
    expect(PlaybookSchema.parse(withAll)).toEqual(withAll);
    expect(
      PlaybookSchema.safeParse({ ...VALID, verifier: { command: { command: '' } } }).success,
    ).toBe(false);
    expect(
      PlaybookSchema.safeParse({ ...VALID, verifier: { command: { command: 'npm', args: 'x' } } })
        .success,
    ).toBe(false);
    // The command carries the REQUIRED args, so the schema reaches the
    // timeout rule: 0 (and a negative) are rejected by .positive(), not by
    // a missing-field rejection earlier in the object.
    expect(
      PlaybookSchema.safeParse({
        ...VALID,
        verifier: { command: { command: 'npm', args: [], timeoutMs: 0 } },
      }).success,
    ).toBe(false);
    expect(
      PlaybookSchema.safeParse({
        ...VALID,
        verifier: { command: { command: 'npm', args: [], timeoutMs: -5_000 } },
      }).success,
    ).toBe(false);
    // An explicit undefined is NOT a value (exactOptional, like the frozen type).
    expect(
      PlaybookSchema.safeParse({
        ...VALID,
        verifier: { command: { command: 'npm', args: [], cwd: undefined } },
      }).success,
    ).toBe(false);
  });

  test('strict: unknown keys fail loudly at every level', () => {
    expect(PlaybookSchema.safeParse({ ...VALID, rulePath: 'r.yml' }).success).toBe(false);
    expect(
      PlaybookSchema.safeParse({
        ...VALID,
        verifier: { command: VALID.verifier.command, cache: 1 },
      }).success,
    ).toBe(false);
    expect(PlaybookSchema.safeParse({ ...VALID, description: '' }).success).toBe(false);
    expect(PlaybookSchema.safeParse({ ...VALID, description: 'x'.repeat(2001) }).success).toBe(
      false,
    );
  });
});
