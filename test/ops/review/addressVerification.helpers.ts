// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files; this module holds their shared
// fixtures and assertions unchanged.
import { expect } from 'vitest';
import {
  type ClosurePacket,
  type ClosureVerification,
} from '../../../src/ops/review/internal/addressVerification.js';

export const HEAD = 'a'.repeat(40);
export const PARENT = 'b'.repeat(40);

export const BEFORE = [
  'export function load(raw: string): Config {',
  '  const parsed = JSON.parse(raw);',
  "  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
  '  return normalize(parsed);',
  '}',
].join('\n');

export const AFTER = [
  'export function load(raw: string): Config {',
  '  const parsed = JSON.parse(raw);',
  '  if (parsed.partial === true) enablePartial();',
  '  return normalize(parsed);',
  '}',
].join('\n');

// Patch fixture convention: a hunk line is its content line from BEFORE/AFTER
// prefixed with exactly one marker character (' ', '+', or '-'), so coherence
// checks see the same bytes the before/after snapshots carry.
export const VALID_PATCH = [
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
  ' }',
].join('\n');

// Literal full-file replacement fixture; deliberately includes every snapshot line.
export const replacementPatch = (before: string, after: string): string => {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  return [
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
};

export const CHECK_ORDER = [
  'packet-complete',
  'revision-pinned',
  'patch-coherent',
  'trigger-removed',
  'dependencies-covered',
] as const;

export const makePacket = (overrides: Partial<ClosurePacket> = {}): ClosurePacket => ({
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

export const namesOf = (result: ClosureVerification): string[] =>
  result.checks.map((entry) => entry.check);
export const outcomesOf = (result: ClosureVerification): string[] =>
  result.checks.map((entry) => entry.outcome);

/** Check names are always a prefix of the canonical order. */
export const expectPrefix = (result: ClosureVerification): void => {
  expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, result.checks.length));
};

export const expectLastCheck = (
  result: ClosureVerification,
  expected: { check: string; outcome: string },
): void => {
  const last = result.checks[result.checks.length - 1];
  expect(last).toBeDefined();
  expect(last?.check).toBe(expected.check);
  expect(last?.outcome).toBe(expected.outcome);
};
