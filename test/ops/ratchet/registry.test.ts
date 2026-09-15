// Lane H slice 1 (+ round-1 fix) — tests for the metric adapter registry
// (src/ops/ratchet/registry.ts) and the typecheck-count adapter
// (src/ops/ratchet/adapters/typecheckCount.ts).
//
// Pinned here:
//   1. Registry: register/get round-trip, unknown-id → undefined, loud
//      duplicate rejection, sorted listAdapters. The registry is
//      module-level, so every test uses fresh ids; vitest isolates module
//      state per test file, so these cannot leak.
//   2. typecheckCount extract: structured {count} objects (top-level or
//      nested) are read verbatim (a structured 0 is a real zero); counts
//      must be non-negative SAFE integers (0.5 → null, and anything beyond
//      2^53-1 — not a representable cardinality — → null); cyclic source data
//      terminates as null (or still extracts when a count is reachable)
//      instead of recursing forever; raw compiler text is counted by
//      ANCHORED tsc diagnostic-header lines (classic `path(line,col):` with
//      paths that may contain spaces, pretty `path:line:col -`, and
//      location-free `error TSxxxx:` heads, with ANSI escapes stripped
//      first) — quoted diagnostic text in displayed source lines never
//      counts; text with no headers (empty or otherwise) and non-text
//      non-object garbage are null — non-passing evidence (I5), never a
//      fabricated pass.
import { describe, expect, test } from 'vitest';
import { typecheckCount } from '../../../src/ops/ratchet/adapters/typecheckCount.js';
import { getAdapter, listAdapters, registerAdapter } from '../../../src/ops/ratchet/registry.js';
import type { MetricAdapter } from '../../../src/ops/ratchet/registry.js';

function adapter(id: string): MetricAdapter {
  return { id, direction: 'lower-is-better', extract: () => null };
}

describe('registry', () => {
  test('register + get round-trips the adapter', () => {
    const a = adapter('reg-probe-a');
    registerAdapter(a);
    expect(getAdapter('reg-probe-a')).toBe(a);
  });

  test('getAdapter of an unknown id is undefined', () => {
    expect(getAdapter('reg-never-registered')).toBeUndefined();
  });

  test('registering a duplicate id throws', () => {
    registerAdapter(adapter('reg-probe-dup'));
    expect(() => registerAdapter(adapter('reg-probe-dup'))).toThrow(/already registered/);
  });

  test('listAdapters is sorted and includes everything registered', () => {
    registerAdapter(adapter('reg-zeta'));
    registerAdapter(adapter('reg-alpha'));
    registerAdapter(adapter('reg-mid'));
    const listed = listAdapters();
    expect(listed).toEqual([...listed].sort());
    expect(listed).toContain('reg-alpha');
    expect(listed).toContain('reg-mid');
    expect(listed).toContain('reg-zeta');
  });
});

describe('typecheckCount', () => {
  test('carries its adapter metadata', () => {
    expect(typecheckCount.id).toBe('typecheck-count');
    expect(typecheckCount.direction).toBe('lower-is-better');
  });

  test('slots into the registry under its id', () => {
    registerAdapter(typecheckCount);
    expect(getAdapter('typecheck-count')).toBe(typecheckCount);
  });

  const TSC_OUTPUT =
    'src/a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n' +
    'src/b.ts(4,1): error TS2304: Cannot find name \'missing\'.\n' +
    'src/c.ts(9,3): error TS2345: Argument of type \'x\' is not assignable.\n';

  // A real diagnostic header followed by a displayed SOURCE line that merely
  // quotes the literal text — the unanchored /error TS\d+:/ counted 2 here.
  const TSC_OUTPUT_WITH_QUOTED_TEXT =
    'src/a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n' +
    'const message = "error TS1234:";';

  const TSC_PRETTY_OUTPUT =
    'src/p.ts:3:1 - error TS2304: Cannot find name \'missing\'.\n' +
    'src/q.ts:4:5 - error TS2571: Object is possibly \'undefined\'.';

  const TSC_MIXED_OUTPUT =
    'src/a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n' +
    'src/p.ts:3:1 - error TS2304: Cannot find name \'missing\'.';

  const TSC_SPACED_PATH =
    'bad file.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'.';

  const TSC_PAREN_PATH = 'weird(1).ts(2,3): error TS2322: Property \'x\' is missing.';

  const TSC_LOCATION_FREE =
    'error TS18003: No inputs were found in configuration file \'tsconfig.json\'.';

  const TSC_ANSI_PRETTY =
    '\u001b[96msrc/p.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m5\u001b[0m - \u001b[91merror TS2304\u001b[0m: Cannot find name \'missing\'.';

  const TSC_ANSI_QUOTED = '\u001b[36mconst message = "error TS1234:";\u001b[0m';

  // Cyclic source data: the visited-set must bound the descent either way.
  const cyclicNoCount: Record<string, unknown> = { name: 'loop' };
  cyclicNoCount['self'] = cyclicNoCount;
  const cyclicWithCount: Record<string, unknown> = { count: 5 };
  cyclicWithCount['self'] = cyclicWithCount;

  const extractCases: Array<[string, unknown, number | null]> = [
    // [label, raw, expected value (null = extract returns null)]
    ['flat count object', { count: 3 }, 3],
    ['nested count object', { outer: { count: 7 } }, 7],
    ['structured zero is a real zero', { count: 0 }, 0],
    ['raw tsc output with several errors', TSC_OUTPUT, 3],
    ['pretty-format tsc headers count', TSC_PRETTY_OUTPUT, 2],
    ['classic and pretty headers count together', TSC_MIXED_OUTPUT, 2],
    ['classic header with a spaced path counts', TSC_SPACED_PATH, 1],
    ['path containing a parenthetic location counts once', TSC_PAREN_PATH, 1],
    ['location-free diagnostic header counts', TSC_LOCATION_FREE, 1],
    ['ANSI-colored pretty header counts', TSC_ANSI_PRETTY, 1],
    ['ANSI-colored quoted source text still does not count', TSC_ANSI_QUOTED, null],
    ['quoted diagnostic text in a source line is not counted', TSC_OUTPUT_WITH_QUOTED_TEXT, 1],
    ['a file of only quoted diagnostic text yields null', 'const message = "error TS1234:";\nconst other = "error TS9999:";', null],
    ['negative count', { count: -1 }, null],
    ['non-integer count (a fraction of an error is unusable)', { count: 0.5 }, null],
    ['huge integer count is not a representable cardinality', { count: 1e100 }, null],
    ['2**53 is beyond safe-integer cardinality', { count: 2 ** 53 }, null],
    ['large but safe count is fine', { count: 2 ** 53 - 1 }, 9007199254740991],
    ['non-finite count', { count: Number.POSITIVE_INFINITY }, null],
    ['NaN count', { count: Number.NaN }, null],
    ['count key present but not numeric', { count: 'many' }, null],
    ['cyclic data without a count terminates as null', cyclicNoCount, null],
    ['cyclic data with a reachable count still extracts', cyclicWithCount, 5],
    ['empty text', '', null],
    ['clean-build-style text (no error lines)', 'Successfully ran, all good.', null],
    ['object without any count', { errors: 'many', summary: 'bad' }, null],
    ['non-object non-text garbage', 42, null],
    ['null raw', null, null],
    ['undefined raw', undefined, null],
  ];

  test.each(extractCases)('extract: %s', (_label, raw, expected) => {
    expect(typecheckCount.extract(raw)).toEqual(
      expected === null ? null : { value: expected, unit: 'errors' },
    );
  });
});
