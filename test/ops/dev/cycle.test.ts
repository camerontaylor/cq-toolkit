// dev.cycle composition tests over a REAL git repo with a bare `origin` and
// fully scripted ops legs (the dev-family repo harness plus fakes): the
// clean loop publishes a ready PR at the addressed head; the round cap
// publishes a DRAFT carrying the gaps and the open-findings + attempt-log
// section and resolves needs-human with the follow-up command; every other
// refusal surfaces verbatim and never bypasses its leg. No provider, no
// network, no credentials.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  DEV_FINDINGS_SECTION_MARKER,
  followUpCommand,
  makeDevCycle,
  renderFindingsSection,
} from '../../../src/ops/dev/cycle.js';
import { DEV_READINESS_GAPS_SECTION_MARKER } from '../../../src/ops/pr/open.js';
import type { DevCheckReport } from '../../../src/ops/dev/check.js';
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

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const effects: () => DevEffects = () => repoEffects(repo);

type CheckLeg = (input: { repoRoot: string; target?: string }) => Promise<OpResult<DevCheckReport>>;
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

/** A scripted ROUND-CAP address leg: needs-human WITH the report attached. */
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
    report: addressReport(state, [capFinding], attempts),
  });
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
    expect(result.value.followUp).toBe(followUpCommand(42));
    expect(result.value.pr.number).toBe(42);
    expect(result.value.pr.ready).toBe(true);
    // TWO check legs: before the review and after the address.
    expect(checkCalls).toEqual(['check:merge-queue', 'check:merge-queue']);
    // The PR opened ready (no draft flags), at the intended target.
    expect(opens).toEqual([{ repoRoot: repo.root, target: 'merge-queue' }]);
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
    expect(result.reason).toContain(`follow-up: ${followUpCommand(43)}`);
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
      expect(result.reason).toContain(followUpCommand(44));
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
    expect(followUpCommand(7)).toBe('cq review.address --source=pr:7');
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
