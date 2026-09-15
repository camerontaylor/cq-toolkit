// Gates lane C3 — registry-slice test evidence: the two NEW entries
// (gates.hackDetector, gates.commitGate) validate the full input and only
// it — strict unknown-key rejection everywhere (top level, tamper config,
// trailer rules, implications) — and their importers resolve through
// dynamic imports to the pure ops (no injected defaults to bind), which
// then produce real decisions end-to-end through the registry seam.
import { describe, expect, test } from 'vitest';
import {
  CommitGateInputSchema,
  HackDetectorInputSchema,
  registry,
} from '../../../src/ops/gates/registry.js';

describe('the C3 registry entries', () => {
  test('gates.hackDetector and gates.commitGate are registered after the C1+C2 slice', () => {
    expect(registry.map((entry) => entry.name)).toEqual([
      'gates.checkRunner',
      'gates.baselineProbe',
      'gates.regressionGate',
      'gates.hackDetector',
      'gates.commitGate',
    ]);
  });
});

describe('HackDetectorInputSchema (full input, and only it)', () => {
  const VALID = {
    diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n+const x = 1;\n',
    suppressionPatterns: [{ name: 'hack-token', pattern: 'HACK_TOKEN', requiresReason: true }],
    tamper: {
      testFilePatterns: ['\\.spec\\.[tj]sx?$'],
      detectDeletedTests: true,
      detectNewSkipOnly: false,
      skipOnlyPattern: '\\b(describe|it|test)\\s*\\.\\s*(skip|only)\\b',
      detectTautologies: true,
    },
  };

  test('parses a minimal input to exactly {diff} (no injected defaults at the boundary)', () => {
    expect(HackDetectorInputSchema.parse({ diff: '' })).toEqual({ diff: '' });
  });

  test('parses the full input with suppression patterns and tamper config', () => {
    expect(HackDetectorInputSchema.parse(VALID)).toEqual(VALID);
  });

  test('rejects unknown keys at the top level and inside nested config', () => {
    expect(HackDetectorInputSchema.safeParse({ ...VALID, patterns: [] }).success).toBe(false);
    expect(
      HackDetectorInputSchema.safeParse({
        ...VALID,
        suppressionPatterns: [{ name: 'x', pattern: 'y', flags: 'i', requiresReason: false }],
      }).success,
    ).toBe(true);
    expect(
      HackDetectorInputSchema.safeParse({
        ...VALID,
        suppressionPatterns: [{ name: 'x', pattern: 'y', global: true }],
      }).success,
    ).toBe(false);
    expect(
      HackDetectorInputSchema.safeParse({ ...VALID, tamper: { ...VALID.tamper, memoize: true } })
        .success,
    ).toBe(false);
  });

  test('rejects a non-string diff, empty pattern sources, and mistyped toggles', () => {
    expect(HackDetectorInputSchema.safeParse({ diff: 42 }).success).toBe(false);
    expect(
      HackDetectorInputSchema.safeParse({
        diff: '',
        suppressionPatterns: [{ name: 'x', pattern: '' }],
      }).success,
    ).toBe(false);
    expect(
      HackDetectorInputSchema.safeParse({ diff: '', tamper: { detectDeletedTests: 'yes' } }).success,
    ).toBe(false);
  });

  test('rejects empty regex-source strings (an empty pattern matches everything vacuously)', () => {
    expect(HackDetectorInputSchema.safeParse({ diff: '', tamper: { skipOnlyPattern: '' } }).success).toBe(
      false,
    );
    expect(HackDetectorInputSchema.safeParse({ diff: '', tamper: { testFilePatterns: [''] } }).success).toBe(
      false,
    );
  });
});

