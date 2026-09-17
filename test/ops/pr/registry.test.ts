// PR family registry slice tests (goal D3) — the `pr.assemblePrs` and
// `pr.runReport` entries (src/ops/pr/registry.ts), mirroring the
// review/sweep family registry-surface pins:
//   1. Name — the family carries exactly the two D3 ops, each named
//      `<family>.<module base>` so the central completeness heuristic's
//      family-prefixed rule covers the module.
//   2. Schema accepts a minimal valid input for each op (the same JSON a
//      dispatcher would send) and rejects unknown keys (strict throughout).
//   3. THE PREFIX REFINEMENTS: a tracker.branch or packages[].branch
//      outside `<runPrefix>/` fails schema validation (exit-2 class at the
//      CLI boundary, before any op runs).
//   4. The importer RESOLVES to a callable async op WITHOUT being invoked
//      and WITHOUT env/network/filesystem contact: the binding constructs
//      makeSubprocessPrEffects, which is closure-only at construction
//      (execFile spawns only when an effect is CALLED). assemblePrs is
//      never CALLED here — any dispatch would run real gh. runReport IS
//      dispatched once over an EMPTY fleet with no tracker — the one
//      input whose execution performs zero gh calls — proving the full
//      registry wiring end-to-end, hermetically.
// Plus the real gh adapter's pure parsers, fixture-tested against captured
// gh JSON shapes (they live here because this file is the family's
// registry-surface suite and the adapter is the importer's binding):
// parsePrList, parseCreatedPr, checksOfRollup, reviewStateOfDecision, and
// the mapGhFault taxonomy.
import { describe, expect, test } from 'vitest';
import {
  makeSubprocessPrEffects,
  mapGhFault,
  parseCreatedPr,
  parsePrList,
} from '../../../src/ops/pr/ghEffects.js';
import { checksOfRollup, reviewStateOfDecision } from '../../../src/ops/pr/ghEffects.js';
import { registry } from '../../../src/ops/pr/registry.js';

const ENTRY_NAMES = ['pr.assemblePrs', 'pr.runReport'];

