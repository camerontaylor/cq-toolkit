// dev.cycle composition tests over a REAL git repo with a bare `origin` and
// fully scripted ops legs (the dev-family repo harness plus fakes): the
// clean loop publishes a ready PR at the addressed head; the round cap
// publishes a DRAFT carrying the gaps and the open-findings + attempt-log
// section and resolves needs-human with the follow-up command; every other
// refusal surfaces verbatim and never bypasses its leg. No provider, no
// network, no credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  DEV_FINDINGS_SECTION_MARKER,
  followUpCommand,
  makeDevCycle,
  renderFindingsSection,
} from '../../../src/ops/dev/cycle.js';
import { DEV_READINESS_GAPS_SECTION_MARKER } from '../../../src/ops/pr/open.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { DevCheckInput, DevCheckReport } from '../../../src/ops/dev/check.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { WorkState } from '../../../src/ops/dev/internal/workState.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import type { PrOpenInput, PrOpenReport } from '../../../src/ops/pr/open.js';
import type { ReviewAddressInput, ReviewAddressReport } from '../../../src/ops/review/address.js';
import type { FindingsRecord } from '../../../src/ops/review/findings.js';
import type { ReviewRunInput } from '../../../src/ops/review/run.js';
import { cycleRecord, checkRecord, dispositionRecord } from './fakes.js';
import { DEV_LEDGER_VERSION as seedLedgerVersion } from '../../../src/ops/dev/record.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const effects: () => DevEffects = () => repoEffects(repo);

type CheckLeg = (input: DevCheckInput) => Promise<OpResult<DevCheckReport>>;
type ReviewLeg = (input: ReviewRunInput) => Promise<OpResult<FindingsRecord>>;
type AddressLeg = (
  input: ReviewAddressInput,
) => Promise<OpResult<unknown> & { report?: ReviewAddressReport }>;
type OpenLeg = (input: PrOpenInput) => Promise<OpResult<PrOpenReport>>;
type GitLeg = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

import type { OpResult } from '../../../src/kernel/types.js';

