// Lane H slice 3 (goal H3, ws-h scope item 7) — tests for
// proposeBaselineUpdate (src/ops/ratchet/proposeBaselineUpdate.ts).
//
// Pinned here:
//   1. The ONE-PR rule: a mixed batch of tightenings groups into exactly one
//      PR whose files carry the byte-deterministic renderBaseline output of
//      each rebuilt baseline (direction/unit from the committed baseline,
//      capturedAt from the improvement or the clock), and the op NEVER
//      writes to the workspace — the effects seam commits.
//   2. Idempotency: the head branch is a 12-hex (48-bit) digest over the
//      sorted (target, metric) pairs — the same improvement set in any order
//      computes the same head and hits findOpenPrByHead on re-run → proposal
//      'updated' with the UPSERT result's authoritative PR identity (a found
//      PR closed between find and upsert makes the impl's fresh creation the
//      truth; a no-identity upsert falls back to the find result) — still
//      exactly one PR, no second create; a different set gets a different
//      head.
//   2b. Duplicate (target, metric) improvements collapse LAST-WINS before
//       the tighten gate: a later looser reading supersedes an earlier
//       tightening (metric dropped), a later tightening after a looser
//       entry still proposes, and the last tightened value wins.
//   3. The skip paths (I5 — never fabricate): looser/equal ('not a
//      tightening', with the direction read from the committed baseline),
//      missing/corrupt baseline ('no usable baseline — refusing to propose
//      from nothing'), non-regular leaf (mirror of checkRatchet), baselines
//      dir escaping the ws (containment), identity disagreement — each
//      skipped with a reason while remaining usable improvements still
//      propose.
//   4. Input validation: null input, non-string ws/base, non-finite
//      improvement value, non-array/malformed improvements, non-string
//      target/metric, non-ISO capturedAt, and a headPrefix that would not
//      form a valid git ref → failed verdicts with arg-error wording; the
//      op input is plain data (structuredClone-safe); an empty improvements
//      list is the zero fast path with zero effects calls. The PR body
//      renders identity fields markdown-inert (backticks/newlines stripped).
//   5. Effect-fault containment: a findOpenPrByHead rejection → failed
//      (nothing happened); a commitAndUpsertPr rejection → indeterminate
//      (the commit may or may not have landed); no throw crosses the op
//      seam. DEFAULT_PR_TOKEN is the CQ_AUTOMATION_TOKEN doctrine marker.
//
// The effects seam is faked in-memory (Map keyed by head, recording every
// call); the real gh-backed implementation lands in H4.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { baselineRelPath, parseBaseline, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile, Direction } from '../../../src/ops/ratchet/format.js';
import {
  createProposeBaselineUpdate,
  DEFAULT_PR_TOKEN,
} from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import type {
  BaselinePrEffects,
  ProposeInput,
} from '../../../src/ops/ratchet/proposeBaselineUpdate.js';

const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
const BASELINE_CAPTURED_AT = '2026-09-14T00:00:00.000Z';
const TARGET = 'typecheck';
const METRIC = 'typecheck-count';
const REL = baselineRelPath(TARGET, METRIC);

let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-propose-'));
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

/** A recorded PR plus the exact upsert payload that last produced it. */
interface FakePr {
  number: number;
  url: string;
  head: string;
  base: string;
  title: string;
  body: string;
  commitMessage: string;
  files: Array<{ path: string; content: string }>;
}

/**
 * In-memory effects seam: PRs keyed by head (one PR per head — the forge's
 * own rule the real gh impl relies on), every call counted.
 */