const entryByName = (name: string) => {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing registry entry '${name}'`);
  return entry;
};

// ---------------------------------------------------------------------------
// Minimal valid inputs (the JSON a dispatcher would send)
// ---------------------------------------------------------------------------

const assembleInput = (): Record<string, unknown> => ({
  repoRoot: '/repo',
  runPrefix: 'cq/09-16a',
  base: 'origin/merge-queue',
  tracker: { title: 'Fleet run cq/09-16a', branch: 'cq/09-16a/tracker' },
  packages: [{ name: 'core', branch: 'cq/09-16a/fix/core', title: 'core fixes' }],
});

const reportInput = (): Record<string, unknown> => ({
  repoRoot: '/repo',
  runPrefix: 'cq/09-16a',
  tracker: { number: 7 },
  packages: [
    { name: 'core', number: 11 },
    { name: 'util', number: 12 },
  ],
});

const minimalInputs: Record<string, () => Record<string, unknown>> = {
  'pr.assemblePrs': assembleInput,
  'pr.runReport': reportInput,
};

/** The minimal input fixture for one entry, failing loud when the name is unknown. */
const minimalInput = (name: string): Record<string, unknown> => {
  const make = minimalInputs[name];
  if (make === undefined) throw new Error(`no minimal input fixture for '${name}'`);
  return make();
};

/** The first package entry of a fixture, failing loud on a fixture bug (noUncheckedIndexedAccess). */
const firstPackageOf = (input: Record<string, unknown>): Record<string, unknown> => {
  const pkg = (input['packages'] as Array<Record<string, unknown>>)[0];
  if (pkg === undefined) throw new Error('fixture bug: no package entry');
  return pkg;
};

// ---------------------------------------------------------------------------
// Per-entry contract: name, accept, reject, resolve
// ---------------------------------------------------------------------------

describe('pr family registry entries', () => {
  test('the family carries exactly the two D3 entries', () => {
    expect(registry.map((entry) => entry.name).sort()).toEqual([...ENTRY_NAMES].sort());
  });

  test.each(ENTRY_NAMES)('%s: inputSchema accepts a minimal valid input', (name) => {
    expect(entryByName(name).inputSchema.safeParse(minimalInput(name)).success).toBe(true);
  });

  test.each(ENTRY_NAMES)('%s: inputSchema rejects an unknown key', (name) => {
    const input = { ...minimalInput(name), extra: 1 };
    expect(entryByName(name).inputSchema.safeParse(input).success).toBe(false);
  });

  test('assemblePrs: an unknown key INSIDE a package is rejected too (strict throughout)', () => {
    const input = assembleInput();
    firstPackageOf(input)['surprise'] = true;
    expect(entryByName('pr.assemblePrs').inputSchema.safeParse(input).success).toBe(false);
  });

  test.each(ENTRY_NAMES)(
    '%s: importer resolves to a callable async op (and is NOT invoked)',
    async (name) => {
      // Resolving constructs makeSubprocessPrEffects — closure-only, inert:
      // execFile spawns only when an effect is CALLED, so resolution touches
      // no env, network, or filesystem. The op is deliberately not invoked:
      // any assemblePrs dispatch (and any runReport dispatch over a
      // non-empty fleet) would run real gh.
      const op = await entryByName(name).importer();
      expect(typeof op).toBe('function');
      expect((op as unknown as { constructor: { name: string } }).constructor.name).toContain(
        'AsyncFunction',
      );
    },
  );

  test('runReport dispatched through the full registry wiring over an empty fleet performs ZERO gh calls', async () => {
    // The one hermetic dispatch: empty packages + no tracker → the loop
    // never runs and no tracker edit exists, so the wiring is exercised
    // end-to-end without a single gh invocation.
    const op = await entryByName('pr.runReport').importer();
    const result = (await (
      op as (i: unknown) => Promise<{ status: string; value?: { trackerUpdated: boolean } }>
    )({ repoRoot: '/repo', runPrefix: 'cq/09-16a', packages: [] })) as {
      status: string;
      value?: { trackerUpdated: boolean };
    };
    expect(result.status).toBe('ok');
    expect(result.value).toEqual({
      runPrefix: 'cq/09-16a',
      rows: [],
      counts: { ready: 0, blocked: 0, unknown: 0 },
      trackerUpdated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The prefix refinements (UC row 22's fleet namespace at the JSON boundary)
// ---------------------------------------------------------------------------

describe('the run-prefix refinements', () => {
  test('a tracker branch outside the run prefix fails schema validation', () => {
    const input = assembleInput();
    (input['tracker'] as Record<string, unknown>).branch = 'elsewhere/tracker';
    const parsed = entryByName('pr.assemblePrs').inputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toContain(
      "tracker.branch must start with '<runPrefix>/'",
    );
  });

  test('a package branch outside the run prefix fails schema validation', () => {
    const input = assembleInput();
    firstPackageOf(input).branch = 'feature/core';
    const parsed = entryByName('pr.assemblePrs').inputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toContain(
      "every packages[].branch must start with '<runPrefix>/'",
    );
  });

  test('a prefix-matching fleet passes both refinements', () => {
    const input = assembleInput();
    (input['packages'] as Array<Record<string, unknown>>).push({
      name: 'util',
      branch: 'cq/09-16a/fix/util',
      title: 'util fixes',
    });
    expect(entryByName('pr.assemblePrs').inputSchema.safeParse(input).success).toBe(true);
  });

  test('runReport: a zero, negative, or non-integer PR number is refused at the boundary', () => {
    const schema = entryByName('pr.runReport').inputSchema;
    for (const bad of [0, -3, 1.5]) {
      const input = reportInput();
      firstPackageOf(input).number = bad;
      expect(schema.safeParse(input).success).toBe(false);
    }
    const trackerInput = reportInput();
    (trackerInput['tracker'] as Record<string, unknown>).number = 0;
    expect(schema.safeParse(trackerInput).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real gh adapter's pure parsers — captured-shape fixtures
// ---------------------------------------------------------------------------

describe('parsePrList (gh pr list --json number,url)', () => {
  test('an empty fleet has no PR on the head', () => {
    expect(parsePrList('[]')).toEqual([]);
  });

  test('rows keep the number and the URL when gh reported one', () => {
    expect(
      parsePrList('[{"number":7,"url":"https://github.test/owner/repo/pull/7"},{"number":8}]'),
    ).toEqual([{ number: 7, url: 'https://github.test/owner/repo/pull/7' }, { number: 8 }]);
  });

  test('a non-array payload and a row without a number are untrustworthy (thrown)', () => {
    expect(() => parsePrList('{"number":7}')).toThrow(/non-array payload/);
    expect(() => parsePrList('[{"url":"https://github.test/owner/repo/pull/7"}]')).toThrow(
      /without a numeric number/,
    );
  });

  test('non-JSON output is a fault, never a guess', () => {
    expect(() => parsePrList('gh: (GitHub) API rate limit exceeded')).toThrow(/non-JSON output/);
  });
});

describe('parseCreatedPr (gh pr create stdout)', () => {
  test('the printed URL yields the number and the URL', () => {
    expect(parseCreatedPr('https://github.test/owner/repo/pull/123\n')).toEqual({
      number: 123,
      url: 'https://github.test/owner/repo/pull/123',
    });
  });

  test('output without a pull URL is a fault (never a fabricated number)', () => {
    expect(() => parseCreatedPr('creating pull request for cq/09-16a/fix/core\n')).toThrow(
      /printed no PR URL/,
    );
  });
});

describe('checksOfRollup (gh pr view --json statusCheckRollup)', () => {
  test('an empty or absent rollup is `none`, not a fabricated pass', () => {
    expect(checksOfRollup([])).toEqual({ state: 'none' });
    expect(checksOfRollup(undefined)).toEqual({ state: 'none' });
  });

  test('all-green CheckRuns (COMPLETED + SUCCESS) fold to pass', () => {
    expect(
      checksOfRollup([
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ]),
    ).toEqual({ state: 'pass' });
  });

  test('a failing CheckRun names every failed check', () => {
    expect(
      checksOfRollup([
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      ]),
    ).toEqual({ state: 'fail', failing: ['test', 'lint'] });
  });

  test('a queued/in-progress CheckRun (null conclusion) keeps the PR pending', () => {
    expect(
      checksOfRollup([
        { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
      ]),
    ).toEqual({ state: 'pending' });
  });

  test('StatusContext shapes fold by state; EXPECTED is pending, FAILURE is fail', () => {
    expect(
      checksOfRollup([{ __typename: 'StatusContext', context: 'ci/travis', state: 'SUCCESS' }]),
    ).toEqual({ state: 'pass' });
    expect(
      checksOfRollup([{ __typename: 'StatusContext', context: 'ci/travis', state: 'FAILURE' }]),
    ).toEqual({ state: 'fail', failing: ['ci/travis'] });
    expect(
      checksOfRollup([{ __typename: 'StatusContext', context: 'ci/travis', state: 'EXPECTED' }]),
    ).toEqual({ state: 'pending' });
  });

  test('an unrecognized entry is pending — never a fabricated pass, never a fabricated fail', () => {
    expect(checksOfRollup([{ __typename: 'RequestCheckpoint', name: 'deploy' }])).toEqual({
      state: 'pending',
    });
    expect(checksOfRollup(['garbage'])).toEqual({ state: 'pending' });
  });

  test('fail wins over pending in a mixed rollup', () => {
    expect(
      checksOfRollup([
        { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toEqual({ state: 'fail', failing: ['test'] });
  });
});

describe('reviewStateOfDecision (gh pr view --json reviewDecision)', () => {
  test('the three real words and null map onto the seam vocabulary', () => {
    expect(reviewStateOfDecision('APPROVED')).toEqual({ state: 'approved' });
    expect(reviewStateOfDecision('CHANGES_REQUESTED')).toEqual({ state: 'changes-requested' });
    expect(reviewStateOfDecision('REVIEW_REQUIRED')).toEqual({ state: 'none' });
    expect(reviewStateOfDecision(null)).toEqual({ state: 'none' });
  });

  test('an unrecognized word is unknown — never a fabricated verdict', () => {
    expect(reviewStateOfDecision('REQUIRED')).toEqual({ state: 'unknown' });
    expect(reviewStateOfDecision(undefined)).toEqual({ state: 'unknown' });
  });
});

describe('mapGhFault (the execFile fault taxonomy)', () => {
  const ARGS = ['pr', 'view', '7'];

  test('a maxBuffer overflow is named a size limit, not a timeout', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'stdout maxBuffer length exceeded', killed: true },
      '',
      600_000,
    );
    expect(fault.message).toContain('exceeded the output limit');
    expect(fault.message).toContain('maxBuffer');
    expect(fault.message).not.toContain('timed out');
  });

  test('a SIGKILLed call is named a timeout that never produced evidence', () => {
    const fault = mapGhFault(ARGS, { message: 'command failed', killed: true }, '', 600_000);
    expect(fault.message).toContain('timed out after 600000ms');
    expect(fault.message).toContain('never produced evidence');
  });

  test('a plain nonzero exit carries the exit code and the captured stderr', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'command failed', killed: false, code: 4 },
      'GraphQL: Could not resolve to a PullRequest',
      600_000,
    );
    expect(fault.message).toContain('gh pr view (exit 4) failed');
    expect(fault.message).toContain('Could not resolve to a PullRequest');
  });

  test('a spawn failure without stderr falls back to the error message', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'spawn gh ENOENT', killed: false, code: 127 },
      '  ',
      600_000,
    );
    expect(fault.message).toContain('spawn gh ENOENT');
  });
});

describe('makeSubprocessPrEffects construction is inert', () => {
  test('the adapter is a closure set — no gh spawn at construction time', () => {
    // Construction must not touch env/network/filesystem (the importer
    // resolves it); the effects spawn only when CALLED.
    const effects = makeSubprocessPrEffects('/repo');
    expect(typeof effects.searchPrByHead).toBe('function');
    expect(typeof effects.createPr).toBe('function');
  });
});
