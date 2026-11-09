// M10d: render the local monthly readout from already-computed panels. The
// fixtures compose the merged panel computers exactly like the real caller —
// computeMeasurementPanels with the reader's totals.availability passed as
// evidenceAvailability, and computeOutcomePanels — then render; the renderer
// itself computes nothing. One case per asserted condition, under each
// evidence regime (nominal, missing, failure):
//   - explicit UTC [start,end) 30-day window — stated in the report header
//     and in every panel section, and only a strict-Z, valid-calendar,
//     exactly-30-day window is accepted;
//   - deterministic JSON+Markdown — identical inputs render byte-identical
//     artifacts with a stable key order, and artifact references render
//     sorted and deduplicated;
//   - per-run numerator/denominator with unknown counts — one row per run,
//     and null figures render as unknown, never zero; a non-known numeric
//     total (zero attempts under unavailable) renders unknown and partial
//     keeps a labelled subtotal, and an unobserved channel set is stated,
//     never blank;
//   - no cross-run success ratio, no causal score — no aggregate ratio key
//     exists anywhere and the only ratio mention is the disclaimer;
//   - artifact references and all four panels readable — fix, cost, harm and
//     missed (plus population) render with their figures in both formats, the
//     JSON embeds the panels verbatim, channel pointers are looked up escaped,
//     merged unknown buckets dedupe and untrusted text renders inert;
//   - no live calls or engine writes — pure rendering only: the module's
//     imports are exactly the local-file set, no clock is read, no files are
//     written, the CLI entry is exercised as a real subprocess writing
//     exactly the two reports, and malformed inputs are refused rather than
//     rendered.
// Local fixtures only: in-memory rows in the merged shapes, no providers, no
// network, no bundle reads.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { importAcceptance } from '../scripts/measurement-acceptance.mjs';
import { computeMeasurementPanels } from '../scripts/measurement-metrics.mjs';
import type { MeasurementPanelRun } from '../scripts/measurement-metrics.mjs';
import { computeOutcomePanels } from '../scripts/measurement-outcomes.mjs';
import type { OutcomePanels } from '../scripts/measurement-outcomes.mjs';
import { renderMeasurementReport } from '../scripts/measurement-rollup.mjs';
import type { MeasurementReadoutInput, ReadoutWindow } from '../scripts/measurement-rollup.mjs';
import type {
  MeasurementInputRecord,
  MeasurementTotals,
  UnknownMeasurementInput,
} from '../scripts/measurement-inputs.mjs';
import type {
  AcceptancePayload,
  AvailabilityRecord,
  AvailabilityState,
  DispositionPayload,
  FindingFingerprint,
  ReviewObservedPayload,
} from '../src/kernel/types.js';

const WINDOW: ReadoutWindow = {
  start: '2026-10-02T00:00:00.000Z',
  end: '2026-11-01T00:00:00.000Z',
};
const SPAN = `[${WINDOW.start}, ${WINDOW.end})`;
const REPO = `sha256:${'a'.repeat(64)}`;
const RUN = 'run-1';
const RUN2 = 'run-2';
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);
const HEAD1 = 'b'.repeat(40);
const HEAD2 = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
const T1 = '2026-11-05T00:00:00.000Z';
const T2 = '2026-11-06T00:00:00.000Z';
const OBSERVED_AT = '2026-11-20T00:00:00.000Z';

const avail = (state: AvailabilityState, reason: string): AvailabilityRecord => ({
  state,
  reason,
  source: null,
});

function leaf(
  invocation: string,
  overrides: Partial<MeasurementInputRecord> = {},
): MeasurementInputRecord {
  return {
    tier: 'worker',
    invocation,
    model: { model: 'glm-5.3', provider: 'zai' },
    provider: 'zai',
    requestedModel: 'glm-5.3',
    servedModel: null,
    tokens: 10,
    usageChannels: {},
    requests: 1,
    wallMs: 1_000,
    modeledUsd: null,
    priceTableRevision: null,
    priceCoverage: null,
    stopReason: 'completed',
    stopCode: 'completed',
    class: 'terminal',
    error: null,
    timeout: null,
    budget: {
      allowed: { tokens: null, wallMs: null },
      spent: { tokens: 10, wallMs: 1_000 },
      remaining: { tokens: null, wallMs: null },
    },
    availability: {},
    repo: REPO,
    workId: '0f4d5a72-1f2e-4c3b-9a01-6f8b2c4d5e6f',
    runId: RUN,
    source: 'bundle:reports/w/r.json',
    ...overrides,
  };
}

const closure = (commitSha: string, todo = false) => ({
  commitSha,
  taskIds: ['task-1'],
  findingFingerprints: [],
  verificationEvidence: ['validation: pass'],
  todo,
});

const baseline = (unitId: string, count: number | null) => ({
  unitId,
  probeHead: count === null ? null : 'd'.repeat(40),
  completed: count !== null,
  count,
  unknownReason: count === null ? 'probe never ran' : null,
});