function makeFakeEffects(): BaselinePrEffects & {
  prs: Map<string, FakePr>;
  findCalls(): number;
  upsertCalls(): number;
} {
  const prs = new Map<string, FakePr>();
  let counter = 0;
  let finds = 0;
  let upserts = 0;
  return {
    prs,
    findCalls: () => finds,
    upsertCalls: () => upserts,
    async findOpenPrByHead(head) {
      finds += 1;
      const pr = prs.get(head);
      return pr === undefined ? null : { number: pr.number, url: pr.url };
    },
    async commitAndUpsertPr(input) {
      upserts += 1;
      const existing = prs.get(input.head);
      if (existing !== undefined) {
        existing.base = input.base;
        existing.title = input.title;
        existing.body = input.body;
        existing.commitMessage = input.commitMessage;
        existing.files = input.files;
        return { created: false, number: existing.number, url: existing.url };
      }
      counter += 1;
      const pr: FakePr = {
        number: counter,
        url: `https://github.com/acme/repo/pull/${counter}`,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        commitMessage: input.commitMessage,
        files: input.files,
      };
      prs.set(input.head, pr);
      return { created: true, number: pr.number, url: pr.url };
    },
  };
}

async function seedBaseline(
  target: string,
  metric: string,
  value: number,
  direction: Direction = 'lower-is-better',
  unit?: string,
): Promise<string> {
  const rel = baselineRelPath(target, metric);
  await mkdir(join(ws, 'baselines'), { recursive: true });
  await writeFile(
    join(ws, rel),
    renderBaseline({
      schemaVersion: 1,
      target,
      metric,
      direction,
      value,
      unit,
      capturedAt: BASELINE_CAPTURED_AT,
    }),
    'utf8',
  );
  return rel;
}

function proposeInput(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return { ws, base: 'main', improvements: [], ...overrides };
}

