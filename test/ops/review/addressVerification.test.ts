import { describe, expect, test } from 'vitest';
import {
  verifyClosureEvidence,
  type ClosurePacket,
  type ClosureVerification,
  type VerificationCheck,
} from '../../../src/ops/review/internal/addressVerification.js';

const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);

const BEFORE = [
  'export function load(raw: string): Config {',
  '  const parsed = JSON.parse(raw);',
  "  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
  '  return normalize(parsed);',
  '}',
].join('\n');

const AFTER = [
  'export function load(raw: string): Config {',
  '  const parsed = JSON.parse(raw);',
  '  if (parsed.partial === true) enablePartial();',
  '  return normalize(parsed);',
  '}',
].join('\n');

// Patch fixture convention: a hunk line is its content line from BEFORE/AFTER
// prefixed with exactly one marker character (' ', '+', or '-'), so coherence
// checks see the same bytes the before/after snapshots carry.
const VALID_PATCH = [
  'diff --git a/src/config.ts b/src/config.ts',
  'index 1111111..2222222 100644',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -1,5 +1,5 @@',
  ' export function load(raw: string): Config {',
  '   const parsed = JSON.parse(raw);',
  "-  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
  '+  if (parsed.partial === true) enablePartial();',
  '   return normalize(parsed);',
  '}',
].join('\n');

const CHECK_ORDER = [
  'packet-complete',
  'revision-pinned',
  'patch-coherent',
  'trigger-removed',
  'dependencies-covered',
] as const;

const makePacket = (overrides: Partial<ClosurePacket> = {}): ClosurePacket => ({
  finding: {
    id: 'F1',
    text: 'loader accepts retired switch "PARTIAL_MODE"; partial mode must be a boolean flag',
    file: 'src/config.ts',
    line: 3,
  },
  task: 'Retire the string-literal partial switch in the loader.',
  patch: VALID_PATCH,
  before: BEFORE,
  after: AFTER,
  dependencies: [
    {
      path: 'src/index.ts',
      role: 'consumer',
      text: "import { load } from './config.js';\nload(process.argv[2] ?? '{}');\n",
    },
  ],
  relevantDependenciesComplete: true,
  metadata: { revision: { head: HEAD, parent: PARENT } },
  ...overrides,
});

const namesOf = (result: ClosureVerification): string[] =>
  result.checks.map((entry) => entry.check);
const outcomesOf = (result: ClosureVerification): string[] =>
  result.checks.map((entry) => entry.outcome);

/** Check names are always a prefix of the canonical order. */
const expectPrefix = (result: ClosureVerification): void => {
  expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, result.checks.length));
};

const expectLastCheck = (
  result: ClosureVerification,
  expected: { check: string; outcome: string },
): void => {
  const last = result.checks[result.checks.length - 1];
  expect(last).toBeDefined();
  expect(last?.check).toBe(expected.check);
  expect(last?.outcome).toBe(expected.outcome);
};