/** A scripted green check leg recording its calls. */
function greenCheck(calls: string[] = []): CheckLeg {
  return async (input) => {
    calls.push(`check:${input.target ?? 'merge-queue'}`);
    const read = await readWorkState(effects(), { target: input.target ?? 'merge-queue' });
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
        target: input.target ?? 'merge-queue',
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
function cleanReview(state: WorkState): ReviewLeg {
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
function addressReport(
  state: WorkState,
  openBlocking: ReviewAddressReport['openBlocking'],
  attempts: ReviewAddressReport['attempts'],
): ReviewAddressReport {
  return {
    source: 'local',
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
function cleanAddress(state: WorkState): AddressLeg {
  return async () => ({ status: 'ok', value: addressReport(state, [], []) });
}

const capFinding = {
  id: 'c001-aaaaaaaa#f1',
  source: 'agent',
  file: 'src/a.ts',
  severity: 'major',
  text: 'Replace BAD with GOOD',
  status: 'open' as const,
};

/** A scripted ROUND-CAP address leg: needs-human WITH the report attached (stop marker inside the report). */
function roundCapAddress(state: WorkState): AddressLeg {
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
function roundCapAddressProductionShape(state: WorkState): AddressLeg {
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
function openFake(calls: PrOpenInput[], number = 42, ready = true): OpenLeg {
  return async (input) => {
    calls.push(input);
    return {
      status: 'ok',
      value: {
        number,
        url: `https://example.invalid/pull/${String(number)}`,
        created: true,
        base: input.target ?? 'merge-queue',
        head: 'head-from-open',
        branch: 'feature/x',
        evidenceClass: 'author',
        ready,
      },
    };
  };
}

const okPush: GitLeg = async () => ({ code: 0, stdout: '', stderr: '' });

/** A gh fake with a get/edit body pair for the findings-section compose. */
function ghFake(
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
async function seedReadyLedger(state: WorkState): Promise<void> {
  const at = { base: state.base, head: state.head, dirtySha256: state.dirtySha256 };
  repoEffects(repo)
    .openLedger(state.branch)
    .save({
      version: seedLedgerVersion,
      branch: state.branch,
      records: [cycleRecord(at), checkRecord(at)],
    });
}

describe('dev.cycle', () => {
  test('the clean loop: check → review → address → final check → push → ready PR (ok)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const checkCalls: string[] = [];
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(checkCalls),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake(opens),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.branch).toBe('feature/x');
    expect(result.value.head).toBe(state.head);
    expect(result.value.pushed).toBe(true);
    expect(result.value.followUp).toBe(followUpCommand(42, repo.root));
    expect(result.value.pr.number).toBe(42);
    expect(result.value.pr.ready).toBe(true);
    // TWO check legs: before the review and after the address.
    expect(checkCalls).toEqual(['check:merge-queue', 'check:merge-queue']);
    // The PR opened ready (no draft flags), at the intended target.
    expect(opens).toEqual([{ repoRoot: repo.root, target: 'merge-queue' }]);
  });

  test('includeIntegration=true reaches BOTH check legs', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const seen: boolean[] = [];
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        seen.push(input.includeIntegration === true);
        return greenCheck([])(input);
      },
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake(opens),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root, includeIntegration: true });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(seen).toEqual([true, true]);
  });

  test('testFiles reaches BOTH check legs; absent keeps them automatic', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const seen: Array<string[] | undefined> = [];
    const files = ['test/ops/dev/cycle.test.ts', 'test/ops/dev/check.test.ts'];
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        seen.push(input.testFiles);
        return greenCheck([])(input);
      },
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake([]),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const named = await op({ repoRoot: repo.root, testFiles: files });
    expect(named.status, JSON.stringify(named)).toBe('ok');
    expect(seen).toEqual([files, files]);
    seen.length = 0;
    const bare = await op({ repoRoot: repo.root });
    expect(bare.status, JSON.stringify(bare)).toBe('ok');
    expect(seen).toEqual([undefined, undefined]);
  });

  test('includeIntegration absent keeps the check legs bare', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const seen: boolean[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        seen.push(input.includeIntegration === true);
        return greenCheck([])(input);
      },
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake([]),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(seen).toEqual([false, false]);
  });

  test('push:false skips the verified push (the branch stays local; pr.open still runs)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake([]),
      git: async () => {
        pushCalls++;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root, push: false });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.pushed).toBe(false);
    expect(pushCalls).toBe(0);
  });

  test('the round cap: pushed branch, DRAFT with the gaps, dispositions AND findings sections, needs-human with the follow-up command', async () => {
    const state = await seed(repo);
    repo.git('push', '-q', 'origin', 'feature/x');
    await seedReadyLedger(state);
    // The address round dispositioned one earlier finding and one BLOCKING
    // finding stays open (the round cap's whole point): the seeded terminal
    // cycle gains a blocking finding with NO disposition, so readiness
    // reports open-blocking-findings and pr.open takes the NOT-READY path —
    // whose managed section carries the dispositions (here, the one the
    // address round recorded for an earlier minor finding).
    await repoEffects(repo)
      .openLedger(state.branch)
      .mutate((ledger) => ({
        ledger: {
          version: ledger.version,
          branch: ledger.branch,
          records: [
            ...ledger.records.map((record) =>
              record.kind === 'cycle'
                ? {
                    ...record,
                    findings: [
                      ...record.findings,
                      {
                        id: 'c001-aaaaaaaa#f1',
                        severity: 'major' as const,
                        fileName: 'src/a.ts',
                        excerpt: 'Replace BAD with GOOD',
                      },
                    ],
                  }
                : record,
            ),
            dispositionRecord({
              findingId: 'c004-aaaaaaaa#f9',
              action: 'deferred',
              why: 'owner decision needed',
            }),
          ],
        },
        value: undefined,
      }));
    // The REAL pr.open over the gh fake (no injected open): the draft body
    // is pr.open's own gaps+dispositions section, and dev.cycle composes
    // the findings section onto it — the full three-section contract.
    const { gh, bodies } = ghFake();
    const opens: PrOpenInput[] = [];
    const { makePrOpen } = await import('../../../src/ops/pr/open.js');
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: roundCapAddress(state),
      open: ((input: PrOpenInput) => {
        opens.push(input);
        return makePrOpen(effects(), gh)(input);
      }) as never,
      gh,
      git: async (args) =>
        args.includes('push')
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.reason).toContain('NOT READY');
    expect(result.reason).toContain('review round cap reached with open findings');
    expect(result.reason).toContain(`follow-up: ${followUpCommand(43, repo.root)}`);
    expect(result.reason).toContain('draft PR #43');
    // The branch was published BEFORE the draft opened (pr.open's rule).
    expect(opens).toEqual([
      { repoRoot: repo.root, target: 'merge-queue', draft: true, draftWhenNotReady: true },
    ]);
    // The findings section was composed onto the draft's REAL body after
    // creation — the three spec sections, in one body.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(DEV_READINESS_GAPS_SECTION_MARKER);
    expect(bodies[0]).toContain('NOT READY');
    // Section 2: the dispositions, inside the managed gaps span.
    expect(bodies[0]).toContain('finding dispositions: 1');
    expect(bodies[0]).toContain('`c004-aaaaaaaa#f9` — **deferred**: owner decision needed');
    // Section 3: the findings + attempt log, composed by dev.cycle.
    expect(bodies[0]).toContain(DEV_FINDINGS_SECTION_MARKER);
    expect(bodies[0]).toContain('<!-- /cq:dev-findings -->');
    expect(bodies[0]).toContain('c001-aaaaaaaa#f1');
    expect(bodies[0]).toContain('worker/edit #1');
    expect(bodies[0]).toContain('scripted');
    const body0: string = bodies[0] ?? '';
    expect(body0.indexOf(DEV_FINDINGS_SECTION_MARKER)).toBeGreaterThan(
      body0.indexOf('finding dispositions'),
    );
  });

  test('RED-AT-6db637da (v9K4q): the round cap publishes through the PRODUCTION finish() shape (reason carries the "; report:" suffix)', async () => {
    const state = await seed(repo);
    repo.git('push', '-q', 'origin', 'feature/x');
    await seedReadyLedger(state);
    const { gh, bodies } = ghFake();
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: roundCapAddressProductionShape(state),
      open: openFake(opens, 45, false),
      gh,
      git: async (args) =>
        args.includes('push')
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' },
    });
    const result = await op({ repoRoot: repo.root });
    // The production finish() appends '; report: <path>' to every needs-human
    // reason; the discriminator MUST still recognize the round cap through
    // the suffix and publish the draft (the spec's draft-at-cap). A prefix
    // match that never fires would surface this as a verbatim
    // 'review.address' refusal with zero publication instead.
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.reason).toContain('NOT READY');
    expect(result.reason).toContain('review round cap reached with open findings');
    expect(result.reason).toContain(`follow-up: ${followUpCommand(45, repo.root)}`);
    expect(opens).toEqual([
      { repoRoot: repo.root, target: 'merge-queue', draft: true, draftWhenNotReady: true },
    ]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(DEV_FINDINGS_SECTION_MARKER);
  });

  test('a red FIRST check stops verbatim before any review leg', async () => {
    const op = makeDevCycle({
      effects: effects(),
      check: async () => ({
        status: 'failed',
        error: 'dev.check: 1 gate(s) red (check:static)',
      }),
      review: async () => {
        throw new Error('review must not run');
      },
      address: async () => {
        throw new Error('address must not run');
      },
      open: openFake([]),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result).toEqual({
      status: 'failed',
      error: 'dev.cycle (dev.check): dev.check: 1 gate(s) red (check:static)',
    });
  });

  test('a red FINAL check after a clean address stops verbatim (never a draft, never bypassed)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    let checkRuns = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        checkRuns++;
        if (checkRuns === 1) return greenCheck()({ ...input });
        return { status: 'failed', error: 'dev.check: the final gates went red' };
      },
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake([]),
      git: okPush,
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(result.error).toBe(
        'dev.cycle (dev.check (final)): dev.check: the final gates went red',
      );
  });

  test('a blocked review source stops verbatim with zero pr calls', async () => {
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: async () => ({
        status: 'needs-human',
        reason: 'review.run: not every configured reviewer completed a terminal cycle',
      }),
      address: async () => {
        throw new Error('address must not run');
      },
      open: openFake(opens),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toBe(
        'dev.cycle (review.run): review.run: not every configured reviewer completed a terminal cycle',
      );
    expect(opens).toEqual([]);
  });

  test('an address refusal WITHOUT a report stops verbatim (no draft, no PR)', async () => {
    const state = await seed(repo);
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: async () => ({
        status: 'needs-human',
        reason: 'review.address: no findings record; run review.run or pass --record',
      }),
      open: openFake(opens),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain(
        'dev.cycle (review.address): review.address: no findings record',
      );
    expect(opens).toEqual([]);
  });

  // ---- BEFORE controls (P1 thread 7kNb + 7lxL): report presence is NOT
  // round-cap. Budget stops, blocked re-reviews and admission failures all
  // carry a report; only the round-cap stop publishes a draft.

  /** An address leg that stopped on the BUDGET with a report attached. */
  function budgetStopAddress(state: WorkState): AddressLeg {
    return async () => ({
      status: 'needs-human',
      reason: 'review.address: token or wall budget exhausted; report: /tmp/r.json',
      report: addressReport(state, [capFinding], []),
    });
  }

  test('BEFORE (P1): an address BUDGET stop with a report propagates verbatim — NO push, NO PR, no draft', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: budgetStopAddress(state),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.reason).toContain('token or wall budget exhausted');
    expect(result.reason).not.toContain('NOT READY');
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  test('BEFORE (P1): a BLOCKED RE-REVIEW with a report propagates verbatim — NO push, NO PR', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: async () => ({
        status: 'needs-human',
        reason:
          'review.address: re-review: review.run: not every configured reviewer completed a terminal cycle; report: /tmp/r.json',
        report: addressReport(state, [capFinding], []),
      }),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('not every configured reviewer completed');
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  test('BEFORE (P1): an ADMISSION FAILURE with a report propagates verbatim — NO push, NO PR', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: async () => ({
        status: 'needs-human',
        reason:
          'review.address: engine bookkeeping changed; worker tree is dirty; report: /tmp/r.json',
        report: addressReport(state, [capFinding], []),
      }),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('engine bookkeeping changed');
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  test('BEFORE (P2 7kNi): the injected driver factory reaches the address leg', async () => {
    // The address leg runs its fail-closed denylist scan BEFORE resolving
    // any driver role; CI's coverage runner has no gitleaks binary, so the
    // probe binds the SAME hermetic gitleaks fixture the e2e address tests
    // use (process-backed clean scanner, never a production override).
    const scanner = await makeGitleaksFixture();
    vi.stubEnv('PATH', scanner.path);
    try {
      await runProbe();
    } finally {
      vi.unstubAllEnvs();
      await rm(scanner.root, { recursive: true, force: true });
    }

    async function runProbe(): Promise<void> {
      const state = await seed(repo);
      await seedReadyLedger(state);
      // The address leg reads cq.json and the LATEST findings record before
      // resolving any driver role; give the fixture a minimal config and a
      // seeded record at the CURRENT head so the leg gets past both to its
      // first factory resolve.
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'probe-check', args: [] } }],
          roles: {
            worker: { provider: 'fixture', model: 'probe-worker' },
            reviewer: { provider: 'fixture', model: 'probe-reviewer' },
          },
          budgets: { run: { maxTokens: 1000, wallMs: 20000 }, step: { wallMs: 5000 } },
          review: { reviewers: ['agent'], rounds: 1 },
        }),
      );
      await repo.write(
        '.cq/review/feature%2Fx/1.json',
        JSON.stringify({
          schemaVersion: 1,
          branch: state.branch,
          head: 'FRESH_HEAD',
          reviewed: { base: state.base, scope: 'full' },
          sources: [{ kind: 'agent', status: 'terminal' }],
          // One OPEN blocking finding: an empty record short-circuits to
          // admitCleanRecord BEFORE any worker resolves, which would never
          // reach the injected factory.
          findings: [
            {
              id: 'probe-f1',
              source: 'agent',
              file: 'src/a.ts',
              severity: 'major',
              text: 'probe: the factory must resolve the worker',
              status: 'open',
            },
          ],
        }),
      );
      repo.commitAll('probe config');
      repo.git('push', '-q', 'origin', 'feature/x');
      await seedReadyLedger(state);
      // The record must name the CURRENT head (the config commit moved it).
      const finalHead = repo.git('rev-parse', 'HEAD').trim();
      const recordText = await import('node:fs/promises').then((fs) =>
        fs.readFile(`${repo.root}/.cq/review/feature%2Fx/1.json`, 'utf8'),
      );
      await repo.write(
        '.cq/review/feature%2Fx/1.json',
        recordText.replace('FRESH_HEAD', finalHead),
      );
      // Probe: the injected factory is FORWARDED into the address leg's own
      // review construction (reviewDrivers wraps deps.drivers). The probe
      // factory RESOLVES with a driver whose run throws a marker; the re-review
      // inside the address leg therefore fails with 'agent review did not run:
      // <marker>' — the leg used the caller's wiring, not a real provider
      // factory. (Without forwarding, the default construction would resolve a
      // real provider and fail with a config error instead.)
      let resolveCalls = 0;
      const observingFactory: DriverFactory = {
        resolve: (request) => {
          resolveCalls++;
          void request;
          return {
            lane: 'ai-sdk' as const,
            modelSpec: { provider: 'probe', model: 'probe' },
            driver: {
              run: async () => {
                throw new Error('probe: the address leg ran the injected factory');
              },
            },
          };
        },
      };
      const op = makeDevCycle({
        effects: effects(),
        check: greenCheck(),
        review: cleanReview(state),
        open: openFake([]),
        drivers: observingFactory,
      });
      const result = await op({ repoRoot: repo.root });
      expect(result.status === 'failed' || result.status === 'needs-human').toBe(true);
      // The wiring observable: the injected factory's resolve() was CALLED by
      // the address leg's own review construction (reviewDrivers wraps the
      // forwarded factory). Without the forward, the leg would construct a
      // real provider factory and this probe would never resolve.
      expect(resolveCalls).toBeGreaterThan(0);
      // The leg's own re-review ran through the probe and failed honestly (the
      // marker lands in the blocked findings record's source reason, which
      // review.run summarizes); the composition surfaced that re-review
      // refusal verbatim instead of a provider-config error.
      expect(result.status === 'needs-human' && result.reason).toContain('re-review');
    }
  });

  test('BEFORE (P2 7kNl): the follow-up command carries the quoted repoRoot', () => {
    expect(followUpCommand(7, '/tmp/my repo')).toBe(
      `cq review.address --repoRoot='${'/tmp/my repo'}' --source=pr:7`,
    );
    expect(followUpCommand(7, '/plain/path')).toBe(
      "cq review.address --repoRoot='/plain/path' --source=pr:7",
    );
  });

  test('P2 v9bK7: the follow-up command carries a NON-DEFAULT target, quoted; the default is omitted', () => {
    expect(followUpCommand(7, '/repo', 'main')).toBe(
      "cq review.address --repoRoot='/repo' --target='main' --source=pr:7",
    );
    expect(followUpCommand(7, '/repo', "o'brien-queue")).toBe(
      "cq review.address --repoRoot='/repo' --target='o'\\''brien-queue' --source=pr:7",
    );
    // The default target changes nothing about the comparison: omit it.
    expect(followUpCommand(7, '/repo', 'merge-queue')).toBe(
      "cq review.address --repoRoot='/repo' --source=pr:7",
    );
    expect(followUpCommand(7, '/repo')).toBe("cq review.address --repoRoot='/repo' --source=pr:7");
  });

  test('P2 v9bK7 (e2e): a non-default --target flows into the published report and the cap reason', async () => {
    await seed(repo);
    repo.git('push', '-q', 'origin', 'origin/merge-queue:refs/heads/main');
    repo.git('fetch', '-q', 'origin');
    repo.git('push', '-q', 'origin', 'feature/x');
    // Records must be pinned to the MAIN target (readiness refuses records
    // recorded for another target). The open leg captures the target it was
    // called with; the clean address leg ends ok, so the READY path runs.
    const opens: PrOpenInput[] = [];
    const state2 = await seed(repo, () => []);
    const at = { base: state2.base, head: state2.head, dirtySha256: state2.dirtySha256 };
    const records = [
      cycleRecord({ ...at, target: 'main' }),
      checkRecord({ ...at, target: 'main' }),
    ];
    repoEffects(repo)
      .openLedger(state2.branch)
      .save({ version: seedLedgerVersion, branch: state2.branch, records });
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state2),
      address: cleanAddress(state2),
      open: openFake(opens, 46),
      git: async () => ({ code: 0, stdout: `${state2.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root, target: 'main' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(opens[0]?.target).toBe('main');
      expect(result.value.followUp).toBe(followUpCommand(46, repo.root, 'main'));
      expect(result.value.followUp).toContain("--target='main'");
    }
  });

  test('P2 v9bK8: the cap path PRESERVES a failed publication (never converted to needs-human)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: roundCapAddress(state),
      open: async () => ({
        status: 'failed',
        error: 'pr.open: the PR could not be opened — gh: 502',
      }),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    // The same forge failure must produce the same status as on the clean
    // path: failed (exit 1), not needs-human (exit 3).
    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(result.error).toBe(
        'dev.cycle (pr.open): pr.open: the PR could not be opened — gh: 502',
      );
  });

  test('P2 v9bK8: the cap path PRESERVES an indeterminate publication (never erased)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: roundCapAddress(state),
      open: async () => ({
        status: 'indeterminate',
        detail: 'pr.open: the creation outcome is uncertain — the forge answered 529',
      }),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate')
      expect(result.detail).toContain('the creation outcome is uncertain');
  });

  test('P2 v9bK9: with an injected open and NO gh, the cap path performs NO production-gh body edit (the injected leg owns the forge)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    // The production gh effects would run `gh` against input.repoRoot; the
    // fixture repo has no remote/gh config, so any production call would
    // fail loudly. Assert instead on the pure structural fact: the compose
    // never runs (no getPrBody possible), and the op still publishes the
    // draft reason.
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: roundCapAddress(state),
      open: openFake([]),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
      // NO gh injected: the injected open owns the forge.
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('NOT READY');
      expect(result.reason).toContain('draft PR #42');
      // No '(pr body)' fault: the composition never touched a forge.
      expect(result.reason).not.toContain('pr body');
    }
  });

  test('BEFORE (P1 7kNb-delta): the FINAL deterministic gates run BEFORE round-cap publication — a red gate refuses verbatim with NO push and NO PR', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    let checkRuns = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        checkRuns++;
        if (checkRuns === 1) return greenCheck()({ ...input });
        // The final gates (run after the round-cap stop, before any
        // publication) went red — a fix that breaks format must not
        // publish as a draft.
        return { status: 'failed', error: 'dev.check: the addressed head broke format:check' };
      },
      review: cleanReview(state),
      address: roundCapAddress(state),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(result.error).toBe(
        'dev.cycle (dev.check (final)): dev.check: the addressed head broke format:check',
      );
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  // ---- #509 (owner, 2026-10-27): a re-review still blocked on the
  // network/transient class after its retry, with ≥1 verified fix, publishes
  // a DRAFT naming the blocked re-review — final gates first.

  /** The production finish() shape for the blocked-re-review stop. */
  function rereviewBlockedAddress(state: WorkState): AddressLeg {
    return async () => ({
      status: 'needs-human',
      reason:
        'review.address: re-review: review.run: not every configured reviewer completed a terminal cycle; report: /tmp/r.json',
      report: {
        ...addressReport(state, [capFinding], []),
        fixesPerRun: 1,
        stop: 'rereview-blocked' as const,
      },
    });
  }

  test('#509: a blocked re-review with a verified fix runs the final gates, pushes and publishes a DRAFT naming it', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    const checks: string[] = [];
    let pushCalls = 0;
    const { gh, bodies } = ghFake();
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(checks),
      review: cleanReview(state),
      address: rereviewBlockedAddress(state),
      open: openFake(opens),
      gh,
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.reason).toContain('NOT READY');
    expect(result.reason).toContain('the re-review was blocked after verified fixes');
    expect(result.reason).toContain('not every configured reviewer completed');
    expect(result.reason).toContain('draft PR #42');
    expect(checks).toHaveLength(2);
    expect(pushCalls).toBe(1);
    expect(opens).toEqual([
      { repoRoot: repo.root, target: 'merge-queue', draft: true, draftWhenNotReady: true },
    ]);
    // The findings section names the blocked re-review, never the round cap.
    expect(bodies[0]).toContain(DEV_FINDINGS_SECTION_MARKER);
    expect(bodies[0]).toContain('## Findings after a blocked re-review');
    expect(bodies[0]).toContain('made 1 verified fix(es), then its re-review stayed blocked');
    expect(bodies[0]).not.toContain('round cap');
  });

  test('#509: a red FINAL gate on the blocked-re-review path refuses verbatim — NO push, NO PR', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    let checkRuns = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        checkRuns++;
        if (checkRuns === 1) return greenCheck()({ ...input });
        return { status: 'failed', error: 'dev.check: the addressed head broke format:check' };
      },
      review: cleanReview(state),
      address: rereviewBlockedAddress(state),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  test('a push failure after a clean loop is needs-human naming the branch (nothing opens)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake(opens),
      git: async () => ({ code: 128, stdout: '', stderr: 'remote: permission denied' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('dev.cycle (push)');
      expect(result.reason).toContain("the push of 'feature/x' failed");
      expect(result.reason).toContain('permission denied');
    }
    expect(opens).toEqual([]);
  });

  test('a forge failure AFTER the push is a failed op naming the pr.open leg (the branch IS published)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: async () => ({
        status: 'failed',
        error: 'pr.open: the PR could not be opened — gh: 502',
      }),
      git: async (args) => {
        if (args.includes('push')) {
          pushCalls++;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('dev.cycle (pr.open)');
    expect(pushCalls).toBe(1);
  });

  test('a not-ready branch after a clean address publishes the DRAFT with the gaps (untracked files never bypassed)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    await repo.write('scratch/new.ts', 'export {};\n');
    const { gh, bodies } = ghFake();
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake(opens, 44, false),
      gh,
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('NOT READY');
      expect(result.reason).toContain('untracked non-ignored files');
      expect(result.reason).toContain(followUpCommand(44, repo.root));
    }
    expect(opens).toEqual([
      { repoRoot: repo.root, target: 'merge-queue', draft: true, draftWhenNotReady: true },
    ]);
    // A clean address report carries NO findings section: nothing is open.
    expect(bodies).toEqual([]);
  });

  test('a schema-bypassing input fails at the boundary with zero effects', async () => {
    const dev = repoEffects(repo, () => {
      throw new Error('no command may run');
    });
    const op = makeDevCycle({ effects: dev });
    const result = await op({ repoRoot: '' } as never);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('invalid input');
  });
});

describe('followUpCommand and renderFindingsSection', () => {
  test('the follow-up command spells the PR-side address source', () => {
    expect(followUpCommand(7, '/repo')).toBe("cq review.address --repoRoot='/repo' --source=pr:7");
  });

  test('the findings section is markdown-safe and carries every attempt', () => {
    const state = {
      branch: 'feature/x',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
    } as WorkState;
    const finding = {
      id: 'c001|x',
      source: 'agent',
      file: 'src/a|b.ts',
      severity: 'major',
      text: 'has `backticks` and <script>',
      status: 'open' as const,
    };
    const report = addressReport(
      state,
      [finding],
      [
        {
          finding: 'c001|x',
          tier: 'rescue',
          attempt: 2,
          invocation: 'feedback',
          reason: 'the fix did not compile',
          model: { provider: 'fixture', model: 'rescue|m' },
          observedHead: state.head,
          wallMs: 1200,
        },
      ],
    );
    const section = renderFindingsSection(report);
    expect(section.startsWith(DEV_FINDINGS_SECTION_MARKER)).toBe(true);
    expect(section).toContain('<!-- /cq:dev-findings -->');
    // mdLine: pipes escape even inside code spans; mdSafe rewrites backticks
    // to typographic apostrophes and strips angle brackets.
    expect(section).toContain('`c001\\|x`');
    expect(section).toContain('src/a\\|b.ts');
    expect(section).toContain('’backticks’');
    // mdSafe strips angle brackets entirely: '<script>' → 'script'.
    expect(section).toContain('and script');
    expect(section).not.toContain('<script>');
    expect(section).toContain('rescue/feedback #2');
    expect(section).toContain('1200ms');
  });

  test('an empty attempt log renders the explicit none-note', () => {
    const state = {
      branch: 'feature/x',
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
    } as WorkState;
    const section = renderFindingsSection(addressReport(state, [], []));
    expect(section).toContain('(no attempts were dispatched)');
    expect(section).toContain('(none)');
  });
});
