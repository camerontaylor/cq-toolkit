// Resume seeds the governor + run-plan null-proto flags (wave-4) — split from test/cli/i1.test.ts (pure move). Suite header: op-subcommands.test.ts; helpers: ./i1-helpers.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { JournalEventSchema, RunReportSchema } from '../../src/kernel/schema.js';
import { capture, opsRoot, writePlanFile } from './i1-helpers.js';

// b2602ca successor pins (PR 64 wave-4), re-baselined for the v1.1 governed
// kernel: a CAPPED CLI run governs, and the governed fold continues the
// dir's ledger WITH OR WITHOUT --resume (a cumulative --max-tokens cap binds
// the run to its prior runs' usage — I9 honesty; the v1 pin that a fresh run
// starts at zero survives only for a dir with NO governed history), and
// run-plan's kebab→camel normalizer keeps the null-prototype flags record so
// --__proto__ reaches the strict schema as the unknown key it is (exit 2),
// instead of vanishing through the inherited accessor.
describe('resume seeds the governor; null-proto run-plan flags (wave-4)', () => {
  /**
   * Hand-written prior-run journal, field-for-field against the frozen
   * JournalEventSchema: run-started (runId/at/planId + journalVersion 2,
   * seq 1, governance — the v2 record a GOVERNED run writes and folds; a v1
   * run-started here would hit the unaccounted-v1-dispatches refusal, since
   * v1 journals carry no spend the cap could bind), job-started
   * (runId/at/jobId/op/attempt — REQUIRED: the seed's usage fold counts only
   * a finish that CLOSES an open start), job-finished (runId/at/jobId/opId/
   * inputsHash/result/usage). The file name is `<planId>--<seg>--<hex>` —
   * the candidate tail shape journal.candidateRunsForPlan requires. The
   * inputsHash is deliberately NOT the current job input's hash, so replay's
   * ok-skip is defeated and the job is genuinely re-dispatched into the
   * (hopefully seeded) governor.
   */
  async function writePriorJournal(journalDir: string, planId: string): Promise<void> {
    const runId = `${planId}--0001--abcd`;
    const at = '2026-01-01T00:00:00.000Z';
    const events = [
      {
        type: 'run-started',
        runId,
        at,
        planId,
        journalVersion: 2,
        seq: 1,
        governance: { attended: false },
      },
      { type: 'job-started', runId, at, jobId: 'a', op: 'echo', attempt: 1 },
      {
        type: 'job-finished',
        runId,
        at,
        jobId: 'a',
        opId: 'echo',
        inputsHash: 'prior-run-hash-not-the-current-inputs',
        result: { status: 'ok', value: { echo: 'hi' } },
        usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    for (const event of events) {
      expect(() => JournalEventSchema.parse(event)).not.toThrow();
    }
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      join(journalDir, `${runId}.ndjson`),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
  }

  test('resume + seeded usage trips --max-tokens: exit 3, earlyStopReason budget (without the seed this exits 0)', async () => {
    const { planPath, journalDir } = await writePlanFile({
      id: 'i1-resume',
      jobs: [
        { id: 'a', op: 'echo', input: { msg: 'hi' } },
        { id: 'b', op: 'echo', input: { msg: 'again' }, dependsOn: ['a'] },
      ],
    });
    await writePriorJournal(journalDir, 'i1-resume');
    const { code, out } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--resume',
      '--max-tokens=10',
    ]);
    // The seeded 100-token rollup (echo reports no usage of its own) trips
    // the 10-token cap AT SEED: job a's re-dispatch is refused
    // (budget-exhausted) and b, gated behind a, is re-marked by the
    // honest-stop pass → earlyStopReason 'budget' → exit 3.
    expect(code).toBe(3);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts['budget-exhausted']).toBe(2);
    expect(report.jobs.map((row) => row.result.status)).toEqual([
      'budget-exhausted',
      'budget-exhausted',
    ]);
  });

  test('a fresh capped run over a GOVERNED journal continues the ledger: seeded spend trips WITHOUT --resume too (the v1.1 contract)', async () => {
    // The old v1 pin — "the same journal + cap WITHOUT --resume starts at
    // zero" — is obsolete: a governed run folds the dir's history for LEDGER
    // continuity whether or not resume is set (only the replay-skip map is
    // resume-gated). This is the replacement pin, both halves:
    //   (a) with NO prior governed history, a fresh capped run starts at
    //       zero and exits 0;
    //   (b) over a governed journal, the SAME capped run seeds the prior
    //       usage and trips — the ledger continues.
    const fresh = await writePlanFile({
      id: 'i1-fresh-cap',
      jobs: [
        { id: 'a', op: 'echo', input: { msg: 'hi' } },
        { id: 'b', op: 'echo', input: { msg: 'again' }, dependsOn: ['a'] },
      ],
    });
    // The journal dir does NOT pre-exist: the governed seq claim
    // (journal.claimSeq) carries the append path's lazy-create contract, so
    // a first governed run over a fresh --journal-dir works (and this pin
    // proves it).
    const freshRun = await capture([
      'run-plan',
      `--plan=${fresh.planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${fresh.journalDir}`,
      '--max-tokens=10',
      '--allow-advisory-budget', // W2.3 A12c: a token cap is ADVISORY — unattended dispatch needs the escape
    ]);
    expect(freshRun.code).toBe(0); // empty dir → nothing seeded → caps start at zero
    expect(RunReportSchema.parse(JSON.parse(freshRun.out)).counts.done).toBe(2);

    const { planPath, journalDir } = await writePlanFile({
      id: 'i1-resume',
      jobs: [
        { id: 'a', op: 'echo', input: { msg: 'hi' } },
        { id: 'b', op: 'echo', input: { msg: 'again' }, dependsOn: ['a'] },
      ],
    });
    await writePriorJournal(journalDir, 'i1-resume');
    const { code, out } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--max-tokens=10',
      '--allow-advisory-budget', // W2.3 A12c escape — the seeded trip under test is the budget family
    ]);
    // The seeded 100-token rollup trips the 10-token cap: job a is refused
    // at admission, b is re-marked by the honest-stop pass → exit 3.
    expect(code).toBe(3);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts['budget-exhausted']).toBe(2);
  });

  test('uncapped over GOVERNED history refuses naming --opt-in; the opt-in resolves it (the refusal is actionable)', async () => {
    // The refusal's message names `--opt-in budget.ungovernedOverGoverned` —
    // the CLI must actually ACCEPT that flag (review cycle 1: a resolution
    // the surface cannot express is a dead end). An opt-in alone constructs
    // a governance handle (uncapped): the ungoverned opt-in marks the run
    // and it proceeds outside the ledger.
    const { planPath, journalDir } = await writePlanFile({
      id: 'i1-optin',
      jobs: [{ id: 'a', op: 'echo', input: { msg: 'hi' } }],
    });
    await writePriorJournal(journalDir, 'i1-optin');

    const refused = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.out).toBe('');
    expect(refused.err).toMatch(
      /runPlan: plan i1-optin has governed history; run governed or pass --opt-in budget\.ungovernedOverGoverned/,
    );

    const opted = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--opt-in=budget.ungovernedOverGoverned',
    ]);
    expect(opted.code).toBe(0);
    const report = RunReportSchema.parse(JSON.parse(opted.out));
    expect(report.counts.done).toBe(1); // the op ran, ungoverned-marked
  });

  test('--opt-in validates keys and splits on commas: an unknown key is exit 2', async () => {
    const { planPath } = await writePlanFile({
      id: 'i1-optin-bad',
      jobs: [{ id: 'a', op: 'echo', input: { msg: 'hi' } }],
    });
    const bad = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      '--opt-in=budget.raiseCap,budget.nonsense',
    ]);
    expect(bad.code).toBe(2);
    expect(bad.out).toBe('');
    expect(bad.err).toMatch(/invalid input for 'run-plan'/);
    expect(bad.err).toMatch(/optIn/);
  });

  test('run-plan null-proto normalizer: --__proto__ is an OWN key → the strict schema rejects it (exit 2)', async () => {
    // With the plain-{} record this flag silently vanished (inherited
    // __proto__ accessor) and the run proceeded to stat('p') — the narration
    // said "not a readable file". The null-proto record makes the key an own
    // property, so RunPlanInputSchema's unknown-key check fires: the exact
    // narration below is the proof the flag was SEEN, not dropped.
    const { code, out, err } = await capture([
      'run-plan',
      '--plan=p',
      '--__proto__={"plan":"/etc/passwd"}',
    ]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan'/);
    expect(err).toMatch(/Unrecognized key: "__proto__"/);
    expect(err).not.toMatch(/not a readable file/);
  });
});
