import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  DEV_FINDINGS_SECTION_MARKER,
  followUpCommand,
  makeDevCycle,
} from '../../../src/ops/dev/cycle.js';
import { DEV_READINESS_GAPS_SECTION_MARKER } from '../../../src/ops/pr/open.js';
import type { PrOpenInput } from '../../../src/ops/pr/open.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { WorkState } from '../../../src/ops/dev/internal/workState.js';
import { dispositionRecord } from './fakes.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';
import {
  addressReport,
  bindCycleRepo,
  capFinding,
  cleanAddress,
  cleanReview,
  ghFake,
  greenCheck,
  openFake,
  roundCapAddress,
  roundCapAddressProductionShape,
  seedReadyLedger,
  structuredStopAddress,
  type AddressLeg,
} from './cycle.helpers.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
  bindCycleRepo(repo);
});
afterEach(async () => {
  await repo.cleanup();
});

const effects: () => DevEffects = () => repoEffects(repo);

describe('dev.cycle', () => {
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
      { repoRoot: repo.root, target: 'main', draft: true, draftWhenNotReady: true },
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
      { repoRoot: repo.root, target: 'main', draft: true, draftWhenNotReady: true },
    ]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(DEV_FINDINGS_SECTION_MARKER);
  });

  test.each([
    ['budget', 'review.address: token or wall budget exhausted; report: /tmp/r.json'],
    [
      'rereview-blocked',
      'review.address: re-review: review.run: not every configured reviewer completed a terminal cycle; report: /tmp/r.json',
    ],
  ] as const)(
    'an address %s stop publishes a DRAFT with the original reason: %s',
    async (stop, reason) => {
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
        address: structuredStopAddress(state, stop, reason),
        open: openFake(opens),
        gh,
        git: async (args) => {
          if (args.includes('push')) {
            pushCalls++;
            expect(args.at(-1)).toBe(`${state.head}:refs/heads/feature/x`);
          }
          return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
        },
      });
      const result = await op({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      expect(result.reason).toContain('NOT READY');
      expect(result.reason).toContain(reason);
      expect(result.reason).toContain('draft PR #42');
      // The composition frames the stop exactly as production finish() named
      // it — the run-budget framing for 'budget', the blocked-re-review
      // framing for 'rereview-blocked'.
      expect(result.reason).toContain(
        stop === 'budget'
          ? 'review.address stopped on the run budget'
          : 'the re-review was blocked after verified fixes',
      );
      // The final gates ran before the publication (first check + final check).
      expect(checks).toHaveLength(2);
      expect(pushCalls).toBe(1);
      expect(opens).toEqual([
        { repoRoot: repo.root, target: 'main', draft: true, draftWhenNotReady: true },
      ]);
      // The open findings ride the draft like the round cap's, and the
      // section names ITS OWN structured stop — a blocked re-review must not
      // masquerade under the run-budget heading (or vice versa).
      expect(bodies[0]).toContain(DEV_FINDINGS_SECTION_MARKER);
      expect(bodies[0]).toContain('c001-aaaaaaaa#f1');
      expect(bodies[0]).not.toContain('round cap');
      if (stop === 'budget') {
        expect(bodies[0]).toContain('stopped on the run budget');
        expect(bodies[0]).not.toContain('blocked re-review');
      } else {
        expect(bodies[0]).toContain('blocked re-review');
        expect(bodies[0]).not.toContain('stopped on the run budget');
      }
    },
  );

  test('a stopped-run draft whose findings section cannot be composed says the draft is open without it', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    const { gh } = ghFake();
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: structuredStopAddress(
        state,
        'budget',
        'review.address: token or wall budget exhausted; report: /tmp/r.json',
      ),
      open: openFake(opens),
      gh: {
        ...gh,
        editPrBody: async () => {
          throw new Error('body write refused');
        },
      },
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    // The draft exists (pr.open ran once); the refusal names it and the
    // compose fault instead of claiming a complete publication.
    expect(opens).toHaveLength(1);
    expect(result).toMatchObject({
      status: 'needs-human',
      reason:
        'dev.cycle (pr body): draft PR #42 is open but the findings section could not be composed — body write refused',
    });
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
      { repoRoot: repo.root, target: 'main', draft: true, draftWhenNotReady: true },
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
      // The clean leg's report rides its VALUE (addressReportOf), so the
      // findings section IS composed and the reason's attempt-log claim is
      // true on this path.
      expect(result.reason).toContain('and the attempt log');
    }
    expect(opens).toEqual([
      { repoRoot: repo.root, target: 'main', draft: true, draftWhenNotReady: true },
    ]);
    // The findings section is composed with the CLEAN-RUN framing: no
    // round-cap "stopped" text on a run that finished clean.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(DEV_FINDINGS_SECTION_MARKER);
    expect(bodies[0]).toContain('## Open findings after a clean address run (readiness gaps)');
    expect(bodies[0]).toContain('review.address finished clean');
    expect(bodies[0]).not.toContain('round cap');
  });
});