function makeRun(overrides: Partial<MeasurementPanelRun> = {}): MeasurementPanelRun {
  return {
    repo: REPO,
    runId: RUN,
    attempts: [],
    closures: [],
    baselineFailures: [],
    startedAt: '2026-10-05T04:00:00.000Z',
    endedAt: '2026-10-05T04:02:00.000Z',
    ...overrides,
  };
}

/** run-2 collects no closure evidence and carries a placeholder baseline unit. */
const runTwo = (): MeasurementPanelRun => ({
  repo: REPO,
  runId: RUN2,
  attempts: [leaf('inv-3', { runId: RUN2, wallMs: 15_000 })],
  baselineFailures: [baseline('unit-3', 2), baseline('unit-4', null)],
  startedAt: '2026-10-05T04:10:00.000Z',
  endedAt: '2026-10-05T04:12:00.000Z',
});

const nominalRuns = (): MeasurementPanelRun[] => [
  makeRun({
    attempts: [
      leaf('inv-1', { usageChannels: { input: 100 }, wallMs: 60_000 }),
      leaf('inv-2', { wallMs: 30_000 }),
    ],
    closures: [closure(SHA1), closure(SHA1), closure(SHA2, true), closure(SHA3)],
    baselineFailures: [baseline('unit-1', 3), baseline('unit-2', 4)],
    recordedNumerator: 2,
  }),
  runTwo(),
];

const F1: FindingFingerprint = {
  version: 1,
  checkId: 'oxlint',
  rule: 'no-unused-vars',
  path: 'src/one.ts',
  spanContentHash: null,
};

const disposition = (
  of: FindingFingerprint,
  observedHead: string,
  observedAt: string,
): DispositionPayload => ({
  fingerprint: of,
  status: 'fixed',
  reason: 'fix run verified the change',
  owner: 'fixer',
  evidence: ['re-fix run'],
  reviewTrigger: null,
  observedHead,
  observedAt,
  acceptedRisk: null,
  availability: {},
});

/** A covered review that observed F1 at its range. */
const coveredReview = (): ReviewObservedPayload => ({
  baseSha: BASE,
  headSha: HEAD1,
  findingFingerprints: [F1],
  coverage: 'v2:diff:patch',
  initialBlocking: null,
  reviewerId: 'reviewer',
  source: 'agent',
  round: 1,
  delivered: ['piece.ts'],
  completed: ['piece.ts'],
  omissions: [],
  vendorCompletion: 'completed',
  availability: {},
});

const acceptance = (over: Partial<AcceptancePayload> = {}): AcceptancePayload => ({
  headSha: HEAD1,
  reviewedBaseSha: BASE,
  reviewerId: 'critic',
  authorId: 'author',
  independent: true,
  verdict: 'PASS',
  evidence: ['exact-head review'],
  availability: {},
  ...over,
});

const nominalOutcomeArgs = () => ({
  reviews: [coveredReview()],
  dispositions: [disposition(F1, HEAD1, T1), disposition(F1, HEAD2, T2)],
  acceptances: [acceptance(), acceptance({ headSha: HEAD2 })],
  population: [
    { headSha: HEAD1, mergedAt: '2026-11-02T00:00:00.000Z' },
    { headSha: HEAD2, mergedAt: '2026-11-15T00:00:00.000Z' },
  ],
  ciRed: [{ sha: HEAD1, source: 'gha', classification: 'flake' }],
  ciObservedHeads: [HEAD1],
  followUpDays: 14,
  observedAt: OBSERVED_AT,
});

/** No outcome evidence at all: CI coverage is left undeclared. */
const emptyOutcomePanels = (): OutcomePanels =>
  computeOutcomePanels({
    reviews: [],
    dispositions: [],
    acceptances: [],
    population: [],
    ciRed: [],
    followUpDays: 14,
    observedAt: OBSERVED_AT,
  });

interface Reader {
  totals: MeasurementTotals;
  unknown: UnknownMeasurementInput[];
}

const knownReader = (): Reader => ({
  totals: {
    attempts: 3,
    tokens: 30,
    wallMs: 105_000,
    modeledUsd: null,
    availability: {
      '/attempts': avail('known', 'observed 3 attempts'),
      '/tokens': avail('known', 'observed 3 of 3 token values'),
      '/wallMs': avail('known', 'observed 3 of 3 wall values'),
      '/modeledUsd': avail('not-collected', 'no modeled USD value was observed'),
    },
  },
  unknown: [],
});

const emptyReader = (): Reader => ({
  totals: {
    attempts: 0,
    tokens: null,
    wallMs: null,
    modeledUsd: null,
    availability: {
      '/attempts': avail('known-zero', 'zero attempts observed'),
      '/tokens': avail('n-a', 'no token evidence was observed'),
      '/wallMs': avail('n-a', 'no wall evidence was observed'),
      '/modeledUsd': avail('n-a', 'no modeled USD evidence was observed'),
    },
  },
  unknown: [],
});

interface ComposeOptions {
  runs?: MeasurementPanelRun[];
  reader?: Reader;
  artifacts?: string[];
  window?: ReadoutWindow;
  outcome?: () => OutcomePanels;
}