describe('proposeBaselineUpdate', () => {
  test('the op input is plain data: structuredClone-safe (kernel makeManifest clones Job.input)', () => {
    expect(() =>
      structuredClone(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).not.toThrow();
  });

  test('DEFAULT_PR_TOKEN is the CQ_AUTOMATION_TOKEN doctrine marker', () => {
    expect(DEFAULT_PR_TOKEN).toBe('CQ_AUTOMATION_TOKEN');
  });

  test('an improvement proposes exactly ONE PR carrying the tightened baseline bytes', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    await expect(
      propose(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7, capturedAt: CAPTURED_AT }] }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        proposal: 'created',
        prNumber: 1,
        prUrl: 'https://github.com/acme/repo/pull/1',
        head: expect.stringMatching(/^ratchet\/propose-[0-9a-f]{12}$/),
        applied: [{ path: REL, target: TARGET, metric: METRIC, oldValue: 10, newValue: 7 }],
        skipped: [],
      },
    });
    // Exactly one PR exists, created by exactly one upsert.
    expect(effects.prs.size).toBe(1);
    expect(effects.findCalls()).toBe(1);
    expect(effects.upsertCalls()).toBe(1);
    const pr = effects.prs.get([...effects.prs.keys()][0]);
    expect(pr?.base).toBe('main');
    expect(pr?.title).toBe('chore(ratchet): tighten baselines (1 metric)');
    expect(pr?.commitMessage).toBe('chore(ratchet): tighten baselines (proposeBaselineUpdate)');
    expect(pr?.files).toHaveLength(1);
    // The file bytes are the byte-deterministic renderBaseline output of the
    // REBUILT baseline: direction and unit from the committed baseline,
    // value tightened, capturedAt from the improvement.
    const expected: BaselineFile = {
      schemaVersion: 1,
      target: TARGET,
      metric: METRIC,
      direction: 'lower-is-better',
      value: 7,
      capturedAt: CAPTURED_AT,
    };
    expect(pr?.files[0]?.path).toBe(REL);
    expect(pr?.files[0]?.content).toBe(renderBaseline(expected));
    expect(pr?.body).toContain(`- \`${REL}\` (${TARGET} / ${METRIC}): 10 → 7 (lower-is-better)`);
  });

  test('the proposal NEVER writes to the workspace — the committed baseline stays byte-identical', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const before = await readFile(join(ws, REL), 'utf8');
    const effects = makeFakeEffects();
    await createProposeBaselineUpdate(effects)(
      proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
    );
    expect(await readFile(join(ws, REL), 'utf8')).toBe(before);
  });

  test('the improvement capturedAt defaults to the clock (parses as ISO-8601)', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    await createProposeBaselineUpdate(effects)(
      proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
    );
    const content = effects.prs.get([...effects.prs.keys()][0])?.files[0]?.content ?? '';
    const onPr = JSON.parse(content) as { capturedAt?: string };
    expect(Number.isNaN(Date.parse(onPr.capturedAt ?? 'x'))).toBe(false);
    // The clock-default bytes must be FULLY committed-evidence shaped: the
    // strict parser accepts them, not merely a lenient Date.parse.
    expect(() => parseBaseline(content)).not.toThrow();
    expect(parseBaseline(content).capturedAt).toBe(onPr.capturedAt);
  });

  test('a tightening preserves the baseline unit ("errors" rides into the committed proposal bytes)', async () => {
    await seedBaseline(TARGET, METRIC, 10, 'lower-is-better', 'errors');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: 7, capturedAt: CAPTURED_AT }],
      }),
    );
    const pr = effects.prs.get([...effects.prs.keys()][0]);
    const expected: BaselineFile = {
      schemaVersion: 1,
      target: TARGET,
      metric: METRIC,
      direction: 'lower-is-better',
      value: 7,
      unit: 'errors',
      capturedAt: CAPTURED_AT,
    };
    // Byte-render matches renderBaseline with the unit intact, and the
    // proposal file parses back carrying that unit.
    expect(pr?.files[0]?.content).toBe(renderBaseline(expected));
    expect(parseBaseline(pr?.files[0]?.content ?? '').unit).toBe('errors');
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 10, newValue: 7 }] },
    });
  });

  test('re-running the SAME improvements updates the SAME open PR — still exactly one, no second create', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    const input = proposeInput({
      improvements: [{ target: TARGET, metric: METRIC, value: 7, capturedAt: CAPTURED_AT }],
    });
    const first = await propose(input);
    expect(first).toMatchObject({ status: 'ok', value: { proposal: 'created', prNumber: 1 } });
    const second = await propose(input);
    expect(second).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'updated',
        prNumber: 1,
        prUrl: 'https://github.com/acme/repo/pull/1',
      },
    });
    expect(effects.prs.size).toBe(1);
    expect(effects.findCalls()).toBe(2);
    expect(effects.upsertCalls()).toBe(2); // one create, one in-place update
  });

  test('looser or equal improvements propose NOTHING and never call the effects seam', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    for (const value of [12, 10]) {
      // looser (12) and equal (10) are each judged on their own run.
      const effects = makeFakeEffects();
      await expect(
        createProposeBaselineUpdate(effects)(
          proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value }] }),
        ),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          proposal: 'none',
          prNumber: null,
          prUrl: null,
          head: null,
          applied: [],
          skipped: [
            {
              target: TARGET,
              metric: METRIC,
              reason: expect.stringMatching(
                new RegExp(`10 → ${value} is not a tightening \\(lower-is-better\\)`),
              ),
            },
          ],
        },
      });
      expect(effects.findCalls()).toBe(0);
      expect(effects.upsertCalls()).toBe(0);
    }
  });

  test('duplicate (target, metric): a later looser reading SUPERSEDES the earlier tightening — metric dropped', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    // The newest evidence is the truth: the looser LAST reading drops the
    // metric from the proposal entirely — never kept at the older tightened
    // value 7 — and the superseded tightening leaves no record either.
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 7 },
            { target: TARGET, metric: METRIC, value: 12 },
          ],
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        proposal: 'none',
        prNumber: null,
        prUrl: null,
        head: null,
        applied: [],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: expect.stringMatching(/10 → 12 is not a tightening/),
          },
        ],
      },
    });
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('duplicate (target, metric): a later tightening after a looser entry still proposes', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 12 },
            { target: TARGET, metric: METRIC, value: 7 },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 10, newValue: 7 }], skipped: [] },
    });
    expect(effects.prs.size).toBe(1);
  });

  test('duplicate (target, metric): the LAST tightened value wins (v3, not v2)', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [
          { target: TARGET, metric: METRIC, value: 7 },
          { target: TARGET, metric: METRIC, value: 5 },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 10, newValue: 5 }] },
    });
    const pr = effects.prs.get([...effects.prs.keys()][0]);
    expect(pr?.files[0]?.content).toContain('"value": 5');
  });

  test('the UPSERT result carries the authoritative PR identity (a found PR can close between find and upsert)', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects: BaselinePrEffects = {
      async findOpenPrByHead() {
        // Stale view: PR 7 was open at find time…
        return { number: 7, url: 'https://github.com/acme/repo/pull/7' };
      },
      async commitAndUpsertPr(input) {
        // …but it was closed/merged before the upsert, so the impl created
        // PR 9 — ITS number/url is the truth the outcome must report.
        const pr: FakePr = {
          number: 9,
          url: 'https://github.com/acme/repo/pull/9',
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body,
          commitMessage: input.commitMessage,
          files: input.files,
        };
        return { created: true, number: pr.number, url: pr.url };
      },
    };
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        // review-debt #87 item 1: the VERDICT follows the upsert's
        // authoritative created flag — the found PR closed between find and
        // upsert, so the impl's fresh creation is BOTH the identity AND the
        // verdict truth (the old code said 'updated' from the stale find).
        proposal: 'created',
        prNumber: 9,
        prUrl: 'https://github.com/acme/repo/pull/9',
      },
    });
  });

  test('an upsert result lacking an identity falls back to the found PR', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects: BaselinePrEffects = {
      async findOpenPrByHead() {
        return { number: 7, url: 'https://github.com/acme/repo/pull/7' };
      },
      async commitAndUpsertPr() {
        // A loosely typed impl that reports no number/url at all.
        return { created: false } as { created: boolean; number: number; url: string };
      },
    };
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        proposal: 'updated',
        prNumber: 7,
        prUrl: 'https://github.com/acme/repo/pull/7',
      },
    });
  });

  test('the PR body renders hostile identity fields inert (backticks/newlines stripped for markdown only)', async () => {
    const hostile = 'we`ird\ninject';
    await seedBaseline(hostile, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: hostile, metric: METRIC, value: 7, capturedAt: CAPTURED_AT }],
      }),
    );
    const pr = effects.prs.get([...effects.prs.keys()][0]);
    // The body line carries the STRIPPED identity — the backtick and newline
    // cannot break out of the markdown backticks — while the applied outcome
    // and the committed FILE keep the raw identity.
    expect(pr?.body).not.toContain('we`ird');
    expect(pr?.body).toContain('(weirdinject / typecheck-count): 10 → 7 (lower-is-better)');
    expect(result).toMatchObject({
      status: 'ok',
      value: { applied: [{ target: hostile, metric: METRIC }] },
    });
    const content = pr?.files[0]?.content ?? '';
    expect((parseBaseline(content) as { target?: string }).target).toBe(hostile);
  });

  test('the tighten direction comes from the COMMITTED baseline, not the caller', async () => {
    // higher-is-better baseline: 5 → 10 tightens, 10 → 5 loosens.
    await seedBaseline(TARGET, METRIC, 5, 'higher-is-better');
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    await expect(
      propose(proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 10 }] })),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 5, newValue: 10 }] },
    });
    const content = effects.prs.get([...effects.prs.keys()][0])?.files[0]?.content ?? '';
    expect((JSON.parse(content) as { direction?: string }).direction).toBe('higher-is-better');
    const effects2 = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects2)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 3 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'none', skipped: [expect.objectContaining({ reason: expect.stringMatching(/not a tightening/) })] },
    });
    expect(effects2.findCalls()).toBe(0);
  });

  test('a missing baseline skips with the I5 wording while a remaining improvement still proposes', async () => {
    const goodRel = await seedBaseline('other-target', METRIC, 9);
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    const result = await propose(
      proposeInput({
        improvements: [
          { target: TARGET, metric: METRIC, value: 7 }, // no baseline seeded
          { target: 'other-target', metric: METRIC, value: 5 },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'created',
        applied: [{ path: goodRel, oldValue: 9, newValue: 5 }],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: expect.stringMatching(
              /no usable baseline — refusing to propose from nothing \(I5\)/,
            ),
          },
        ],
      },
    });
    expect(effects.prs.size).toBe(1);
  });

  test('a corrupt baseline skips with the I5 wording, untouched, remaining improvements still propose', async () => {
    const goodRel = await seedBaseline('other-target', METRIC, 9);
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const corrupt = '{"schemaVersion": 999}\n';
    await writeFile(join(ws, REL), corrupt, 'utf8');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [
          { target: TARGET, metric: METRIC, value: 7 },
          { target: 'other-target', metric: METRIC, value: 5 },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'created',
        applied: [{ path: goodRel }],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: expect.stringMatching(
              /is corrupt — no usable baseline — refusing to propose from nothing \(I5\)/,
            ),
          },
        ],
      },
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(corrupt);
  });

  test('a non-regular baseline leaf is skipped (mirror of checkRatchet); remaining improvements still propose', async () => {
    const goodRel = await seedBaseline('other-target', METRIC, 9);
    // A DIRECTORY squatting at the expected baseline path: lstat sees it
    // before any read — not a regular file, so it is refused as evidence.
    await mkdir(join(ws, REL), { recursive: true });
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [
          { target: TARGET, metric: METRIC, value: 7 },
          { target: 'other-target', metric: METRIC, value: 5 },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'created',
        applied: [{ path: goodRel }],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: expect.stringMatching(/is not a regular file — refusing to read as evidence/),
          },
        ],
      },
    });
  });

  test('a MISSING baselines dir skips every improvement with the I5 wording (containment.missing all-skip — review-debt #87)', async () => {
    // The ordinary no-baseline-yet ws: the dir was never created. Every
    // judged improvement skips with the no-usable-baseline reason, the
    // proposal is 'none', and no effects are ever consulted.
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 7 },
            { target: 'other-target', metric: METRIC, value: 5 },
          ],
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        proposal: 'none',
        prNumber: null,
        prUrl: null,
        head: null,
        applied: [],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: expect.stringMatching(
              /not found — no usable baseline — refusing to propose from nothing \(I5\)/,
            ),
          },
          {
            target: 'other-target',
            metric: METRIC,
            reason: expect.stringMatching(
              /not found — no usable baseline — refusing to propose from nothing \(I5\)/,
            ),
          },
        ],
      },
    });
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('a SYMLINK at the baseline leaf is skipped as non-regular even though its target parses (review-debt #87)', async () => {
    // The leaf-symlink variant of the non-regular pin: the link points at a
    // REAL, PARSEABLE baseline file elsewhere — lstat (not stat) sees the
    // link itself, and evidence through a replaceable leaf is refused even
    // when the bytes would have parsed.
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      const real = join(outside, 'real-baseline.json');
      await writeFile(
        real,
        renderBaseline({
          schemaVersion: 1,
          target: TARGET,
          metric: METRIC,
          direction: 'lower-is-better',
          value: 9,
          unit: 'errors',
          capturedAt: BASELINE_CAPTURED_AT,
        }),
        'utf8',
      );
      await mkdir(join(ws, 'baselines'), { recursive: true });
      await symlink(real, join(ws, REL));
      const effects = makeFakeEffects();
      const result = await createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      );
      expect(result).toMatchObject({
        status: 'ok',
        value: {
          proposal: 'none',
          applied: [],
          skipped: [
            {
              target: TARGET,
              metric: METRIC,
              reason: expect.stringMatching(/is not a regular file — refusing to read as evidence/),
            },
          ],
        },
      });
      expect(effects.upsertCalls()).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a baselines dir escaping the ws skips EVERY improvement and calls no effects', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await symlink(outside, join(ws, 'baselines'), 'dir');
      const effects = makeFakeEffects();
      await expect(
        createProposeBaselineUpdate(effects)(
          proposeInput({
            improvements: [
              { target: TARGET, metric: METRIC, value: 7 },
              { target: 'other-target', metric: METRIC, value: 5 },
            ],
          }),
        ),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          proposal: 'none',
          prNumber: null,
          prUrl: null,
          head: null,
          applied: [],
          skipped: [
            {
              target: TARGET,
              metric: METRIC,
              reason: expect.stringMatching(/does not resolve to a strict descendant of the workspace/),
            },
            {
              target: 'other-target',
              metric: METRIC,
              reason: expect.stringMatching(/does not resolve to a strict descendant of the workspace/),
            },
          ],
        },
      });
      expect(effects.findCalls()).toBe(0);
      expect(effects.upsertCalls()).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a baseline whose identity disagrees with the improvement is skipped (incomparable evidence)', async () => {
    await mkdir(join(ws, 'baselines'), { recursive: true });
    // A valid baseline for ANOTHER target sitting at the expected path.
    await writeFile(
      join(ws, REL),
      renderBaseline({
        schemaVersion: 1,
        target: 'elsewhere',
        metric: METRIC,
        direction: 'lower-is-better',
        value: 4,
        capturedAt: BASELINE_CAPTURED_AT,
      }),
      'utf8',
    );
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 3 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        proposal: 'none',
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: expect.stringMatching(/disagrees on target 'elsewhere' → 'typecheck'/),
          },
        ],
      },
    });
    expect(effects.findCalls()).toBe(0);
  });

  test('a mixed batch groups ALL tightenings into ONE PR with every file', async () => {
    const relA = await seedBaseline(TARGET, METRIC, 10);
    const relB = await seedBaseline('bundle-size', 'kb-total', 512, 'lower-is-better');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [
          { target: 'bundle-size', metric: 'kb-total', value: 480, capturedAt: CAPTURED_AT },
          { target: TARGET, metric: METRIC, value: 7, capturedAt: CAPTURED_AT },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'created',
        prNumber: 1,
        applied: [
          { path: relB, target: 'bundle-size', metric: 'kb-total', oldValue: 512, newValue: 480 },
          { path: relA, target: TARGET, metric: METRIC, oldValue: 10, newValue: 7 },
        ],
        skipped: [],
      },
    });
    expect(effects.prs.size).toBe(1);
    const pr = effects.prs.get([...effects.prs.keys()][0]);
    expect(pr?.title).toBe('chore(ratchet): tighten baselines (2 metrics)');
    expect(pr?.files).toHaveLength(2);
    expect(pr?.files.map((f) => f.path)).toEqual([relB, relA]);
    expect(pr?.body).toContain(`- \`${relB}\` (bundle-size / kb-total): 512 → 480 (lower-is-better)`);
    expect(pr?.body).toContain(`- \`${relA}\` (${TARGET} / ${METRIC}): 10 → 7 (lower-is-better)`);
  });

  test('the head is deterministic: same set in any order ⇒ same head; different set ⇒ different head', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    await seedBaseline('bundle-size', 'kb-total', 512);
    const effectsA = makeFakeEffects();
    const effectsB = makeFakeEffects();
    const [runA, runB] = await Promise.all([
      createProposeBaselineUpdate(effectsA)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 7 },
            { target: 'bundle-size', metric: 'kb-total', value: 480 },
          ],
        }),
      ),
      createProposeBaselineUpdate(effectsB)(
        proposeInput({
          improvements: [
            { target: 'bundle-size', metric: 'kb-total', value: 480 },
            { target: TARGET, metric: METRIC, value: 7 },
          ],
        }),
      ),
    ]);
    // The exact convention, pinned: first 12 hex (48 bits — format.ts's
    // baseline-path digest width) of sha256 over the canonical JSON of the
    // SORTED [target, metric] pairs of the applied set.
    const expectedHash = createHash('sha256')
      .update(
        JSON.stringify([
          ['bundle-size', 'kb-total'],
          [TARGET, METRIC],
        ]),
        'utf8',
      )
      .digest('hex')
      .slice(0, 12);
    const headA = runA.status === 'ok' && runA.value.head;
    const headB = runB.status === 'ok' && runB.value.head;
    expect(headA).toBe(`ratchet/propose-${expectedHash}`);
    expect(headB).toBe(headA);
    // A different applied set necessarily lands on a different head.
    const effectsC = makeFakeEffects();
    const runC = await createProposeBaselineUpdate(effectsC)(
      proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
    );
    const headC = runC.status === 'ok' && runC.value.head;
    expect(headC).not.toBe(headA);
  });

  test('a custom headPrefix names the head branch', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        headPrefix: 'ratchet/nightly',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { head: expect.stringMatching(/^ratchet\/nightly-[0-9a-f]{12}$/) },
    });
  });

  test('headPrefix must form a valid git ref (arg-error table)', async () => {
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    for (const bad of [
      '',
      '/leading',
      'trailing/',
      'ratchet//propose',
      'ratchet/.hidden',
      'has..dots',
      'has space',
    ]) {
      await expect(propose(proposeInput({ headPrefix: bad }))).resolves.toEqual({
        status: 'failed',
        error: "ratchet: invalid input — 'headPrefix' would form an invalid git ref",
      });
    }
    // Non-strings keep the plain must-be-a-string wording.
    await expect(
      propose(proposeInput({ headPrefix: 7 as unknown as string })),
    ).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'headPrefix' must be a string",
    });
    // Ref validation fires at the boundary: no effects call ever happened.
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('a valid headPrefix with dots, dashes and slashes is accepted', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        headPrefix: 'ratchet/nightly.v1-beta',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { head: expect.stringMatching(/^ratchet\/nightly\.v1-beta-[0-9a-f]{12}$/) },
    });
  });

  test('git-accurate END scoping: legal prefixes/bases the old per-component rules over-rejected (PR #110 review)', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    // A prefix ending '.lock' or '.' composes with the digest and the
    // COMPOSED head passes check-ref-format; a mid-ref '.lock' component
    // and a mid-ref trailing-dot component are legal refs.
    for (const headPrefix of ['release.lock', 'main.', 'ratchet.lock/nightly']) {
      const result = await createProposeBaselineUpdate(effects)(
        proposeInput({ headPrefix, improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      );
      expect(result.status, headPrefix).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.head, headPrefix).toMatch(new RegExp(`^${headPrefix.replace(/[.]/g, '\\.')}-[0-9a-f]{12}$`));
      }
    }
    // A base with a mid-ref trailing-dot component is a legal ref.
    const midDot = await createProposeBaselineUpdate(effects)(
      proposeInput({
        base: 'release./main',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    expect(midDot.status).toBe('ok');
  });

  test('an UNDERSCORE-bearing headPrefix is accepted (review-debt #87: git allows _ in ref segments)', async () => {
    // The old character class excluded '_' — stricter than git. A prefix
    // like 'ratchet/nightly_lock' is a perfectly legal branch name.
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        headPrefix: 'ratchet/nightly_lock',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { head: expect.stringMatching(/^ratchet\/nightly_lock-[0-9a-f]{12}$/) },
    });
  });

  test('base gets the same git-ref discipline (arg-error table)', async () => {
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    for (const bad of [
      '',
      '/lead',
      'trail/',
      'dou//ble',
      'do..ts',
      'seg/.hidden',
      '.dot',
      'has space',
      // PR #110 review: the trailing-dot and *.lock restrictions bind the
      // END of the COMPLETE ref (git's own scoping) — 'main.' and
      // 'release.lock' reject as bases; a MID-ref '.lock' component
      // ('ratchet.lock/nightly') is legal and moved to the positive rows.
      'main.',
      'release.lock',
    ]) {
      await expect(propose(proposeInput({ base: bad }))).resolves.toEqual({
        status: 'failed',
        error: "ratchet: invalid input — 'base' would form an invalid git ref",
      });
    }
    // Ref validation fires at the boundary: no effects call ever happened.
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('a hostile base never reaches the PR body: refused at the boundary; a clean base renders in the target line', async () => {
    // A base carrying markdown-breaking characters fails ref validation —
    // it can never render into the body at all (the mdSafe render of base
    // is defense-in-depth behind that refusal).
    const hostile = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(hostile)(proposeInput({ base: 'ma`in\nbranch' })),
    ).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'base' would form an invalid git ref",
    });
    expect(hostile.upsertCalls()).toBe(0);
    // A clean base renders in the body's target line and rides the upsert.
    await seedBaseline(TARGET, METRIC, 10);
    const clean = makeFakeEffects();
    await createProposeBaselineUpdate(clean)(
      proposeInput({
        base: 'release/main',
        improvements: [{ target: TARGET, metric: METRIC, value: 7 }],
      }),
    );
    const pr = clean.prs.get([...clean.prs.keys()][0]);
    expect(pr?.body).toContain('Target branch: `release/main`.');
    expect(pr?.base).toBe('release/main');
  });

  test('input validation: null input, non-string ws/base, non-finite value → failed verdicts', async () => {
    const propose = createProposeBaselineUpdate(makeFakeEffects());
    await expect(propose(null as unknown as ProposeInput)).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — expected a non-null object',
    });
    await expect(
      propose(proposeInput({ ws: 42 as unknown as string })),
    ).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'ws' must be a string",
    });
    await expect(
      propose(proposeInput({ base: undefined as unknown as string })),
    ).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'base' must be a string",
    });
    // 10 ** 400 overflows to Infinity — the crafted-non-finite probe.
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: TARGET, metric: METRIC, value: 10 ** 400 }],
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — improvements[0].value must be a finite number",
    });
    // The remaining boundary guards, each pinned with its arg-error wording.
    await expect(
      propose(proposeInput({ improvements: 'nope' as unknown as ProposeInput['improvements'] })),
    ).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'improvements' must be an array",
    });
    await expect(
      propose(
        proposeInput({ improvements: [42 as unknown as ProposeInput['improvements'][number]] }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — improvements[0] must be an object',
    });
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: 42 as unknown as string, metric: METRIC, value: 1 }],
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — improvements[0].target must be a string',
    });
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: TARGET, metric: 42 as unknown as string, value: 1 }],
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — improvements[0].metric must be a string',
    });
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: TARGET, metric: METRIC, value: 1, capturedAt: 'not-a-date' }],
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(
        /improvements\[0\]\.capturedAt must be a strict ISO-8601 instant/,
      ),
    });
  });

  test('an empty improvements list is the zero fast path: none, zero effects calls', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    await expect(createProposeBaselineUpdate(effects)(proposeInput())).resolves.toEqual({
      status: 'ok',
      value: {
        proposal: 'none',
        prNumber: null,
        prUrl: null,
        head: null,
        applied: [],
        skipped: [],
      },
    });
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('a findOpenPrByHead rejection is a failed verdict — no throw crosses the op seam', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects: BaselinePrEffects = {
      findOpenPrByHead: () => Promise.reject(new Error('gh api exploded')),
      commitAndUpsertPr: () => Promise.reject(new Error('unreachable')),
    };
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/could not look up an open proposal PR.*gh api exploded/s),
    });
  });

  test('a commitAndUpsertPr rejection is indeterminate — the commit may or may not have landed', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects: BaselinePrEffects = {
      findOpenPrByHead: () => Promise.resolve(null),
      commitAndUpsertPr: () => Promise.reject('network dropped'), // non-Error rejection
    };
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).resolves.toEqual({
      status: 'indeterminate',
      detail: expect.stringMatching(
        /may or may not have landed.*network dropped/s,
      ),
    });
  });
});