describe('CommitGateInputSchema (full input, and only it)', () => {
  const VALID = {
    message: 'fix(test): x\n\nConfidence: 0.9\n',
    config: {
      subjectPattern: '^fix',
      requireSubject: true,
      trailers: [{ name: 'Outcome', required: true, oneOf: ['todo'], pattern: '^[a-z-]+$' }],
      outcomeTrailer: 'Outcome',
      implications: [{ outcomeValue: 'todo', subjectPattern: '^chore' }],
    },
  };

  test('parses a bare message to exactly {message} (defaults live in the op)', () => {
    expect(CommitGateInputSchema.parse({ message: 'fix: x' })).toEqual({ message: 'fix: x' });
  });

  test('parses the full input with a complete config', () => {
    expect(CommitGateInputSchema.parse(VALID)).toEqual(VALID);
  });

  test('rejects unknown keys at the top level, in config, in rules, and in implications', () => {
    expect(CommitGateInputSchema.safeParse({ ...VALID, verdict: 'ok' }).success).toBe(false);
    expect(
      CommitGateInputSchema.safeParse({ ...VALID, config: { ...VALID.config, cache: true } }).success,
    ).toBe(false);
    expect(
      CommitGateInputSchema.safeParse({
        ...VALID,
        config: {
          ...VALID.config,
          trailers: [{ name: 'X', required: true, oneOf: [], pattern: '', case: 'upper' }],
        },
      }).success,
    ).toBe(false);
    expect(
      CommitGateInputSchema.safeParse({
        ...VALID,
        config: {
          ...VALID.config,
          implications: [{ outcomeValue: 'todo', subjectPattern: '^chore', severity: 1 }],
        },
      }).success,
    ).toBe(false);
  });

  test('rejects a non-string message and rules without a name', () => {
    expect(CommitGateInputSchema.safeParse({ message: 7 }).success).toBe(false);
    expect(CommitGateInputSchema.safeParse({}).success).toBe(false);
    expect(
      CommitGateInputSchema.safeParse({
        ...VALID,
        config: { ...VALID.config, trailers: [{ required: true }] },
      }).success,
    ).toBe(false);
  });

  test('rejects empty regex-source strings (an empty pattern matches everything vacuously)', () => {
    expect(
      CommitGateInputSchema.safeParse({ ...VALID, config: { ...VALID.config, subjectPattern: '' } })
        .success,
    ).toBe(false);
    expect(
      CommitGateInputSchema.safeParse({
        ...VALID,
        config: {
          ...VALID.config,
          trailers: [{ name: 'Confidence', required: true, pattern: '' }],
        },
      }).success,
    ).toBe(false);
    expect(
      CommitGateInputSchema.safeParse({
        ...VALID,
        config: {
          ...VALID.config,
          implications: [{ outcomeValue: 'todo', subjectPattern: '' }],
        },
      }).success,
    ).toBe(false);
  });

  test('rejects empty outcomeTrailer, empty oneOf elements, and empty outcomeValue', () => {
    expect(
      CommitGateInputSchema.safeParse({ ...VALID, config: { ...VALID.config, outcomeTrailer: '' } })
        .success,
    ).toBe(false);
    expect(
      CommitGateInputSchema.safeParse({
        ...VALID,
        config: {
          ...VALID.config,
          trailers: [{ name: 'Outcome', required: true, oneOf: [''] }],
        },
      }).success,
    ).toBe(false);
    expect(
      CommitGateInputSchema.safeParse({
        ...VALID,
        config: {
          ...VALID.config,
          implications: [{ outcomeValue: '', subjectPattern: '^chore' }],
        },
      }).success,
    ).toBe(false);
  });
});

describe('the C3 importers resolve to working pure ops', () => {
  test('gates.hackDetector resolves and flags a tampered diff through the registry seam', async () => {
    const entry = registry.find((candidate) => candidate.name === 'gates.hackDetector');
    if (!entry) {
      throw new Error('gates.hackDetector missing from the registry');
    }
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    const result = await op({
      diff: [
        'diff --git a/src/thing.test.ts b/src/thing.test.ts',
        'index 1111111..2222222 100644',
        '--- a/src/thing.test.ts',
        '+++ b/src/thing.test.ts',
        '@@ -1,2 +1,3 @@',
        ' const a = 1;',
        '+// @ts-ignore',
        ' const b = 2;',
      ].join('\n'),
    });
    expect(result).toEqual({
      status: 'ok',
      value: [
        {
          kind: 'suppression',
          file: 'src/thing.test.ts',
          line: 2,
          pattern: '@ts-ignore',
          snippet: '// @ts-ignore',
          message: 'added suppression "@ts-ignore"',
        },
      ],
    });
  });

  test('gates.commitGate resolves and decides through the registry seam', async () => {
    const entry = registry.find((candidate) => candidate.name === 'gates.commitGate');
    if (!entry) {
      throw new Error('gates.commitGate missing from the registry');
    }
    const op = await entry.importer();
    const passing = await op({
      message: 'fix(test): cache eviction kept stale entries\n\nConfidence: 0.9\nTested: vitest\nOutcome: broken-test',
    });
    expect(passing).toEqual({ status: 'ok', value: { ok: true, violations: [] } });
    const failing = await op({ message: 'updated stuff' });
    expect(failing).toEqual({
      status: 'ok',
      value: {
        ok: false,
        violations: [
          {
            rule: 'subject',
            message: 'subject does not match the required subject pattern',
            evidence: 'updated stuff',
          },
          { rule: 'Confidence', message: 'required trailer "Confidence" is missing', evidence: '' },
          { rule: 'Tested', message: 'required trailer "Tested" is missing', evidence: '' },
          { rule: 'Outcome', message: 'required trailer "Outcome" is missing', evidence: '' },
        ],
      },
    });
  });
});