describe('review.address closure evidence verifier', () => {
  test('a valid fix resolves only when every check passes', () => {
    const result = verifyClosureEvidence(makePacket());
    expect(result.verdict).toBe('resolved');
    expect(result.reason).toBe('closure-evidence-complete');
    expect(namesOf(result)).toEqual([...CHECK_ORDER]);
    expect(outcomesOf(result)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(result.revision).toEqual({ head: HEAD, parent: PARENT });
  });

  test('no gate means full evaluation', () => {
    const result = verifyClosureEvidence(makePacket(), undefined);
    expect(result.verdict).toBe('resolved');
  });

  test('omitted consumer or dependency attestation yields uncertain', () => {
    const result = verifyClosureEvidence(makePacket({ relevantDependenciesComplete: false }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('omitted-consumer-or-dependency');
    expect(namesOf(result)).toEqual([...CHECK_ORDER]);
    expectLastCheck(result, { check: 'dependencies-covered', outcome: 'unavailable' });
    expect(result.checks[4]?.detail).toContain('completeness is not attested');
  });

  test('a quoted trigger surviving only in a cited consumer is unresolved', () => {
    // The changed file no longer passes PARTIAL_MODE, but the cited consumer
    // still does: closure evidence must sweep every cited dependency.
    const dependencies = [
      {
        path: 'src/legacy.ts',
        role: 'consumer' as const,
        text: "import { load } from './config.js';\nif (mode === 'PARTIAL_MODE') load(raw);\n",
      },
    ];
    const result = verifyClosureEvidence(makePacket({ dependencies }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'fail' });
    expect(result.checks[3]?.detail).toContain('PARTIAL_MODE');
    expect(result.checks[3]?.detail).toContain('src/legacy.ts');
  });

  test('a quoted trigger surviving in a cited dependency is unresolved', () => {
    const dependencies = [
      {
        path: 'src/flags.ts',
        role: 'dependency' as const,
        text: "export const RETIRED = 'PARTIAL_MODE';\n",
      },
    ];
    const result = verifyClosureEvidence(makePacket({ dependencies }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'fail' });
    expect(result.checks[3]?.detail).toContain('src/flags.ts');
  });

  test('a one-shot iterable dependencies value is unavailable, never resolved', () => {
    // A generator (or any one-shot iterable) would be exhausted by the first
    // pass, leaving later checks with an empty scan and minting false
    // closure. The declared contract is a real array; anything else is
    // unavailable evidence.
    const oneShot = makePacket();
    const iterable = {
      *[Symbol.iterator]() {
        yield {
          path: 'src/legacy.ts',
          role: 'consumer',
          text: "if (mode === 'PARTIAL_MODE') load(raw);\n",
        };
      },
    };
    (oneShot as { dependencies: unknown }).dependencies = iterable;
    const result = verifyClosureEvidence(oneShot);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('not an array');
  });

  test('a getter yielding different dependencies per read scans one snapshot', () => {
    // First read (validation) must be the only read: the mutating getter
    // serves a clean consumer first and the surviving trigger afterwards.
    const mutating = makePacket();
    let reads = 0;
    Object.defineProperty(mutating, 'dependencies', {
      get() {
        reads++;
        return reads === 1
          ? [
              {
                path: 'src/clean.ts',
                role: 'consumer',
                text: "load('{}');\n",
              },
            ]
          : [
              {
                path: 'src/legacy.ts',
                role: 'consumer',
                text: "if (mode === 'PARTIAL_MODE') load(raw);\n",
              },
            ];
      },
    });
    const result = verifyClosureEvidence(mutating);
    expect(result.verdict).toBe('resolved');
    expect(result.checks[0]?.detail).toContain('1 dependencies captured');
    expect(reads).toBe(1);
  });

  test('a getter turning dependencies hostile after validation cannot crash later checks', () => {
    // Validation captured the record; the getter then poisons the property.
    // Later checks must still scan the captured snapshot deterministically.
    const hostile = makePacket();
    let reads = 0;
    Object.defineProperty(hostile, 'dependencies', {
      get() {
        reads++;
        if (reads === 1)
          return [
            {
              path: 'src/clean.ts',
              role: 'consumer',
              text: "load('{}');\n",
            },
          ];
        throw new Error('dependencies withdrawn');
      },
    });
    const result = verifyClosureEvidence(hostile);
    expect(result.verdict).toBe('resolved');
    expect(result.checks[0]?.detail).toContain('1 dependencies captured');
    expect(reads).toBe(1);
  });

  test('a surviving quoted trigger is unresolved counter-evidence', () => {
    const survivingAfter = [
      'export function load(raw: string): Config {',
      '  const parsed = JSON.parse(raw);',
      '  // partial handling left as-is below',
      "  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
      '  return normalize(parsed);',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,5 +1,6 @@',
      ' export function load(raw: string): Config {',
      '   const parsed = JSON.parse(raw);',
      '+  // partial handling left as-is below',
      "   if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
      '   return normalize(parsed);',
      '}',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ patch, after: survivingAfter }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'fail' });
    expect(result.checks[3]?.detail).toContain('PARTIAL_MODE');
  });

  test('a removed declaration re-declared in after is unresolved', () => {
    const finding = {
      id: 'F2',
      text: 'loader declares a duplicate normalize helper instead of the shared one',
    };
    const before = [
      'export function load(raw: string): Config {',
      '  function normalize(x: string) {',
      '    return x.trim();',
      '  }',
      "  if (mode === 'legacy') {",
      '    function normalize(x: string) {',
      '      return x;',
      '    }',
      '  }',
      '  return sharedNormalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const after = [
      'export function load(raw: string): Config {',
      "  if (mode === 'legacy') {",
      '    function normalize(x: string) {',
      '      return x;',
      '    }',
      '  }',
      '  return sharedNormalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,11 +1,8 @@',
      ' export function load(raw: string): Config {',
      '-  function normalize(x: string) {',
      '-    return x.trim();',
      '-  }',
      "   if (mode === 'legacy') {",
      '     function normalize(x: string) {',
      '       return x;',
      '     }',
      '   }',
      '   return sharedNormalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ finding, before, after, patch }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(result.checks[3]?.detail).toContain('re-declared');
  });

  test('a removed declaration still declared in a cited consumer is unresolved', () => {
    const before = [
      'export const RETIRED_FLAG = 1;',
      'export function load(raw: string): Config {',
      '  return normalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const after = [
      'export function load(raw: string): Config {',
      '  return normalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,4 +1,3 @@',
      '-export const RETIRED_FLAG = 1;',
      ' export function load(raw: string): Config {',
      '   return normalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const dependencies = [
      {
        path: 'src/index.ts',
        role: 'consumer' as const,
        text: 'export const RETIRED_FLAG = 1;\nconsole.log(RETIRED_FLAG);\n',
      },
    ];
    const result = verifyClosureEvidence(makePacket({ before, after, patch, dependencies }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(result.checks[3]?.detail).toContain('src/index.ts');
  });

  test('a deletion-only patch can never close even with complete attestation', () => {
    const after = [
      'export function load(raw: string): Config {',
      '  const parsed = JSON.parse(raw);',
      '  return normalize(parsed);',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,5 +1,4 @@',
      ' export function load(raw: string): Config {',
      '   const parsed = JSON.parse(raw);',
      "-  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
      '   return normalize(parsed);',
      '}',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ patch, after }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('deleted-line-alone');
    expect(namesOf(result)).toEqual([...CHECK_ORDER]);
    expect(result.checks[3]?.outcome).toBe('pass');
    expectLastCheck(result, { check: 'dependencies-covered', outcome: 'unavailable' });
  });

  test('no citable trigger yields uncertain without demanding an edit', () => {
    const finding = {
      id: 'F3',
      text: 'loader keeps calling enablePartial for retired switches',
    };
    const before = [
      'export function load(raw: string): Config {',
      '  const parsed = JSON.parse(raw);',
      '  enablePartial();',
      '  return normalize(parsed);',
      '}',
    ].join('\n');
    const after = [
      'export function load(raw: string): Config {',
      '  const parsed = JSON.parse(raw);',
      '  return normalize(parsed);',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,5 +1,4 @@',
      ' export function load(raw: string): Config {',
      '   const parsed = JSON.parse(raw);',
      '-  enablePartial();',
      '   return normalize(parsed);',
      '}',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ finding, patch, before, after }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('no-citable-trigger');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'unavailable' });
  });

  test('unpinned revision identity yields uncertain', () => {
    const shortHead = makePacket();
    (shortHead.metadata as { revision: { head: string } }).revision.head = 'deadbeef';
    const short = verifyClosureEvidence(shortHead);
    expect(short.verdict).toBe('uncertain');
    expect(short.reason).toBe('unpinned-revision');
    expect(namesOf(short)).toEqual(CHECK_ORDER.slice(0, 2));

    const identical = verifyClosureEvidence(
      makePacket({ metadata: { revision: { head: HEAD, parent: HEAD } } }),
    );
    expect(identical.verdict).toBe('uncertain');
    expect(identical.reason).toBe('unpinned-revision');
  });

  test('missing revision metadata is unavailable evidence at packet-complete', () => {
    const packet = makePacket();
    (packet.metadata as { revision?: unknown }).revision = undefined;
    const result = verifyClosureEvidence(packet);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.revision).toBeUndefined();
  });

  test('malformed packet fields stop at packet-complete', () => {
    const packet = makePacket();
    delete (packet as { task?: string }).task;
    const result = verifyClosureEvidence(packet);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('task missing');
  });

  test('rename and malformed patches are uncertain, not resolved', () => {
    const rename = verifyClosureEvidence(
      makePacket({
        patch: VALID_PATCH.replace('+++ b/src/config.ts', '+++ b/src/config.renamed.ts'),
      }),
    );
    expect(rename.verdict).toBe('uncertain');
    expect(rename.reason).toBe('unavailable-evidence');
    expect(namesOf(rename)).toEqual(CHECK_ORDER.slice(0, 3));

    const noHunks = verifyClosureEvidence(
      makePacket({ patch: 'diff --git a/src/config.ts b/src/config.ts\n' }),
    );
    expect(noHunks.verdict).toBe('uncertain');
    expect(namesOf(noHunks)).toEqual(CHECK_ORDER.slice(0, 3));
  });

  test('before/after and patch content must agree', () => {
    const identical = verifyClosureEvidence(makePacket({ before: AFTER }));
    expect(identical.verdict).toBe('uncertain');
    expect(namesOf(identical)).toEqual(CHECK_ORDER.slice(0, 3));

    const missingAdded = verifyClosureEvidence(
      makePacket({ after: AFTER.replace('  if (parsed.partial === true) enablePartial();\n', '') }),
    );
    expect(missingAdded.verdict).toBe('uncertain');
    expect(missingAdded.checks[2]?.detail).toContain('added lines absent');

    const missingRemoved = verifyClosureEvidence(
      makePacket({
        before: BEFORE.replace(
          "  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();\n",
          '',
        ),
      }),
    );
    expect(missingRemoved.verdict).toBe('uncertain');
    expect(missingRemoved.checks[2]?.detail).toContain('removed lines absent');

    const wrongFile = verifyClosureEvidence(
      makePacket({ finding: { id: 'F1', text: 'x', file: 'src/other.ts' } }),
    );
    expect(wrongFile.verdict).toBe('uncertain');
    expect(wrongFile.checks[2]?.detail).toContain('finding cites src/other.ts');
  });

  test('cancellation before the first check carries the gate message', () => {
    const result = verifyClosureEvidence(makePacket(), {
      admit: () => {
        throw new Error('cancelled by parent');
      },
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('cancelled by parent');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      check: 'packet-complete',
      outcome: 'unavailable',
      detail: 'cancelled by parent',
      reason: 'cancelled by parent',
    });
  });

  test('budget exhaustion mid-sequence keeps the passed prefix and stops', () => {
    let calls = 0;
    const result = verifyClosureEvidence(makePacket(), {
      admit: () => {
        calls++;
        if (calls > 2) throw new Error('budget exhausted');
      },
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('budget exhausted');
    expect(namesOf(result)).toEqual(['packet-complete', 'revision-pinned', 'patch-coherent']);
    expect(outcomesOf(result)).toEqual(['pass', 'pass', 'unavailable']);
  });

  test('a non-error gate refusal is still uncertain', () => {
    const result = verifyClosureEvidence(makePacket(), {
      admit: () => {
        throw 'halt';
      },
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('verification gate refused');
    expect(result.checks[0]?.detail).toBe('halt');
  });

  test('a check-side storage failure degrades to unavailable evidence', () => {
    const hostile = makePacket();
    Object.defineProperty(hostile, 'dependencies', {
      get() {
        throw new Error('storage unavailable');
      },
    });
    const result = verifyClosureEvidence(hostile);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('storage unavailable');
  });

  test('verdict invariants hold over the core scenarios', () => {
    const scenarios: ClosureVerification[] = [
      verifyClosureEvidence(makePacket()),
      verifyClosureEvidence(makePacket({ relevantDependenciesComplete: false })),
      verifyClosureEvidence(makePacket(), { admit: () => undefined }),
      verifyClosureEvidence(makePacket({ metadata: { revision: { head: HEAD, parent: HEAD } } })),
    ];
    for (const result of scenarios) {
      expect(['resolved', 'unresolved', 'uncertain']).toContain(result.verdict);
      const failing = result.checks.filter((entry: VerificationCheck) => entry.outcome === 'fail');
      const unavailable = result.checks.filter(
        (entry: VerificationCheck) => entry.outcome === 'unavailable',
      );
      if (result.verdict === 'resolved') {
        expect(result.checks).toHaveLength(5);
        expect(failing).toHaveLength(0);
        expect(unavailable).toHaveLength(0);
      }
      if (result.verdict === 'unresolved') expect(failing.length).toBeGreaterThan(0);
      if (result.verdict === 'uncertain') {
        expect(unavailable.length).toBeGreaterThan(0);
        expect(failing).toHaveLength(0);
      }
      expectPrefix(result);
    }
  });
});
