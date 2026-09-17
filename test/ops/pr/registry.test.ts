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
//   4. The importer RESOLVES to an op WITHOUT env/network/filesystem
//      contact: the binding constructs makeSubprocessPrEffects, which is
//      closure-only at construction (execFile spawns only when an effect is
//      CALLED). The op is then CALLED once with a boundary-failing input
//      (required field deleted → `failed` before any effect), proving the
//      promise contract hermetically; no dispatch that would run gh ever
//      happens (runReport's one real dispatch below is the empty-fleet,
//      no-tracker input whose execution performs zero gh calls).
// Plus the real gh adapter's pure parsers, fixture-tested against captured
// gh JSON shapes (they live here because this file is the family's
// registry-surface suite and the adapter is the importer's binding):
// parsePrList, parseCreatedPr, checksOfRollup, reviewStateOfDecision, and
// the mapGhFault taxonomy.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { PrSearchResult, PrState } from '../../../src/ops/pr/assemblePrs.js';
import {
  composeSection,
  MANIFEST_SECTION_END_MARKER,
  MANIFEST_SECTION_MARKER,
  READINESS_SECTION_END_MARKER,
  READINESS_SECTION_MARKER,
} from '../../../src/ops/pr/assemblePrs.js';
import {
  bodyOf,
  checksOfRollup,
  makeSubprocessPrEffects,
  mapGhFault,
  metaOf,
  parseCreatedPr,
  parsePrList,
  reviewStateOfDecision,
  selectPrMatch,
} from '../../../src/ops/pr/ghEffects.js';
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
    '%s: importer resolves to an op; calling it returns the OpResult promise',
    async (name) => {
      // Resolving constructs makeSubprocessPrEffects — closure-only, inert:
      // execFile spawns only when an effect is CALLED, so resolution touches
      // no env, network, or filesystem. The op IS called, but with an input
      // that fails the boundary contract FIRST (repoRoot deleted — the first
      // field both ops' inputFaultOf checks), so the promise contract is
      // proven with ZERO gh calls: an Op invocation returns a thenable that
      // resolves to a `failed` OpResult — never a thrown error, never a
      // synchronous value. (The implementation-detail constructor name is
      // deliberately not asserted — the CONTRACT is the promise.)
      const op = (await entryByName(name).importer()) as (i: unknown) => Promise<unknown>;
      expect(typeof op).toBe('function');
      const badInput: Record<string, unknown> = { ...minimalInput(name) };
      delete badInput['repoRoot'];
      const pending = op(badInput);
      expect(typeof (pending as { then?: unknown }).then).toBe('function');
      const result = (await pending) as { status: string };
      expect(result.status).toBe('failed');
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

describe('parsePrList (gh pr list --json number,url,state)', () => {
  test('an empty fleet has no PR on the head', () => {
    expect(parsePrList('[]')).toEqual([]);
  });

  test('rows keep the number, the URL, and the lifecycle state (r1#7)', () => {
    expect(
      parsePrList(
        '[{"number":7,"url":"https://github.test/owner/repo/pull/7","state":"OPEN"},{"number":8,"state":"MERGED"},{"number":9,"state":"CLOSED"},{"number":10}]',
      ),
    ).toEqual([
      { number: 7, url: 'https://github.test/owner/repo/pull/7', state: 'open' },
      { number: 8, state: 'merged' },
      { number: 9, state: 'closed' },
      { number: 10, state: 'unknown' },
    ]);
  });

  test('a non-array payload and an out-of-contract number are untrustworthy (thrown, r2#5)', () => {
    expect(() => parsePrList('{"number":7}')).toThrow(/non-array payload/);
    expect(() => parsePrList('[{"url":"https://github.test/owner/repo/pull/7"}]')).toThrow(
      /positive-integer number/,
    );
    // A PR number is 1, 2, 3… — zero, negatives, and floats are all noise.
    expect(() => parsePrList('[{"number":0}]')).toThrow(/positive-integer number/);
    expect(() => parsePrList('[{"number":-3}]')).toThrow(/positive-integer number/);
    expect(() => parsePrList('[{"number":2.5}]')).toThrow(/positive-integer number/);
  });

  test('non-JSON output is a fault, never a guess', () => {
    expect(() => parsePrList('gh: (GitHub) API rate limit exceeded')).toThrow(/non-JSON output/);
  });
});

describe('selectPrMatch (the deterministic adoption pick, r1#4/I11)', () => {
  const row = (number: number, state: PrState): PrSearchResult => ({ number, state });

  test('no matches → null', () => {
    expect(selectPrMatch([])).toBeNull();
  });

  test('a single match passes through', () => {
    expect(selectPrMatch([row(5, 'open')])).toEqual(row(5, 'open'));
  });

  test('several matches prefer the OPEN PR, regardless of print order', () => {
    expect(selectPrMatch([row(3, 'closed'), row(9, 'open'), row(12, 'open')])).toEqual(
      row(9, 'open'),
    );
    expect(selectPrMatch([row(12, 'open'), row(9, 'open'), row(3, 'closed')])).toEqual(
      row(9, 'open'),
    );
  });

  test('no open match → the LOWEST number (the oldest, most canonical PR)', () => {
    expect(selectPrMatch([row(21, 'merged'), row(4, 'closed'), row(17, 'merged')])).toEqual(
      row(4, 'closed'),
    );
    expect(selectPrMatch([row(21, 'unknown'), row(17, 'unknown')])).toEqual(row(17, 'unknown'));
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
  test('the real words and null map onto the seam vocabulary', () => {
    expect(reviewStateOfDecision('APPROVED')).toEqual({ state: 'approved' });
    expect(reviewStateOfDecision('CHANGES_REQUESTED')).toEqual({ state: 'changes-requested' });
    expect(reviewStateOfDecision(null)).toEqual({ state: 'none' });
  });

  test('REVIEW_REQUIRED is `required`, NOT `none` — the r1#1 flip (a demanded-but-absent review is never ready)', () => {
    expect(reviewStateOfDecision('REVIEW_REQUIRED')).toEqual({ state: 'required' });
  });

  test('an unrecognized word is unknown — never a fabricated verdict', () => {
    expect(reviewStateOfDecision('REQUIRED')).toEqual({ state: 'unknown' });
    expect(reviewStateOfDecision(undefined)).toEqual({ state: 'unknown' });
  });
});

describe('metaOf (gh pr view --json isDraft,state,mergeable)', () => {
  test('the literal words map onto the seam vocabulary', () => {
    expect(metaOf({ isDraft: true, state: 'OPEN', mergeable: 'MERGEABLE' })).toEqual({
      isDraft: true,
      state: 'open',
      mergeable: 'mergeable',
    });
    expect(metaOf({ isDraft: false, state: 'MERGED', mergeable: 'CONFLICTING' })).toEqual({
      isDraft: false,
      state: 'merged',
      mergeable: 'conflicting',
    });
  });

  test('FAILS CLOSED on an unreadable isDraft (r2#3): a corrupt draft flag must never read as not-a-draft', () => {
    expect(() => metaOf({ isDraft: undefined, state: 'OPEN' })).toThrow(/unreadable isDraft/);
    expect(() => metaOf({ isDraft: 'maybe', state: 'OPEN' })).toThrow(/unreadable isDraft/);
    expect(() => metaOf({ state: 'OPEN' })).toThrow(/unreadable isDraft/);
  });

  test('an unrecognized lifecycle or mergeability word maps to unknown (r3 jMJpD)', () => {
    expect(metaOf({ isDraft: false, state: 'WHAT', mergeable: 'HUH' })).toEqual({
      isDraft: false,
      state: 'unknown',
      mergeable: 'unknown',
    });
    expect(metaOf({ isDraft: false })).toEqual({
      isDraft: false,
      state: 'unknown',
      mergeable: 'unknown',
    });
  });
});

describe('bodyOf (gh pr view --json body)', () => {
  test('a string body passes; a null or missing body is the empty string', () => {
    expect(bodyOf({ body: 'hello' })).toBe('hello');
    expect(bodyOf({ body: null })).toBe('');
    expect(bodyOf({})).toBe('');
  });

  test('a non-string non-null body is untrustworthy (thrown)', () => {
    expect(() => bodyOf({ body: 42 })).toThrow(/non-string body/);
  });
});

describe('composeSection (the tracker-body compose protocol, END markers per final jMrm3)', () => {
  const manifestSection = [
    MANIFEST_SECTION_MARKER,
    '# Fleet run',
    '- `core` — #11',
    MANIFEST_SECTION_END_MARKER,
  ].join('\n');
  const readinessSection = [
    READINESS_SECTION_MARKER,
    '# Merge readiness',
    '- `core` — READY',
    READINESS_SECTION_END_MARKER,
  ].join('\n');

  test('no existing body → the section alone', () => {
    expect(composeSection(undefined, manifestSection)).toBe(`${manifestSection}\n`);
    expect(composeSection('', readinessSection)).toBe(`${readinessSection}\n`);
  });

  test('a body without the marker → the section appended, existing content preserved', () => {
    expect(composeSection('Some prose.\n', manifestSection)).toBe(
      `Some prose.\n\n${manifestSection}\n`,
    );
  });

  test('an existing span → ONLY the span between START and ITS END is replaced', () => {
    const existing = [
      'Prose header.',
      MANIFEST_SECTION_MARKER,
      'STALE manifest line',
      MANIFEST_SECTION_END_MARKER,
      '',
      READINESS_SECTION_MARKER,
      'READINESS line',
      READINESS_SECTION_END_MARKER,
    ].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toContain('Prose header.');
    expect(composed).toContain(manifestSection); // the fresh span landed
    expect(composed).not.toContain('STALE manifest line');
    expect(composed).toContain('READINESS line'); // the sibling is untouched
  });

  test('USER PROSE BELOW the section survives a span replacement (final jMrm3)', () => {
    const existing = [
      MANIFEST_SECTION_MARKER,
      'STALE manifest line',
      MANIFEST_SECTION_END_MARKER,
      '',
      'User prose below the section.',
    ].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toContain(manifestSection);
    expect(composed).not.toContain('STALE manifest line');
    expect(composed).toContain('User prose below the section.');
  });

  test('USER PROSE BETWEEN the sections survives either writer', () => {
    const existing = [
      MANIFEST_SECTION_MARKER,
      'STALE manifest line',
      MANIFEST_SECTION_END_MARKER,
      'Prose between the sections.',
      READINESS_SECTION_MARKER,
      'READINESS line',
      READINESS_SECTION_END_MARKER,
    ].join('\n');
    const viaManifest = composeSection(existing, manifestSection);
    expect(viaManifest).toContain('Prose between the sections.');
    expect(viaManifest).not.toContain('STALE manifest line');
    const viaReadiness = composeSection(existing, readinessSection);
    expect(viaReadiness).toContain('Prose between the sections.');
    expect(viaReadiness).toContain(readinessSection);
  });

  test('a descriptive `<!-- cq-toolkit …` comment is CONTENT, never a terminator (r3)', () => {
    const existing = [
      MANIFEST_SECTION_MARKER,
      '<!-- cq-toolkit fleet-run manifest: runPrefix cq/09-16a (generated; updated in place, never duplicated) -->',
      'STALE manifest bullet',
      MANIFEST_SECTION_END_MARKER,
      '',
      READINESS_SECTION_MARKER,
      '<!-- cq-toolkit fleet-run report: runPrefix cq/09-16a (generated; merge-readiness, never auto-merges) -->',
      'READINESS line',
      READINESS_SECTION_END_MARKER,
    ].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toContain(manifestSection); // the span was replaced up to ITS end marker
    expect(composed).not.toContain('STALE manifest bullet');
    expect(composed).toContain(READINESS_SECTION_MARKER);
    expect(composed).toContain('READINESS line');
  });

  test('LEGACY bodies without END markers: the span owns the tail (migration path)', () => {
    const existing = [MANIFEST_SECTION_MARKER, 'STALE manifest line'].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toBe(`${manifestSection}\n`);
  });

  test('replacement works regardless of section order (readiness first, manifest last)', () => {
    const existing = [
      READINESS_SECTION_MARKER,
      'READINESS line',
      READINESS_SECTION_END_MARKER,
      '',
      MANIFEST_SECTION_MARKER,
      'STALE manifest line',
      MANIFEST_SECTION_END_MARKER,
    ].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toContain('READINESS line');
    expect(composed).toContain(manifestSection);
    expect(composed).not.toContain('STALE manifest line');
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

// ---------------------------------------------------------------------------
// The createPr body transport pin (cycle-1 fix): a PR body travels over
// STDIN (`--body-file -`), never argv — the same discipline as
// editPrBody/comment. Exercised through the REAL adapter against a fake
// `gh` shim on PATH that records its argv and stdin; hermetic (no network,
// writes stay under os.tmpdir()).
// ---------------------------------------------------------------------------

describe('createPr carries the body over stdin, never argv', () => {
  test('a create with a body sends --body-file - and the body on stdin', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-create-'));
    const binDir = join(scratch, 'bin');
    const repoDir = join(scratch, 'repo');
    const argsFile = join(scratch, 'argv');
    const stdinFile = join(scratch, 'stdin');
    await mkdir(binDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    // The shim records the argv and the stdin it was handed, then prints
    // the PR URL parseCreatedPr expects.
    await writeFile(
      join(binDir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${argsFile}'`,
        `cat > '${stdinFile}'`,
        'echo "https://github.test/owner/repo/pull/42"',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'gh'), 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
    try {
      const effects = makeSubprocessPrEffects(repoDir);
      const created = await effects.createPr({
        head: 'cq/09-16a/fix/core',
        base: 'origin/merge-queue',
        title: 'core fixes',
        body: 'manifest notes\nwith a newline',
        draft: true,
      });
      expect(created).toEqual({ number: 42, url: 'https://github.test/owner/repo/pull/42' });
      const argv = (await readFile(argsFile, 'utf8')).split('\n').filter((line) => line !== '');
      expect(argv).toContain('--body-file');
      expect(argv).toContain('-');
      expect(argv).not.toContain('--body');
      expect(argv).toContain('--draft');
      expect(await readFile(stdinFile, 'utf8')).toBe('manifest notes\nwith a newline');
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a create WITHOUT a body STILL sends --body-file - with EMPTY stdin (final jMrm0 reversal)', async () => {
    // Non-interactive gh (GH_PROMPT_DISABLED=1) requires title AND body —
    // a body-less create would prompt-fault the row. An absent request
    // body becomes an honest EMPTY body over stdin, never a fault.
    const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-create-'));
    const binDir = join(scratch, 'bin');
    const repoDir = join(scratch, 'repo');
    const argsFile = join(scratch, 'argv');
    const stdinFile = join(scratch, 'stdin');
    await mkdir(binDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(binDir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${argsFile}'`,
        `cat > '${stdinFile}'`,
        'echo "https://github.test/owner/repo/pull/7"',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'gh'), 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
    try {
      const effects = makeSubprocessPrEffects(repoDir);
      const created = await effects.createPr({
        head: 'cq/09-16a/fix/core',
        base: 'origin/merge-queue',
        title: 'core fixes',
        draft: false,
      });
      expect(created.number).toBe(7);
      const argv = (await readFile(argsFile, 'utf8')).split('\n').filter((line) => line !== '');
      expect(argv).toContain('--body-file');
      expect(argv).toContain('-');
      expect(argv).not.toContain('--body');
      expect(argv).not.toContain('--draft');
      expect(await readFile(stdinFile, 'utf8')).toBe('');
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('searchPrByHead argv pins (r1#3 + r1#4/I11)', () => {
  test('the search passes --base, and an explicit generous --limit (gh would default to 30)', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-list-'));
    const binDir = join(scratch, 'bin');
    const repoDir = join(scratch, 'repo');
    const argsFile = join(scratch, 'argv');
    await mkdir(binDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    // The list shim records argv and prints one row — it never reads stdin
    // (the search effect writes none, and a reading shim would block).
    await writeFile(
      join(binDir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${argsFile}'`,
        'echo \'[{"number":9,"state":"OPEN"}]\'',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'gh'), 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
    try {
      const effects = makeSubprocessPrEffects(repoDir);
      const hit = await effects.searchPrByHead('cq/09-16a/fix/core', 'origin/merge-queue');
      expect(hit).toEqual({ number: 9, state: 'open' });
      const argv = (await readFile(argsFile, 'utf8')).split('\n').filter((line) => line !== '');
      // The base is part of the PR identity (r1#2): it MUST reach the query.
      const baseIndex = argv.indexOf('--base');
      expect(baseIndex).toBeGreaterThan(-1);
      expect(argv[baseIndex + 1]).toBe('origin/merge-queue');
      const headIndex = argv.indexOf('--head');
      expect(argv[headIndex + 1]).toBe('cq/09-16a/fix/core');
      // The truncation guard (r1#4): the limit is EXPLICIT, never gh's 30.
      const limitIndex = argv.indexOf('--limit');
      expect(limitIndex).toBeGreaterThan(-1);
      expect(argv[limitIndex + 1]).toBe('200');
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
