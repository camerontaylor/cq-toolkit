// Gates lane C3 — test evidence for the commit gate: the full decision
// table (valid message, missing/non-conventional subject, each required
// trailer missing, value-shape violations, Outcome outside oneOf, the
// subject↔Outcome implication table both ways, trailing-paragraph
// discipline) plus config genericity (custom trailers REPLACE the shipped
// taxonomy, custom subject pattern, requireSubject off, custom outcome
// trailer) and status discipline (ok:false is still a `status:'ok'` op;
// only an uncompilable regex is `failed`). All pure — zero I/O.
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_COMMIT_IMPLICATIONS,
  DEFAULT_COMMIT_TRAILERS,
  commitGate,
} from '../../../src/ops/gates/commitGate.js';
import type { CommitGateConfig } from '../../../src/ops/gates/commitGate.js';

/** A full commit message: subject, body paragraph, trailing trailer block. */
function messageOf(subject: string, trailers: string[], body: string[] = []): string {
  return [subject, '', ...body, '', ...trailers].join('\n');
}

/** The shipped-shape valid message: conventional subject, complete trailers. */
const VALID = messageOf(
  'fix(test): cache eviction kept stale entries past their TTL',
  [
    'Confidence: 0.92',
    'Tested: npm run test -- test/ops/cache.test.ts',
    'Outcome: broken-test',
  ],
  ['The eviction branch compared the wrong clock, so entries survived expiry.'],
);