/** The full readout input, composed exactly like the real caller. */
function input(options: ComposeOptions = {}): MeasurementReadoutInput {
  const reader = options.reader ?? knownReader();
  return {
    window: options.window ?? WINDOW,
    artifacts: options.artifacts ?? ['bundles/run-a', 'bundles/run-b'],
    measurement: computeMeasurementPanels({
      runs: options.runs ?? nominalRuns(),
      unknown: reader.unknown,
      evidenceAvailability: reader.totals.availability,
    }),
    outcome: options.outcome ? options.outcome() : computeOutcomePanels(nominalOutcomeArgs()),
    reader,
  };
}

const runCli = promisify(execFile);

/** Malformed overrides over an otherwise valid input: runtime shape guards. */
function malformed(overrides: Record<string, unknown>) {
  return renderMeasurementReport({
    ...input(),
    ...(overrides as object),
  } as MeasurementReadoutInput);
}

const compose = (options: ComposeOptions = {}) => renderMeasurementReport(input(options));

/** Every key in a nested structure, for aggregate-field scans. */
const keys = (value: unknown): string[] =>
  value !== null && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, nested]) => [key, ...keys(nested)])
    : [];

const ratioMentions = (markdown: string) =>
  markdown.split('\n').filter((line) => /ratio|causal|score/i.test(line));

describe('M10d nominal evidence', () => {
  test('explicit UTC [start,end) 30-day window', () => {
    const rendered = compose();
    expect(rendered.report.window).toEqual({
      start: WINDOW.start,
      end: WINDOW.end,
      days: 30,
    });
    const parsed = JSON.parse(rendered.json) as { window: unknown };
    expect(parsed.window).toEqual({
      start: WINDOW.start,
      end: WINDOW.end,
      days: 30,
    });
    expect(rendered.markdown).toContain(`- window: ${SPAN} — 30 days, UTC (explicit [start,end))`);
    for (const section of [
      'Fix panel',
      'Cost panel',
      'Harm panel',
      'Missed panel',
      'Population panel',
    ])
      expect(rendered.markdown).toContain(`## ${section} — window ${SPAN}`);
  });

  test('deterministic JSON+Markdown', () => {
    const first = compose();
    const second = compose();
    expect(second.json).toBe(first.json);
    expect(second.markdown).toBe(first.markdown);
    // Stable key order: the serialization round-trips onto itself.
    expect(first.json).toBe(JSON.stringify(JSON.parse(first.json), null, 2));
    // Artifact references render sorted and deduplicated whatever their order.
    const shuffled = compose({
      artifacts: ['bundles/run-b', 'bundles/run-a', 'bundles/run-b'],
    });
    expect(shuffled.report.artifacts).toEqual(['bundles/run-a', 'bundles/run-b']);
    expect(shuffled.json).toBe(first.json);
    expect(shuffled.markdown).toBe(first.markdown);
  });

  test('per-run numerator/denominator with unknown counts', () => {
    const rendered = compose();
    expect(rendered.report.panels.fix.runs).toHaveLength(2);
    const [one, two] = rendered.report.panels.fix.runs;
    expect(one?.fixesPerRun).toEqual({ numerator: 2, denominator: 7 });
    expect(one?.verifiedCommits).toEqual([SHA1, SHA3]);
    // run-2 collected no closure evidence and holds a placeholder baseline
    // unit: both figures stay unknown, never zero.
    expect(two?.fixesPerRun).toEqual({ numerator: null, denominator: null });
    expect(rendered.markdown).toContain(`| ${REPO} | ${RUN} | 2 | 7 | ${SHA1}, ${SHA3} |`);
    expect(rendered.markdown).toContain(`| ${REPO} | ${RUN2} | unknown | unknown | - |`);
    // The cost and reader figures render beside their availability states.
    expect(rendered.markdown).toContain('- usage channel input: 100 (known)');
    expect(rendered.markdown).toContain('- attempt wall (ms): 105000 (known)');
    expect(rendered.markdown).toContain('- run elapsed (ms): 240000 (known)');
    expect(rendered.markdown).toContain('- attempts: 3 (known)');
    expect(rendered.markdown).toContain(
      '- modeled USD: unknown (unavailable: no modeled USD value was observed',
    );
    // A channel name carrying the pointer metacharacters is looked up through
    // its escaped pointer: exactly that channel degrades to a labelled
    // subtotal, the sibling channel stays known, and an unescaped lookup
    // would render it as unstated.
    const torn = compose({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-1', {
              usageChannels: { input: 100, 'cache~read/x': 5 },
              availability: { '/usageChannels/cache~0read~1x': avail('partial', 'settled late') },
            }),
          ],
        }),
      ],
    });
    expect(torn.markdown).toContain(
      '- usage channel cache~read/x: 5 subtotal (partial: observed 1 of 1 usage channel cache~read/x values; measurement inputs were rejected, incomplete or unavailable)',
    );
    expect(torn.markdown).toContain('- usage channel input: 100 (known)');
  });

  test('no cross-run success ratio, no causal score', () => {
    const rendered = compose();
    // No aggregate ratio, rate or score key exists anywhere in the report.
    expect(
      keys(rendered.report).filter((key) => /ratio|rate|score|average|avg/i.test(key)),
    ).toEqual([]);
    // The only ratio/causal mention in the Markdown is the disclaimer itself.
    expect(ratioMentions(rendered.markdown)).toEqual([
      '- per-run figures only: no cross-run success ratio, no causal score',
    ]);
    // The fix table is exactly one row per run: no totals row, no combined figure.
    expect(rendered.markdown.match(/^\| /gm)).toHaveLength(4);
    expect(rendered.markdown).not.toContain('2/7');
    expect(rendered.markdown).not.toContain('0.29');
  });

  test('artifact references and all four panels readable', () => {
    const rendered = compose({ artifacts: ['bundles/run-b', 'bundles/run-a'] });
    expect(rendered.report.artifacts).toEqual(['bundles/run-a', 'bundles/run-b']);
    for (const key of ['fix', 'cost', 'harm', 'missed', 'population'])
      expect(rendered.report.panels).toHaveProperty(key);
    // The JSON embeds the composed panels verbatim — the "recomputes
    // nothing" contract, by reference and byte-for-byte.
    const composed = input();
    const verbatim = renderMeasurementReport(composed);
    expect(verbatim.report.panels).toEqual({
      fix: composed.measurement.fix,
      cost: composed.measurement.cost,
      harm: composed.outcome.harm,
      missed: composed.outcome.missed,
      population: composed.outcome.population,
    });
    expect(rendered.markdown).toContain('## Evidence artifacts');
    expect(rendered.markdown).toContain('- bundles/run-a');
    expect(rendered.markdown).toContain('- bundles/run-b');
    for (const section of ['## Fix panel', '## Cost panel', '## Harm panel', '## Missed panel'])
      expect(rendered.markdown).toContain(section);
    expect(rendered.markdown).toContain('- re-fixes: 1 candidates, 0 explained, 0 unknown');
    expect(rendered.markdown).toContain(
      '- CI red: flake 1, regression 0, infrastructure 0, unknown 0',
    );
    expect(rendered.markdown).toContain(
      `- CI red coverage: 1 heads examined; 1 eligible heads unexamined (${HEAD2})`,
    );
    expect(rendered.markdown).toContain(
      '- restored crq findings: 0 missed, 0 not missed, 0 unknown',
    );
    expect(rendered.markdown).toContain(
      '- eligible: 2; mature: 1; right-censored: 1; follow-up window: 14 days',
    );
  });

  test('no live calls or engine writes', async () => {
    const source = await readFile('scripts/measurement-rollup.mjs', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    // Local files, paths and URLs only: no network, no engine modules.
    expect([...imports].sort()).toEqual(['node:fs/promises', 'node:path', 'node:url']);
    for (const forbidden of [
      'fetch(',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:dgram',
      'child_process',
      'XMLHttpRequest',
      'WebSocket',
      '../src/',
      '../dist/',
    ])
      expect(source).not.toContain(forbidden);
    // No clock or randomness: determinism is never seeded by wall time.
    expect(source).not.toMatch(/Date\.now|Math\.random/);
  });
});

