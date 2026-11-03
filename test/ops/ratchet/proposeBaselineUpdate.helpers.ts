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
//   6. Directional rounding at the baseline FILE's precision (#319): the
//      proposal value is the measurement rounded AWAY from strictness —
//      floor for higher-is-better, ceil for lower-is-better — at the exact
//      decimal precision of the file's own value token (lexical digits: a
//      raw 94.20 speaks two decimals; the parsed number's canonical scale
//      is the fallback; an escaped in-string "value" never poses as the
//      token), so a
//      proposal is never stricter than the measurement it was told (a 94.29
//      reading against a 94.2 file proposes nothing, never the half-up 94.3
//      a re-measurement cannot reproduce); an exact decimal boundary never
//      moves (94.3 floors to exactly 94.3, 68.1 ceils to exactly 68.1, and
//      at a magnitude where scaled-float math genuinely errs — 0.29 × 100 is
//      28.999999999999996 — the boundary still floors to exactly 0.29); the
//      file's own granularity governs (integer file → 0 decimals;
//      2-decimal file → 2); negatives round mathematically (floor toward
//      −∞, ceil toward +∞, never truncation toward zero).
//
// The effects seam is faked in-memory (Map keyed by head, recording every
// call); the real gh-backed implementation lands in H4.
//
// The suite was split into per-subject files
// (proposeBaselineUpdate.<subject>.test.ts) so review tooling can see
// below the 256 KiB single-file cap; this module carries the shared ws
// hooks, the in-memory effects fake and the baseline-seeding helpers all
// of them import.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { Direction } from '../../../src/ops/ratchet/format.js';
import type {
  BaselinePrEffects,
  ProposeInput,
} from '../../../src/ops/ratchet/proposeBaselineUpdate.js';

export const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
export const BASELINE_CAPTURED_AT = '2026-09-14T00:00:00.000Z';
export const TARGET = 'typecheck';
export const METRIC = 'typecheck-count';
export const REL = baselineRelPath(TARGET, METRIC);

export let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-propose-'));
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

/** A recorded PR plus the exact upsert payload that last produced it. */
export interface FakePr {
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
export function makeFakeEffects(): BaselinePrEffects & {
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
    async closeOpenPrByHead(head) { prs.delete(head); },
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
        existing.files = [...new Map([...existing.files, ...input.files].map((file) => [file.path, file])).values()];
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

export async function seedBaseline(
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
      ...(unit === undefined ? {} : { unit }),
      capturedAt: BASELINE_CAPTURED_AT,
    }),
    'utf8',
  );
  return rel;
}

export function proposeInput(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return { ws, base: 'main', improvements: [], ...overrides };
}

/** Seed a baseline from RAW file text — for lexical shapes renderBaseline cannot express ("value": 94.20). */
export async function seedRawBaseline(
  target: string,
  metric: string,
  rawFile: string,
): Promise<string> {
  const rel = baselineRelPath(target, metric);
  await mkdir(join(ws, 'baselines'), { recursive: true });
  await writeFile(join(ws, rel), rawFile, 'utf8');
  return rel;
}
