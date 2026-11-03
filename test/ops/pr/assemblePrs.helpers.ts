// PR lane (goal D3) — evidence for the tracker-first assembler
// (src/ops/pr/assemblePrs.ts; UC §1 row 22).
//
// Pinned here, on a recording fake PrEffects (zero processes, zero network):
//   1. TRACKER-FIRST ORDER (the goal's required invariant): on a fresh run
//      the tracker is searched first, then created, BEFORE any per-package
//      PR is searched or created.
//   2. NEVER A SECOND TRACKER: an existing tracker PR (same head branch) is
//      reused — createPr is NOT called for the tracker head, the reused
//      number is reported with created:false, and editPrBody refreshes the
//      manifest in place listing the per-package PRs.
//   3. FAIL BEFORE ANY PACKAGE PR: a tracker search OR creation fault fails
//      the whole op with ZERO package PRs attempted.
//   4. PER-ROW ISOLATION: an existing per-package PR is reused (no
//      duplicate create); a per-package fault lands on its row alone.
//   5. BOUNDARY: prefix violations on tracker.branch and packages[].branch,
//      non-boolean draft, and other field faults are `failed` results
//      naming the field, before any gh call.
//   6. The report is plain JSON (round trip) and the draft default is true.
//
// Split provenance: test/ops/pr/assemblePrs.test.ts was split by subject into
// assemblePrs.ordering.test.ts, assemblePrs.scanning.test.ts,
// assemblePrs.trackerFaults.test.ts, assemblePrs.packageRows.test.ts,
// assemblePrs.boundary.test.ts, assemblePrs.report.test.ts and
// assemblePrs.manifest.test.ts. This module holds the shared recording fake
// and fixtures; it declares no tests.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeAssemblePrs as makeAssemblePrsWithScanner,
  type AssemblePrsInput,
  type PrCreateRequest,
  type PrEffects,
  type PrState,
} from '../../../src/ops/pr/assemblePrs.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';

// ---------------------------------------------------------------------------
// Recording fake PrEffects
// ---------------------------------------------------------------------------

export interface FakeGh {
  gh: PrEffects;
  /** Every effect call, in order: `search:<head>` / `create:<head>` / `edit:<n>` / `comment:<n>`. */
  calls: string[];
  /** createPr requests, in order. */
  creates: PrCreateRequest[];
  /** editPrBody bodies keyed by PR number. */
  edits: Map<number, string>;
  /** Existing PRs by head branch (the search index); absent state means open. */
  prsByHead: Map<
    string,
    { number: number; url?: string; state?: PrState; isCrossRepository?: boolean }
  >;
  /** Track the next createPr number. */
  nextNumber: number;
  /** When set, createPr rejects for heads matching this exact string. */
  createFaultOnHead?: string;
  /** Heads the fake recorded search calls FOR, with the base they were searched against. */
  searches: Array<{ head: string; base: string }>;
}

export function fakeGh(seed: Partial<FakeGh> = {}): FakeGh {
  const calls: string[] = [];
  const creates: PrCreateRequest[] = [];
  const edits = new Map<number, string>();
  const searches: Array<{ head: string; base: string }> = [];
  const prsByHead =
    seed.prsByHead ??
    new Map<
      string,
      { number: number; url?: string; state?: PrState; isCrossRepository?: boolean }
    >();
  let nextNumber = seed.nextNumber ?? 101;
  const state: FakeGh = {
    calls,
    creates,
    edits,
    prsByHead,
    nextNumber,
    searches,
    ...(seed.createFaultOnHead !== undefined ? { createFaultOnHead: seed.createFaultOnHead } : {}),
    gh: {
      searchPrByHead: async (head, base) => {
        calls.push(`search:${head}`);
        searches.push({ head, base });
        const hit = prsByHead.get(head);
        if (hit === undefined) return null;
        return {
          number: hit.number,
          state: hit.state ?? 'open',
          isCrossRepository: hit.isCrossRepository === true,
          ...(hit.url === undefined ? {} : { url: hit.url }),
        };
      },
      createPr: async (request) => {
        calls.push(`create:${request.head}`);
        creates.push(request);
        if (seed.createFaultOnHead === request.head) {
          throw new Error(`gh refused the create for ${request.head}`);
        }
        const number = nextNumber;
        nextNumber += 1;
        state.nextNumber = nextNumber;
        prsByHead.set(request.head, { number });
        return { number, url: `https://github.test/owner/repo/pull/${String(number)}` };
      },
      editPrBody: async (number, body) => {
        calls.push(`edit:${String(number)}`);
        edits.set(number, body);
      },
      comment: async (number) => {
        calls.push(`comment:${String(number)}`);
      },
      getPrBody: async () => '',
      getPrReadiness: async () => ({
        checks: { state: 'pass' },
        review: { state: 'none' },
        meta: { isDraft: false, state: 'open', mergeable: 'mergeable', mergeStateStatus: 'clean' },
      }),
    },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const TRACKER_BRANCH = 'cq/09-16a/tracker';
export const PKG_CORE = 'cq/09-16a/fix/core';
export const PKG_UTIL = 'cq/09-16a/fix/util';

export const cleanScanner: DiffSecretScanner = (components) =>
  components.map(({ component }) => ({ component, hits: [] }));

export function makeAssemblePrs(gh: PrEffects, scanner: DiffSecretScanner = cleanScanner) {
  return makeAssemblePrsWithScanner(gh, undefined, scanner);
}

// The default tracker-body lock is repo-rooted (review-debt #171), so the op
// needs a real, writable repo root; a tmpdir keeps the suite hermetic.
export const REPO_ROOT = mkdtempSync(join(tmpdir(), 'pr-assemble-lock-'));

/** Removes this module's tmpdir repo root; each test file registers it via `afterAll`. */
export function cleanupRepoRoot(): void {
  rmSync(REPO_ROOT, { recursive: true, force: true });
}

export function inputOf(overrides: Partial<AssemblePrsInput> = {}): AssemblePrsInput {
  return {
    repoRoot: REPO_ROOT,
    runPrefix: 'cq/09-16a',
    base: 'origin/merge-queue',
    tracker: { title: 'Fleet run cq/09-16a', branch: TRACKER_BRANCH },
    packages: [
      { name: 'core', branch: PKG_CORE, title: 'core fixes' },
      { name: 'util', branch: PKG_UTIL, title: 'util fixes', body: 'utility notes' },
    ],
    ...overrides,
  };
}

/** Unwraps an `ok` result; anything else fails the test with what came back. */
export async function okReport(op: ReturnType<typeof makeAssemblePrs>, input: AssemblePrsInput) {
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
    );
  }
  return result.value;
}

/** Unwraps a `failed` result's error; any other status fails the test. */
export async function failedAt(op: ReturnType<typeof makeAssemblePrs>, input: AssemblePrsInput) {
  const result = await op(input);
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error;
}