describe('M10d missing evidence', () => {
  // No evidence at all was collected: empty panels and reader, no CI coverage
  // declared, no artifacts referenced.
  const empty = () =>
    compose({
      runs: [],
      outcome: emptyOutcomePanels,
      reader: emptyReader(),
      artifacts: [],
    });

  test('explicit UTC [start,end) 30-day window', () => {
    const rendered = empty();
    expect(rendered.report.window).toEqual({
      start: WINDOW.start,
      end: WINDOW.end,
      days: 30,
    });
    // The window is still stated on every panel section over empty evidence.
    for (const section of ['Fix panel', 'Cost panel', 'Harm panel', 'Missed panel'])
      expect(rendered.markdown).toContain(`## ${section} — window ${SPAN}`);
    // A readout with no window stated is refused, never guessed.
    expect(() => malformed({ window: undefined })).toThrow(TypeError);
  });

  test('deterministic JSON+Markdown', () => {
    const first = empty();
    const second = empty();
    expect(second.json).toBe(first.json);
    expect(second.markdown).toBe(first.markdown);
    expect(first.json).toBe(JSON.stringify(JSON.parse(first.json), null, 2));
    // Missing artifact references render explicitly absent, never silently.
    expect(first.markdown).toContain('## Evidence artifacts');
    expect(first.markdown).toContain('- (none)');
    expect(first.report.artifacts).toEqual([]);
  });

  test('per-run numerator/denominator with unknown counts', () => {
    const rendered = empty();
    expect(rendered.report.panels.fix.runs).toEqual([]);
    // No runs observed: the table header stands alone with no data row.
    expect(rendered.markdown.match(/^\| /gm)).toHaveLength(2);
    // Unexamined CI renders unknown counts, never zero.
    expect(rendered.markdown).toContain(
      '- CI red: flake unknown, regression unknown, infrastructure unknown, unknown unknown',
    );
    expect(rendered.markdown).toContain(
      '- CI red coverage: not examined — counts are unknown, never zero',
    );
    expect(rendered.markdown).toContain('- tokens: unknown (n-a: no token evidence was observed)');
    // An unobserved usage-channel set is stated through its umbrella
    // availability entry, never silently blank.
    expect(rendered.markdown).toContain(
      '- usage channels: unknown (n-a: no usage channel evidence was observed)',
    );
  });

  test('no cross-run success ratio, no causal score', () => {
    const rendered = empty();
    expect(
      keys(rendered.report).filter((key) => /ratio|rate|score|average|avg/i.test(key)),
    ).toEqual([]);
    // The fix panel stays a per-run list: nothing aggregates empty into a rate.
    expect(Object.keys(rendered.report.panels.fix)).toEqual(['runs']);
    expect(ratioMentions(rendered.markdown)).toEqual([
      '- per-run figures only: no cross-run success ratio, no causal score',
    ]);
  });

  test('artifact references and all four panels readable', () => {
    const rendered = empty();
    for (const key of ['fix', 'cost', 'harm', 'missed', 'population'])
      expect(rendered.report.panels).toHaveProperty(key);
    // The absent CI coverage is carried as unknown evidence with a reason.
    expect(rendered.report.unknown).toEqual([
      { source: 'ciRed', kind: 'unavailable', reason: 'no CI coverage declared' },
    ]);
    expect(rendered.markdown).toContain('- ciRed — unavailable: no CI coverage declared');
  });

  test('no live calls or engine writes', () => {
    const rendered = empty();
    // The readout carries no generation stamp: no clock was consulted.
    expect(keys(rendered.report)).not.toContain('generatedAt');
    expect(rendered.markdown).not.toMatch(/generated|timestamp/i);
  });
});

