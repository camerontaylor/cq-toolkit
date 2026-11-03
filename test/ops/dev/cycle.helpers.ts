// dev.cycle composition tests over a REAL git repo with a bare `origin` and
// fully scripted ops legs (the dev-family repo harness plus fakes): the
// clean loop publishes a ready PR at the addressed head; the round cap
// publishes a DRAFT carrying the gaps and the open-findings + attempt-log
// section and resolves needs-human with the follow-up command; every other
// refusal surfaces verbatim and never bypasses its leg. No provider, no
// network, no credentials.
// Shared fixtures for the dev.cycle test files split from cycle.test.ts.
import { rm } from 'node:fs/promises';
import { vi } from 'vitest';
import type { DevCheckInput, DevCheckReport } from '../../../src/ops/dev/check.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import { readWorkState, type WorkState } from '../../../src/ops/dev/internal/workState.js';
import type { OpResult } from '../../../src/kernel/types.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import type { PrOpenInput, PrOpenReport } from '../../../src/ops/pr/open.js';
import type { ReviewAddressInput, ReviewAddressReport } from '../../../src/ops/review/address.js';
import type { FindingsRecord } from '../../../src/ops/review/findings.js';
import type { ReviewRunInput } from '../../../src/ops/review/run.js';
import { cycleRecord, checkRecord } from './fakes.js';
import { DEV_LEDGER_VERSION as seedLedgerVersion } from '../../../src/ops/dev/record.js';
import { repoEffects, type TestRepo } from './repo.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

let repo: TestRepo;
/** Bind THIS file's repo fixture for the shared repo-reading helpers below. */
export function bindCycleRepo(bound: TestRepo): void {
  repo = bound;
}

const effects: () => DevEffects = () => repoEffects(repo);

type CheckLeg = (input: DevCheckInput) => Promise<OpResult<DevCheckReport>>;
type ReviewLeg = (input: ReviewRunInput) => Promise<OpResult<FindingsRecord>>;
export type AddressLeg = (
  input: ReviewAddressInput,
) => Promise<OpResult<unknown> & { report?: ReviewAddressReport }>;
type OpenLeg = (input: PrOpenInput) => Promise<OpResult<PrOpenReport>>;
type GitLeg = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A scripted green check leg recording its calls. */
export function greenCheck(calls: string[] = []): CheckLeg {
  return async (input) => {
    calls.push(`check:${input.target ?? 'main'}`);
    const read = await readWorkState(effects(), { target: input.target ?? 'main' });
    if (!read.ok) throw new Error(read.reason);
    const at = {
      base: read.state.base,
      head: read.state.head,
      dirtySha256: read.state.dirtySha256,
    };
    return {
      status: 'ok',
      value: {
        checkId: `k0${String(calls.length).padStart(2, '0')}-aaaaaaaa`,
        target: input.target ?? 'main',
        ...at,
        passed: true,
        testSelection:
          input.testFiles !== undefined
            ? { mode: 'named' as const, files: [...input.testFiles] }
            : input.range !== undefined
              ? ({ mode: 'range' } as const)
              : ({ mode: 'base' } as const),
        gates: [
          { name: 'check:static', status: 'pass', exitCode: 0, durationMs: 5, evidence: 'ok' },
        ],
        loadStamp: { uptimeSeconds: 1, load1: 1, at: '2026-10-25T00:00:00.000Z' },
        at: '2026-10-25T00:00:00.000Z',
      },
    };
  };
}

/** A clean review leg: a terminal record with NO open finding. */
export function cleanReview(state: WorkState): ReviewLeg {
  return async () => ({
    status: 'ok',
    value: {
      schemaVersion: 1,
      branch: state.branch,
      head: state.head,
      reviewed: { base: state.base, scope: 'full' },
      sources: [{ kind: 'agent', status: 'terminal' }],
      findings: [],
    },
  });
}

/** The address report skeleton dev.cycle renders (open findings + attempts). */
export function addressReport(
  state: WorkState,
  openBlocking: ReviewAddressReport['openBlocking'],
  attempts: ReviewAddressReport['attempts'],
): ReviewAddressReport {
  return {
    source: 'local',
    verifiedHead: state.head,
    reportPath: '/tmp/dev-cycle-fixture/review-address-report.json',
    rounds: [],
    findings: openBlocking,
    openBlocking,
    fixes: [],
    attempts,
    failed: [],
    fixesPerRun: 0,
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
    wallMs: 12,
    reasons: [],
  };
}

/** A scripted CLEAN address leg: no open findings, no attempts. */
export function cleanAddress(state: WorkState): AddressLeg {
  return async () => ({ status: 'ok', value: addressReport(state, [], []) });
}

export const capFinding = {
  id: 'c001-aaaaaaaa#f1',
  source: 'agent',
  file: 'src/a.ts',
  severity: 'major',
  text: 'Replace BAD with GOOD',
  status: 'open' as const,
};