describe('commitGate decision table', () => {
  test('a fully conventional message passes with zero violations', async () => {
    const result = await commitGate({ message: VALID });
    expect(result).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('an empty message violates the subject and every required trailer, still status ok', async () => {
    const result = await commitGate({ message: '' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.ok).toBe(false);
    expect(result.value.violations.map((v) => v.rule)).toEqual([
      'subject',
      'Confidence',
      'Tested',
      'Outcome',
    ]);
  });

  test('a non-conventional subject is a subject violation even with complete trailers', async () => {
    const result = await commitGate({
      message: messageOf('updated the cache logic', [
        'Confidence: 0.92',
        'Tested: vitest',
        'Outcome: code-bug',
      ]),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations).toEqual([
      {
        rule: 'subject',
        message: 'subject does not match the required subject pattern',
        evidence: 'updated the cache logic',
      },
      {
        rule: 'code-bug',
        message: '"Outcome: code-bug" requires a subject matching ^fix(\\(|:)',
        evidence: 'updated the cache logic',
      },
    ]);
  });

  test('a missing required Confidence trailer is a violation named "Confidence"', async () => {
    const result = await commitGate({
      message: messageOf('fix(test): drop the flaky case', ['Tested: vitest', 'Outcome: todo']),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations).toContainEqual({
      rule: 'Confidence',
      message: 'required trailer "Confidence" is missing',
      evidence: '',
    });
  });

  test('a missing required Tested trailer is a violation named "Tested"', async () => {
    const result = await commitGate({
      message: messageOf('fix(test): drop the flaky case', ['Confidence: 0.9', 'Outcome: todo']),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations).toContainEqual({
      rule: 'Tested',
      message: 'required trailer "Tested" is missing',
      evidence: '',
    });
  });

  test('a missing required Outcome trailer is a violation named "Outcome"', async () => {
    const result = await commitGate({
      message: messageOf('fix(test): drop the flaky case', ['Confidence: 0.9', 'Tested: vitest']),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations).toContainEqual({
      rule: 'Outcome',
      message: 'required trailer "Outcome" is missing',
      evidence: '',
    });
  });

  test('a non-numeric Confidence value ("high") violates the Confidence pattern, with evidence', async () => {
    const result = await commitGate({
      message: messageOf('fix(test): drop the flaky case', [
        'Confidence: high',
        'Tested: vitest',
        'Outcome: code-bug',
      ]),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations).toEqual([
      {
        rule: 'Confidence',
        message: '"Confidence" value does not match the required pattern',
        evidence: 'Confidence: high',
      },
    ]);
  });

  test('an Outcome outside oneOf violates the Outcome rule', async () => {
    const result = await commitGate({
      message: messageOf('fix(test): drop the flaky case', [
        'Confidence: 0.9',
        'Tested: vitest',
        'Outcome: shipping',
      ]),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations).toEqual([
      {
        rule: 'Outcome',
        message: '"Outcome" value is not one of the allowed values (broken-test, code-bug, todo)',
        evidence: 'Outcome: shipping',
      },
    ]);
  });
});

describe('commitGate subject↔Outcome implications', () => {
  test('Outcome: broken-test with subject fix(app): … is a violation named "broken-test"', async () => {
    const result = await commitGate({
      message: messageOf('fix(app): cache eviction kept stale entries', [
        'Confidence: 0.92',
        'Tested: vitest',
        'Outcome: broken-test',
      ]),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.ok).toBe(false);
    expect(result.value.violations).toEqual([
      {
        rule: 'broken-test',
        message: '"Outcome: broken-test" requires a subject matching ^fix\\(test\\):',
        evidence: 'fix(app): cache eviction kept stale entries',
      },
    ]);
  });

  test('Outcome: broken-test with subject fix(test): … passes', async () => {
    const result = await commitGate({ message: VALID });
    expect(result).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('Outcome: todo with a chore(test): todo subject passes', async () => {
    const result = await commitGate({
      message: messageOf('chore(test): todo: retire the flaky eviction case', [
        'Confidence: 0.7',
        'Tested: vitest',
        'Outcome: todo',
      ]),
    });
    expect(result).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('Outcome: code-bug with any fix(…) subject passes', async () => {
    const result = await commitGate({
      message: messageOf('fix(parser): handle an empty config object', [
        'Confidence: 0.95',
        'Tested: vitest',
        'Outcome: code-bug',
      ]),
    });
    expect(result).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('Outcome: code-bug with an UNSCOPED fix: subject also passes (implication accepts both forms)', async () => {
    const result = await commitGate({
      message: messageOf('fix: handle an empty config object', [
        'Confidence: 0.95',
        'Tested: vitest',
        'Outcome: code-bug',
      ]),
    });
    expect(result).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('a present Not-tested trailer violates nothing (optional rule, satisfied)', async () => {
    const result = await commitGate({
      message: messageOf('chore(test): todo: retire the flaky eviction case', [
        'Confidence: 0.7',
        'Not-tested: covered by the e2e suite',
        'Outcome: todo',
      ]),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations.map((v) => v.rule)).toEqual(['Tested']);
  });

  test('a missing Outcome never triggers implications (the missing-trailer violation already fired)', async () => {
    const result = await commitGate({
      message: messageOf('fix(app): something', ['Confidence: 0.9', 'Tested: vitest']),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations.map((v) => v.rule)).toEqual(['Outcome']);
  });
});

describe('commitGate trailer-block parsing', () => {
  test('trailers NOT in the trailing paragraph (prose after a blank line) are treated as missing', async () => {
    const result = await commitGate({ message: `${VALID}\n\nReviewer asked to revisit next week.` });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.ok).toBe(false);
    expect(result.value.violations.map((v) => [v.rule, v.message])).toEqual([
      ['Confidence', 'required trailer "Confidence" is missing'],
      ['Tested', 'required trailer "Tested" is missing'],
      ['Outcome', 'required trailer "Outcome" is missing'],
    ]);
  });

  test('a trailing paragraph with one non-trailer line voids the whole trailer block', async () => {
    const result = await commitGate({
      message: messageOf('fix(test): drop the flaky case', [
        'Confidence: 0.9',
        'Tested: vitest',
        'Looks good to me.',
      ]),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations.map((v) => v.rule)).toEqual(['Confidence', 'Tested', 'Outcome']);
  });

  test('indented continuation lines fold into the previous trailer value (no false missing)', async () => {
    const result = await commitGate({
      message: [
        'fix(test): re-baseline the eviction suite',
        '',
        'Notes: audited the new clock skew tolerance',
        '  line-by-line against the TTL table',
        'Confidence: 0.9',
        '',
      ].join('\n'),
      config: {
        trailers: [
          { name: 'Notes', required: true, pattern: '^audited the new clock skew tolerance line-by-line against the TTL table$' },
          { name: 'Confidence', required: true, pattern: '^[0-9]+(\\.[0-9]+)?$' },
        ],
      },
    });
    expect(result).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('a folded trailer satisfies the shipped single-line value pattern (space-joined)', async () => {
    const result = await commitGate({
      message: messageOf('fix(test): re-baseline the eviction suite', [
        'Confidence: 0.9',
        'Tested: vitest suite',
        '  plus the typecheck',
        'Outcome: code-bug',
      ]),
    });
    expect(result).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('a folded trailer against the default value patterns is a value violation, NOT a missing one', async () => {
    const result = await commitGate({
      message: messageOf('fix(test): re-baseline the eviction suite', [
        'Confidence: 0.9',
        '  audited by hand against the fixtures',
        'Tested: vitest',
        'Outcome: code-bug',
      ]),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations.map((v) => [v.rule, v.message])).toEqual([
      ['Confidence', '"Confidence" value does not match the required pattern'],
    ]);
  });

  test('a subject-only message has no trailer block (the subject paragraph is never trailers)', async () => {
    const result = await commitGate({ message: 'fix: x\nConfidence: 0.9' });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations.map((v) => v.rule)).toEqual(['Confidence', 'Tested', 'Outcome']);
  });

  test('CRLF messages parse identically', async () => {
    const result = await commitGate({ message: VALID.replaceAll('\n', '\r\n') });
    expect(result).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('a repeated trailer: the first occurrence is the one checked', async () => {
    const result = await commitGate({
      message: messageOf('fix(parser): accept empty config objects', [
        'Confidence: high',
        'Confidence: 0.8',
        'Tested: vitest',
        'Outcome: code-bug',
      ]),
    });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations.map((v) => v.rule)).toEqual(['Confidence']);
  });
});

describe('commitGate config genericity', () => {
  test('the shipped defaults are DEEP-frozen: mutation attempts throw in strict mode', () => {
    expect(Object.isFrozen(DEFAULT_COMMIT_TRAILERS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_COMMIT_TRAILERS[0])).toBe(true);
    expect(Object.isFrozen(DEFAULT_COMMIT_IMPLICATIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_COMMIT_IMPLICATIONS[0])).toBe(true);
    expect(() => {
      (DEFAULT_COMMIT_TRAILERS[0] as { required: boolean }).required = false;
    }).toThrow(TypeError);
    expect(DEFAULT_COMMIT_TRAILERS[0]?.required).toBe(true);
    const outcome = DEFAULT_COMMIT_TRAILERS.find((rule) => rule.name === 'Outcome');
    expect(Object.isFrozen(outcome?.oneOf)).toBe(true);
    expect(() => {
      (outcome?.oneOf as string[]).push('shipping');
    }).toThrow(TypeError);
    expect(outcome?.oneOf).toEqual(['broken-test', 'code-bug', 'todo']);
  });

  test('custom trailers REPLACE the shipped taxonomy: only custom rules are enforced', async () => {
    const config: CommitGateConfig = {
      trailers: [{ name: 'Reviewed-by', required: true, pattern: '^.+$' }],
    };
    const result = await commitGate({ message: 'updated the cache logic', config });
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value.violations).toEqual([
      {
        rule: 'subject',
        message: 'subject does not match the required subject pattern',
        evidence: 'updated the cache logic',
      },
      {
        rule: 'Reviewed-by',
        message: 'required trailer "Reviewed-by" is missing',
        evidence: '',
      },
    ]);
  });

  test('requireSubject: false tolerates a subjectless message; the subject pattern still checks present subjects', async () => {
    const tolerant = await commitGate({
      message: '\nSome notes without a subject.\n',
      config: { requireSubject: false, trailers: [] },
    });
    expect(tolerant).toEqual({ status: 'ok', value: { ok: true, violations: [] } });

    const customPattern = await commitGate({
      message: messageOf('JIRA-42: rotate the fixture keys', []),
      config: { subjectPattern: '^\\[?JIRA-\\d+\\]?:? ', trailers: [] },
    });
    expect(customPattern).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
  });

  test('a custom outcomeTrailer drives custom implications (the mechanism is not Outcome-hardcoded)', async () => {
    const config: CommitGateConfig = {
      subjectPattern: '^.+',
      trailers: [{ name: 'Result', required: true, oneOf: ['spike'] }],
      outcomeTrailer: 'Result',
      implications: [{ outcomeValue: 'spike', subjectPattern: '^chore\\(spike\\):' }],
    };
    const passing = await commitGate({
      message: messageOf('chore(spike): probe the flaky eviction case', ['Result: spike']),
      config,
    });
    expect(passing).toEqual({ status: 'ok', value: { ok: true, violations: [] } });

    const failing = await commitGate({
      message: messageOf('fix: probe the flaky eviction case', ['Result: spike']),
      config,
    });
    if (failing.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(failing.value.violations.map((v) => v.rule)).toEqual(['spike']);
  });

  test('an uncompilable config regex is a `failed` op, never a crash', async () => {
    const result = await commitGate({ message: VALID, config: { subjectPattern: '(' } });
    expect(result.status).toBe('failed');
  });
});