describe('M10d failure evidence', () => {
  test('explicit UTC [start,end) 30-day window', () => {
    const over = (window: ReadoutWindow) => renderMeasurementReport({ ...input(), window });
    // Only the strict UTC Z form is a stamp: an offset form would be read
    // outside UTC, and a fraction-less stamp is not the report instant form.
    expect(() => over({ start: '2026-10-02T00:00:00+00:00', end: WINDOW.end })).toThrow(TypeError);
    expect(() => over({ start: '2026-10-02T00:00:00.000', end: WINDOW.end })).toThrow(TypeError);
    // A normalised calendar part is an invalid stamp, never the day it rolls
    // into (Feb 30), and hour 24 rolls to the next day: both are refused.
    expect(() =>
      over({ start: '2026-02-30T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' }),
    ).toThrow(TypeError);
    expect(() =>
      over({ start: '2026-10-02T24:00:00.000Z', end: '2026-11-01T00:00:00.000Z' }),
    ).toThrow(TypeError);
    // Inverted and same-instant windows are refused.
    expect(() =>
      over({ start: '2026-11-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' }),
    ).toThrow(TypeError);
    expect(() => over({ start: WINDOW.start, end: WINDOW.start })).toThrow(TypeError);
    // The stated window is exactly 30 days: a 29-day window is refused, and
    // so is one millisecond more — while exactly 30 days at another instant
    // is accepted.
    expect(() =>
      renderMeasurementReport({
        ...input(),
        window: { start: WINDOW.start, end: '2026-10-31T00:00:00.000Z' },
      }),
    ).toThrow(/window must span exactly 30 days/);
    expect(() =>
      renderMeasurementReport({
        ...input(),
        window: { start: WINDOW.start, end: '2026-11-01T00:00:00.001Z' },
      }),
    ).toThrow(/window must span exactly 30 days/);
    expect(() =>
      renderMeasurementReport({
        ...input(),
        window: { start: '2026-10-03T00:00:00.000Z', end: '2026-11-02T00:00:00.000Z' },
      }),
    ).not.toThrow();
  });

  test('deterministic JSON+Markdown', () => {
    // Degraded panels still render deterministically.
    const conflicted = () =>
      compose({
        runs: [
          makeRun({ startedAt: '2026-10-05T04:00:00.000Z' }),
          makeRun({ startedAt: '2026-10-05T05:00:00.000Z' }),
        ],
      });
    const first = conflicted();
    expect(conflicted().json).toBe(first.json);
    expect(conflicted().markdown).toBe(first.markdown);
  });

  test('per-run numerator/denominator with unknown counts', () => {
    // Two disagreeing copies of one run identity conflict: one unknown row,
    // never a silent pick.
    const conflicted = compose({
      runs: [
        makeRun({ startedAt: '2026-10-05T04:00:00.000Z' }),
        makeRun({ startedAt: '2026-10-05T05:00:00.000Z' }),
      ],
    });
    expect(conflicted.report.panels.fix.runs).toHaveLength(1);
    expect(conflicted.report.panels.fix.runs[0]?.fixesPerRun).toEqual({
      numerator: null,
      denominator: null,
    });
    expect(conflicted.markdown).toContain(`| ${REPO} | ${RUN} | unknown | unknown | - |`);
    expect(conflicted.markdown).toContain('- run elapsed (ms): unknown (unavailable:');
    // Disagreeing copies of one invocation contribute nothing.
    const conflictedLeaves = compose({
      runs: [
        makeRun({
          attempts: [
            leaf('inv-1', { usageChannels: { input: 100 }, wallMs: 1_000 }),
            leaf('inv-1', { usageChannels: { input: 300 }, wallMs: 2_000 }),
          ],
        }),
      ],
    });
    expect(conflictedLeaves.markdown).not.toContain('- usage channel input:');
    expect(conflictedLeaves.markdown).toContain('- attempt wall (ms): unknown (unavailable:');
    // A corrupt CI coverage declaration leaves the counts unknown, never zero.
    const corruptCoverage = compose({
      outcome: () =>
        computeOutcomePanels({ ...nominalOutcomeArgs(), ciObservedHeads: ['not-a-sha'] }),
    });
    expect(corruptCoverage.markdown).toContain(
      '- CI red: flake unknown, regression unknown, infrastructure unknown, unknown unknown',
    );
    expect(corruptCoverage.report.unknown).toContainEqual({
      source: 'ciObservedHeads[0]',
      kind: 'corrupt',
      reason: 'examined head is not a sha',
    });
    // A non-known numeric total never renders its stored number: zero
    // attempts under unavailable render unknown, and a partial total keeps
    // an explicitly labelled subtotal.
    const degraded = compose({
      reader: {
        totals: {
          attempts: 0,
          tokens: 20,
          wallMs: 1000,
          modeledUsd: null,
          availability: {
            '/attempts': avail('unavailable', 'no attempt was observed'),
            '/tokens': avail('partial', 'observed 2 of 3 token values'),
            '/wallMs': avail('known', 'observed 2 of 2 wall values'),
            '/modeledUsd': avail('not-collected', 'no modeled USD value was observed'),
          },
        },
        unknown: [],
      },
    });
    expect(degraded.markdown).toContain(
      '- attempts: unknown (unavailable: no attempt was observed)',
    );
    expect(degraded.markdown).toContain(
      '- tokens: 20 subtotal (partial: observed 2 of 3 token values)',
    );
    // Cost totals keep the same rule: a partially observed attempt wall is a
    // labelled subtotal, never a plain known-looking number.
    const partialWall = compose({
      runs: [
        makeRun({
          attempts: [leaf('inv-1', { wallMs: 1_000 }), leaf('inv-2', { wallMs: null })],
        }),
      ],
    });
    expect(partialWall.markdown).toContain(
      '- attempt wall (ms): 1000 subtotal (partial: observed 1 of 2 wall values)',
    );
  });

  test('no cross-run success ratio, no causal score', () => {
    const rendered = compose({
      runs: [
        makeRun({
          closures: [closure(SHA1)],
          baselineFailures: [baseline('unit-1', 2)],
          recordedNumerator: 1,
        }),
        {
          ...runTwo(),
          closures: [closure(SHA3), closure(SHA3)],
          baselineFailures: [baseline('unit-5', 4)],
          recordedNumerator: 1,
        },
      ],
    });
    // Two fully known runs (1/2 and 1/4) are exactly the temptation: the
    // report still carries no combined figure.
    expect(rendered.report.panels.fix.runs).toHaveLength(2);
    expect(rendered.report.panels.fix.runs[0]?.fixesPerRun).toEqual({
      numerator: 1,
      denominator: 2,
    });
    expect(rendered.report.panels.fix.runs[1]?.fixesPerRun).toEqual({
      numerator: 1,
      denominator: 4,
    });
    expect(
      keys(rendered.report).filter((key) => /ratio|rate|score|average|avg/i.test(key)),
    ).toEqual([]);
    expect(rendered.markdown).not.toContain('2/6');
    expect(rendered.markdown).not.toContain('0.33');
    expect(rendered.markdown.match(/^\| /gm)).toHaveLength(4);
  });

  test('artifact references and all four panels readable', () => {
    // Malformed references are refused rather than rendered.
    expect(() => compose({ artifacts: ['bundles/run-a', ''] })).toThrow(TypeError);
    // @ts-expect-error runtime shape guard: artifacts must be an array
    expect(() => compose({ artifacts: 'bundles/run-a' })).toThrow(TypeError);
    // Malformed panels and reader totals are refused, never rendered as
    // fabricated unknowns.
    expect(() => malformed({ measurement: { fix: {}, cost: {} } })).toThrow(TypeError);
    expect(() =>
      malformed({ outcome: { harm: {}, missed: {}, population: {}, unknown: [] } }),
    ).toThrow(TypeError);
    expect(() => malformed({ reader: { unknown: [] } })).toThrow(TypeError);
    // A fix row without its figures is corrupt input, never a rendered unknown.
    expect(() =>
      malformed({
        measurement: {
          fix: { runs: [{ repo: REPO, runId: RUN, verifiedCommits: [] }] },
          cost: input().measurement.cost,
        },
      }),
    ).toThrow(TypeError);
    const badUnknownRow = { source: 'x', kind: 3, reason: 'y' } as unknown as {
      source: string;
      kind: string;
      reason: string;
    };
    expect(() => malformed({ outcome: { ...input().outcome, unknown: [badUnknownRow] } })).toThrow(
      TypeError,
    );
    // Nested corrupt figures are refused, never rendered: string counts, a
    // non-sha examined-head list and non-sha verified commits.
    const panels = input();
    expect(() =>
      malformed({
        outcome: {
          ...panels.outcome,
          harm: {
            ...panels.outcome.harm,
            ciRed: { ...panels.outcome.harm.ciRed, flake: '3' },
          },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      malformed({
        outcome: {
          ...panels.outcome,
          harm: {
            ...panels.outcome.harm,
            refix: { candidates: 'x', explained: 0, unknown: 0 },
          },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      malformed({
        outcome: {
          ...panels.outcome,
          harm: {
            ...panels.outcome.harm,
            ciRed: { ...panels.outcome.harm.ciRed, observedHeads: 'abc' },
          },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      malformed({
        measurement: {
          ...panels.measurement,
          fix: {
            runs: [
              {
                repo: REPO,
                runId: RUN,
                fixesPerRun: { numerator: 1, denominator: 2 },
                verifiedCommits: ['not-a-sha'],
              },
            ],
          },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      malformed({
        reader: { totals: { ...knownReader().totals, attempts: 'three' }, unknown: [] },
      }),
    ).toThrow(TypeError);
    // An identical unknown row in both buckets renders once, like duplicate
    // artifact references.
    const echoed = renderMeasurementReport(
      input({
        outcome: emptyOutcomePanels,
        reader: {
          ...emptyReader(),
          unknown: [{ source: 'ciRed', kind: 'unavailable', reason: 'no CI coverage declared' }],
        },
      }),
    );
    expect(echoed.report.unknown).toEqual([
      { source: 'ciRed', kind: 'unavailable', reason: 'no CI coverage declared' },
    ]);
    expect(echoed.markdown.match(/- ciRed — unavailable: no CI coverage declared/g)).toHaveLength(
      1,
    );
    // Untrusted text renders inert: pipes escape in cells and bullets, and a
    // line break in an unknown reason collapses instead of injecting a line.
    const escaped = compose({
      artifacts: ['bundles/run|a', 'bundles/run-b'],
      runs: [makeRun({ runId: 'run|1' })],
    });
    expect(escaped.markdown).toContain('- bundles/run\\|a');
    expect(escaped.markdown).toContain(`| ${REPO} | run\\|1 |`);
    const multiline = renderMeasurementReport(
      input({
        reader: {
          ...knownReader(),
          unknown: [{ source: 'bundle:x.json', kind: 'corrupt', reason: 'line one\nline two' }],
        },
      }),
    );
    expect(multiline.markdown).toContain('- bundle:x.json — corrupt: line one line two');
    expect(multiline.markdown).not.toContain('line one\nline two');
    // Minimal but valid panels still render.
    expect(() =>
      renderMeasurementReport({
        window: WINDOW,
        artifacts: [],
        measurement: computeMeasurementPanels({
          runs: [{ repo: REPO, runId: RUN, attempts: [], startedAt: null, endedAt: null }],
          unknown: [],
          evidenceAvailability: {},
        }),
        outcome: emptyOutcomePanels(),
        reader: knownReader(),
      }),
    ).not.toThrow();
  });

  test('no live calls or engine writes', async () => {
    // Rendering writes nothing: an empty directory stays empty beside a
    // successful render.
    const dir = await mkdtemp(join(tmpdir(), 'm10d-rollup-'));
    expect(compose().report).toBeDefined();
    expect(await readdir(dir)).toEqual([]);
    // The CLI entry is the documented path to the readout: a real subprocess
    // writes exactly the two reports over explicit local paths and exits 0,
    // and a missing input file exits 1 (thrown error), writing nothing.
    const cliDir = await mkdtemp(join(tmpdir(), 'm10d-cli-'));
    const inputPath = join(cliDir, 'readout-input.json');
    await writeFile(inputPath, JSON.stringify(input()));
    const out = join(cliDir, 'out');
    const done = await runCli(process.execPath, [
      resolve('scripts', 'measurement-rollup.mjs'),
      '--input',
      inputPath,
      '--out',
      out,
    ]);
    expect((await readdir(out)).sort()).toEqual([
      'measurement-readout.json',
      'measurement-readout.md',
    ]);
    const written = JSON.parse(await readFile(join(out, 'measurement-readout.json'), 'utf8')) as {
      window: { days: number };
    };
    expect(written.window.days).toBe(30);
    expect(await readFile(join(out, 'measurement-readout.md'), 'utf8')).toContain(
      '# cq-toolkit monthly measurement readout',
    );
    expect(done.stdout.trim()).toBe(
      JSON.stringify({
        json: join(out, 'measurement-readout.json'),
        markdown: join(out, 'measurement-readout.md'),
      }),
    );
    let failure: { code?: number; stdout?: string; stderr?: string } = {};
    try {
      await runCli(process.execPath, [
        resolve('scripts', 'measurement-rollup.mjs'),
        '--input',
        join(cliDir, 'absent.json'),
        '--out',
        join(cliDir, 'bad'),
      ]);
    } catch (error) {
      failure = error as { code?: number; stdout?: string; stderr?: string };
    }
    // I1: the machine-readable error object goes to stdout (one JSON
    // artifact) and the human narration to stderr — never the reverse.
    expect(failure.code).toBe(1);
    const failureReport = JSON.parse(failure.stdout ?? '{}') as { error: { message: string } };
    expect(failureReport.error.message).toContain('ENOENT');
    expect(failure.stderr).toContain('ENOENT');
    expect((failure.stderr ?? '').trim().startsWith('{')).toBe(false);
    // A missing --input is an argument error: exit code 2 (I1), with the
    // usage narration on stderr.
    let usage: { code?: number; stdout?: string; stderr?: string } = {};
    try {
      await runCli(process.execPath, [resolve('scripts', 'measurement-rollup.mjs')]);
    } catch (error) {
      usage = error as { code?: number; stdout?: string; stderr?: string };
    }
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('usage: node scripts/measurement-rollup.mjs --input');
    // Only the input file and the out directory exist: nothing else was
    // written, and the failed run created nothing.
    expect((await readdir(cliDir)).sort()).toEqual(['out', 'readout-input.json']);
    const source = await readFile('scripts/measurement-rollup.mjs', 'utf8');
    // File writes exist only in the CLI entry block, after the pure renderer.
    expect(source.indexOf('export function renderMeasurementReport')).toBeLessThan(
      source.indexOf('writeFile('),
    );
  });
});

describe('M4b1 acceptance import composed into the M10d readout', () => {
  test('importAcceptance feeds computeOutcomePanels; a missing base renders unknown, never 0', () => {
    // A small SYNTHETIC snapshot — hand-built for this test, never a recorded
    // capture; docs/measurement/import-acceptance.md is the real recipe.
    const reviewUrl = 'https://github.com/synthetic/synthetic/issues/comments/11';
    const missingBaseUrl = 'https://github.com/synthetic/synthetic/issues/comments/12';
    const acceptanceComment = (id: number, url: string, headSha: string) => ({
      id,
      html_url: url,
      created_at: '2026-11-05T00:00:00Z',
      updated_at: '2026-11-05T00:00:00Z',
      user: { login: 'synthetic-author' },
      body: `**Independent review (critic): PASS for \`${headSha}\`**`,
    });
    const syntheticSnapshot = {
      repo: 'synthetic/synthetic',
      pr_number: 1,
      fetched_at: '2026-11-05T00:00:00Z',
      pr: { user: { login: 'synthetic-author' } },
      comments: [
        acceptanceComment(11, reviewUrl, HEAD1),
        // HEAD2 has no recorded base: an importer unknown, never a row.
        acceptanceComment(12, missingBaseUrl, HEAD2),
      ],
      reviews: [],
      bases: { [HEAD1]: BASE },
      complete: true,
    };
    const imported = importAcceptance(syntheticSnapshot);
    // The one row is a self-declared reader artifact: reviewerId says so and
    // /independent records the header as the only basis — never an authority.
    expect(imported.acceptances).toEqual([
      {
        headSha: HEAD1,
        reviewedBaseSha: BASE,
        reviewerId: 'self-declared:critic',
        authorId: 'github:synthetic-author',
        independent: true,
        verdict: 'PASS',
        evidence: [reviewUrl],
        availability: {
          '/independent': {
            state: 'known',
            reason:
              'self-declared in review comment header; reviewer identity not verified (shared GitHub account)',
            source: reviewUrl,
          },
        },
      },
    ]);
    expect(imported.unknown).toEqual([
      { source: missingBaseUrl, kind: 'unavailable', reason: 'reviewed base not recorded' },
    ]);
    // Compose exactly like the real caller (docs/measurement.md Composition):
    // the importer's acceptances feed computeOutcomePanels, and the CALLER
    // merges its unknown rows into the outcome bucket before rendering —
    // never dropped.
    const panels = computeOutcomePanels({
      reviews: [],
      dispositions: [],
      acceptances: imported.acceptances,
      population: [{ headSha: HEAD1, mergedAt: '2026-11-02T00:00:00.000Z' }],
      ciRed: [],
      ciObservedHeads: [],
      followUpDays: 14,
      observedAt: OBSERVED_AT,
    });
    const rendered = renderMeasurementReport(
      input({ outcome: () => ({ ...panels, unknown: [...panels.unknown, ...imported.unknown] }) }),
    );
    // The PASS head renders eligible in the population panel (merged 18 days
    // before the observation instant: mature, not right-censored).
    expect(rendered.report.panels.population).toEqual({
      eligible: 1,
      mature: 1,
      rightCensored: 0,
      followUpDays: 14,
    });
    expect(rendered.markdown).toContain(
      '- eligible: 1; mature: 1; right-censored: 0; follow-up window: 14 days',
    );
    // The importer unknown renders as an unknown row of its own, not as a
    // silent 0: it is the readout's single unknown-evidence entry.
    expect(rendered.report.unknown).toEqual([
      { source: missingBaseUrl, kind: 'unavailable', reason: 'reviewed base not recorded' },
    ]);
    expect(rendered.markdown).toContain(
      `- ${missingBaseUrl} — unavailable: reviewed base not recorded`,
    );
  });
});