/** A scripted ROUND-CAP address leg: needs-human WITH the report attached (stop marker inside the report). */
export function roundCapAddress(state: WorkState): AddressLeg {
  const attempts: ReviewAddressReport['attempts'] = [
    {
      finding: 'c001-aaaaaaaa#f1',
      tier: 'worker',
      attempt: 1,
      invocation: 'edit',
      reason: 'the scripted worker left the marker text in place',
      model: { provider: 'fixture', model: 'scripted' },
      observedHead: state.head,
      wallMs: 400,
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  ];
  return async () => ({
    status: 'needs-human',
    reason: 'review round cap reached with open findings',
    report: { ...addressReport(state, [capFinding], attempts), stop: 'round-cap' as const },
  });
}

/**
 * A scripted address leg returning EXACTLY what makeReviewAddress's
 * finish() produces for the round-cap stop: the reason carries the
 * '; report: <path>' suffix (address.ts finish appends it to every
 * needs-human reason) AND the structured stop:'round-cap' marker rides
 * INSIDE the report envelope (the kernel-sanctioned extension stripped
 * pre-parse — a top-level field would trip the strict OpResultSchema).
 * The production-shape test pins that the composition's discriminator
 * survives the suffixed reason; the bare-constant fake above cannot catch a
 * discriminator that never matches production.
 */
export function roundCapAddressProductionShape(state: WorkState): AddressLeg {
  const base = roundCapAddress(state);
  return async () => {
    const result = await base({ repoRoot: '/s7-production-shape', source: 'local' });
    if (result.status !== 'needs-human') return result;
    return {
      ...result,
      reason: `${result.reason}; report: /tmp/s7-fixture/journal/review-address-report.json`,
    };
  };
}

/** A scripted pr.open leg recording its inputs and returning a fixed PR. */
export function openFake(calls: PrOpenInput[], number = 42, ready = true): OpenLeg {
  return async (input) => {
    calls.push(input);
    return {
      status: 'ok',
      value: {
        number,
        url: `https://example.invalid/pull/${String(number)}`,
        created: true,
        base: input.target ?? 'main',
        head: 'head-from-open',
        branch: 'feature/x',
        evidenceClass: 'author',
        ready,
      },
    };
  };
}

export const okPush: GitLeg = async () => ({ code: 0, stdout: '', stderr: '' });

/** A gh fake with a get/edit body pair for the findings-section compose. */
export function ghFake(
  existingBody = '<!-- cq:dev-readiness-gaps -->\nDRAFT SECTION\n<!-- /cq:dev-readiness-gaps -->',
) {
  const bodies: string[] = [];
  let currentBody = existingBody;
  const gh = {
    getPrBody: async () => currentBody,
    editPrBody: async (_number: number, body: string) => {
      bodies.push(body);
      currentBody = body;
    },
    searchPrByHead: async () => null,
    createPr: async (request: {
      head: string;
      base: string;
      title: string;
      body: string;
      draft: boolean;
    }) => {
      currentBody = request.body;
      return { number: 43, url: 'https://example.invalid/pull/43' };
    },
    comment: async () => undefined,
    getPrReadiness: async () => {
      throw new Error('not used by dev.cycle');
    },
  };
  return { gh: gh as unknown as PrEffects, bodies };
}

/** Seed the repo ledger: a terminal cycle + green check AT the given state. */
export async function seedReadyLedger(state: WorkState): Promise<void> {
  const at = { base: state.base, head: state.head, dirtySha256: state.dirtySha256 };
  repoEffects(repo)
    .openLedger(state.branch)
    .save({
      version: seedLedgerVersion,
      branch: state.branch,
      records: [cycleRecord(at), checkRecord(at)],
    });
}

// ---- BEFORE controls (P1 thread 7kNb + 7lxL): report presence is NOT
// a publication trigger. Blocked re-reviews and admission failures carry a
// report too; only the STRUCTURED stops — 'round-cap', 'budget' (S7
// attempt H, the spec's never-unpublished invariant) and #532's
// 'rereview-blocked' — publish a draft.

/**
 * An address leg that stopped on a STRUCTURED stop: the production
 * finish() shape — the needs-human reason carries the '; report: <path>'
 * suffix and the structured marker rides INSIDE the report envelope.
 * Production pairs each stop value with its own reason (address.ts
 * finish()): a run-budget stop marks stop:'budget' behind 'token or wall
 * budget exhausted', and a re-review still blocked after verified fixes
 * (#532) marks stop:'rereview-blocked' behind 're-review: …' — one
 * reason/stop pairing each, never a budget marker under a re-review
 * reason.
 */
export function structuredStopAddress(
  state: WorkState,
  stop: Exclude<ReviewAddressReport['stop'], undefined>,
  reason: string,
): AddressLeg {
  return async () => ({
    status: 'needs-human',
    reason,
    report: { ...addressReport(state, [capFinding], []), stop },
  });
}

/** A helper every agent-leg test with a pre-dispatch scan shares (the four
 * default-review-leg M7 tests plus the S7 probe and the M7 cancellation
 * and usage tests): CI runners have no gitleaks binary, so the scan needs
 * the hermetic scanner fixture on PATH. Returns the cleanup. */
export async function stubM7Scanner(): Promise<() => Promise<void>> {
  const scanner = await makeGitleaksFixture();
  vi.stubEnv('PATH', scanner.path);
  return async () => {
    vi.unstubAllEnvs();
    await rm(scanner.root, { recursive: true, force: true });
  };
}
