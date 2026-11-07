// run-plan through the governed kernel — split from test/cli/i1.test.ts (pure move). Suite header: op-subcommands.test.ts; helpers: ./i1-helpers.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { acquirePlanLock, openRunLog } from '../../src/kernel/journal.js';
import { PlanSchema, RunReportSchema } from '../../src/kernel/schema.js';
import { capture, makeTmpDir, opsRoot, singleJobPlan, writePlanFile } from './i1-helpers.js';

describe('run-plan through the governed kernel', () => {
  test('happy path: one done job, report parses, human narration counts', async () => {
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--concurrency=1',
    ]);
    expect(code).toBe(0);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.counts.done).toBe(1);
    expect(report.jobs[0]?.result.status).toBe('ok');
    expect(err).toContain('cq: done 1'); // the renderHuman summary line
  });

  test('--json: stderr stays empty, report unchanged', async () => {
    const { planPath } = await writePlanFile(singleJobPlan('echo'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      '--json',
    ]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(RunReportSchema.parse(JSON.parse(out)).counts.done).toBe(1);
  });

  test('--max-usd=0 is accepted: a hard-zero ceiling now REFUSES dispatch loudly (W2.3 reserve-then-settle, exit 3)', async () => {
    // RunPlanInputSchema used z.number().positive(), rejecting --max-usd=0 as
    // a usage error — but the governor explicitly accepts maxUsd >= 0 (a
    // valid hard-zero spend ceiling, src/kernel/governor.ts). Under W2.2 the
    // cap bound only on PRICED spend, so a no-usage plan ran to completion
    // (exit 0) — the fail-open corner. Under W2.3 reserve-then-settle the
    // admission invariant S + O + r <= C admits NOTHING at C = 0: the first
    // reserve trips `exhausted` before any dispatch, the row is
    // budget-exhausted, and the run exits 3 — a zero budget that dispatches
    // anyway is exactly the lie the cap exists to prevent.
    // --allow-advisory-budget is REQUIRED for this to be the ZERO-CAP test:
    // without the A12c escape the advisory gate (v1.1: every dispatch
    // advisory, unattended) refuses first with `reservation-refused
    // {reason:'advisory-lane'}`, the same observable verdict — exit 3, one
    // budget-exhausted row — so the report assertions alone cannot tell the
    // two paths apart. The journal assertions below do.
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      '--max-usd=0',
      `--journal-dir=${journalDir}`,
      '--allow-advisory-budget',
    ]);
    expect(code).toBe(3);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.counts.done).toBe(0);
    expect(report.counts['budget-exhausted']).toBe(1);
    expect(report.stoppedEarly).toBe(false); // the refusal row IS the verdict; nothing was gated
    expect(err).not.toContain('cq: done 1');
    // The zero-cap TRIP is what refused: a durable budget-tripped fact, and
    // no reservation ever opened (the seed at C=0 does not trip — `0 > 0` is
    // false — so the first `reserve` is the trip).
    const events = await openRunLog(journalDir).read(report.runId);
    expect(events.some((event) => event.type === 'reservation-refused')).toBe(false);
    expect(events.some((event) => event.type === 'reservation-opened')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'budget-tripped', tripKind: 'exhausted' }),
    );
  });

  test('annex §3 rule-7 notice: the governed run after an ungoverned-marked run narrates the excluded runs', async () => {
    // Run 1: governed (capped) — creates the governed history. Run 2: the
    // ungoverned-marked opt-in — sits outside the bound. Run 3: governed
    // again — its ledger seed excludes run 2, and the CLI must say so
    // (human mode). A --json governed run narrates nothing.
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    const base = [
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--concurrency=1',
    ];
    const first = await capture([...base, '--max-usd=5', '--allow-advisory-budget']);
    expect(first.code).toBe(0);
    expect(first.err).not.toContain('bound excludes'); // nothing to exclude yet

    const marked = await capture([...base, '--opt-in=budget.ungovernedOverGoverned']);
    expect(marked.code).toBe(0);

    const log = openRunLog(journalDir);
    const markedRunIds: string[] = [];
    for (const runId of await log.runs()) {
      const started = (await log.read(runId))[0] as { type: string; ungoverned?: unknown };
      if (started.type === 'run-started' && 'ungoverned' in started) markedRunIds.push(runId);
    }
    expect(markedRunIds).toHaveLength(1);

    const third = await capture([...base, '--max-usd=5', '--allow-advisory-budget']);
    expect(third.code).toBe(0);
    expect(third.err).toContain(`cq: bound excludes ungoverned runs ${markedRunIds[0] as string}`);

    const jsonMode = await capture([...base, '--max-usd=5', '--allow-advisory-budget', '--json']);
    expect(jsonMode.code).toBe(0);
    expect(jsonMode.err).toBe(''); // machine mode stays silent
  });

  test('an UNCAPPED run with --journal-dir stays v1-identical: the run-started record carries NO journalVersion', async () => {
    // The CLI's recorded policy: governance rides exactly the operator's
    // cap — an uncapped run gets no governor, no ledger, and no v2 journal.
    // The journal then holds a plain v1 record (no journalVersion, no seq,
    // no governance block), pinned here from the file the run wrote.
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    const { code, out } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--concurrency=1',
    ]);
    expect(code).toBe(0);
    expect(RunReportSchema.parse(JSON.parse(out)).counts.done).toBe(1);
    const log = openRunLog(journalDir);
    const runs = await log.runs();
    expect(runs).toHaveLength(1);
    const events = await log.read(runs[0] as string);
    const started = events[0] as { type: string; journalVersion?: unknown; seq?: unknown };
    expect(started.type).toBe('run-started');
    expect('journalVersion' in started).toBe(false);
    expect('seq' in started).toBe(false);
  });

  test('failing job: exit 1 with a failed row, narrated', async () => {
    const { planPath } = await writePlanFile(singleJobPlan('boom'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(code).toBe(1);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.jobs[0]?.result.status).toBe('failed');
    expect(err).toContain('boom');
  });

  test('needs-human job exits 3; op-returned budget row also exits 3', async () => {
    // needs-human row → 3 (waiting on a human).
    const human = await capture([
      'run-plan',
      `--plan=${(await writePlanFile(singleJobPlan('needshuman'))).planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(human.code).toBe(3);
    expect(RunReportSchema.parse(JSON.parse(human.out)).jobs[0]?.result.status).toBe('needs-human');
    // The budget fixture RETURNS budget-exhausted as its op verdict — an
    // op-returned row, NOT a governor trip (no caps configured, so the run
    // is ungoverned and no governor exists to trip); exitCodeForRunReport
    // still maps the row to 3.
    const budget = await capture([
      'run-plan',
      `--plan=${(await writePlanFile(singleJobPlan('budget'))).planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(budget.code).toBe(3);
    expect(RunReportSchema.parse(JSON.parse(budget.out)).jobs[0]?.result.status).toBe(
      'budget-exhausted',
    );
  });

  test('unknown op name in the plan: exit 1 with a failed row', async () => {
    const { planPath } = await writePlanFile(singleJobPlan('no-such-op'));
    const { code, out } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(code).toBe(1);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.jobs[0]?.result.status).toBe('failed');
  });

  test('input defects are usage errors (2): corrupt content, missing file, directory path', async () => {
    // Unparseable content = corrupted INPUT → exit 2 (arg-shaped, narrated).
    const corrupt = await writePlanFile('not json');
    const corruptRun = await capture([
      'run-plan',
      `--plan=${corrupt.planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(corruptRun.code).toBe(2);
    expect(corruptRun.out).toBe('');
    expect(corruptRun.err).toMatch(/invalid input for 'run-plan'/);

    // A MISSING plan file is the same input-defect class → 2 (previously a
    // thrown 1 — the stale pin this suite once carried; PR 64 r1 flipped it).
    const dir = await makeTmpDir('cq-i1-missingplan-');
    const missingRun = await capture([
      'run-plan',
      `--plan=${join(dir, 'absent.json')}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(missingRun.code).toBe(2);
    expect(missingRun.out).toBe('');
    expect(missingRun.err).toMatch(/invalid input for 'run-plan'/);
    expect(missingRun.err).toMatch(/not a readable file/);

    // A DIRECTORY where a plan file should be is not a regular file → also an
    // input defect → 2 (the stat gate precedes the read; no EISDIR throw).
    const dirPlan = join(dir, 'plan-dir');
    await mkdir(dirPlan);
    const dirRun = await capture(['run-plan', `--plan=${dirPlan}`, `--ops-root=${opsRoot}`]);
    expect(dirRun.code).toBe(2);
    expect(dirRun.out).toBe('');
    expect(dirRun.err).toMatch(/invalid input for 'run-plan'/);
    expect(dirRun.err).toMatch(/not a readable file/);
  });

  test('journal-unsafe plan id + --journal-dir: kernel journal assert → exit 2, not 1', async () => {
    // PlanSchema accepts any string id, but a JOURNALED runId becomes a file
    // name (`<runId>.ndjson`), so makeRunId → assertSafeRunId throws
    // `journal: …` from inside runPlan for a schema-valid plan like
    // id 'bad/id'. The plan id is still the defective INPUT, so the
    // filename-safety classifier maps it to the usage path: exit 2, stdout empty,
    // stderr naming the journal assert — never the thrown-class exit 1.
    const { planPath, journalDir } = await writePlanFile({
      id: 'bad/id',
      jobs: [{ id: 'a', op: 'echo', input: { msg: 'hi' } }],
    });
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
    ]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan': journal: /);
    expect(err).toMatch(/runId must match/);
  });

  test('claimed sequence without a run journal is runtime corruption (1), not usage (2)', async () => {
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    await mkdir(journalDir);
    await writeFile(join(journalDir, 'i1-plan.seq.1'), '');
    const argv = [
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--max-tokens=100',
    ];
    const human = await capture(argv);
    expect(human.code).toBe(1);
    expect(human.out).toBe('');
    expect(human.err).toMatch(/run-plan threw: journal: corrupt.*seq gap/);
    expect(human.err).not.toContain('invalid input');

    const machine = await capture([...argv, '--json']);
    expect(machine.code).toBe(1);
    expect(machine.err).toBe('');
    expect(JSON.parse(machine.out)).toMatchObject({
      error: { kind: 'thrown', subcommand: 'run-plan', exitCode: 1 },
    });
  });

  test('a held plan lock is TRANSIENT: the typed refusal exits 3, not usage 2 (ADR-0003 §2.9)', async () => {
    // A lock refusal is neither an input defect nor the run's own failure:
    // the holder may release, abort or die, so automation must retry. The
    // CLI maps the PlanLockRefusedError CLASS to 3 (2 would read as a
    // permanent usage error automation would never retry; 1 as the run's
    // failure). The holder is a real in-process lock over the same journal
    // dir, so the record's socket probe sees it alive; the message is the
    // narration contract, the class is the datum.
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    await mkdir(journalDir, { recursive: true });
    const holder = await acquirePlanLock(journalDir, 'i1-plan', 'holder-run');
    const argv = [
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
    ];
    try {
      const human = await capture(argv);
      expect(human.code).toBe(3);
      expect(human.out).toBe('');
      expect(human.err).toMatch(/plan locked by 'holder-run'/);
      expect(human.err).not.toMatch(/invalid input/);

      const machine = await capture([...argv, '--json']);
      expect(machine.code).toBe(3);
      expect(machine.err).toBe('');
      expect(JSON.parse(machine.out)).toMatchObject({
        error: { kind: 'thrown', subcommand: 'run-plan', exitCode: 3 },
      });
    } finally {
      await holder.release();
    }
  });

  test('duplicate job ids: PlanSchema-valid file, kernel input-class throw → exit 2', async () => {
    // PlanSchema does not cross-validate job ids, so this file parses — the
    // duplicate surfaces in the kernel, whose message starts with 'runPlan: '
    // (the input-validation class) → narrated usage error, stdout empty.
    const dupPlan = {
      id: 'i1-dup',
      jobs: [
        { id: 'same', op: 'echo', input: { msg: 'a' } },
        { id: 'same', op: 'echo', input: { msg: 'b' } },
      ],
    };
    expect(() => PlanSchema.parse(dupPlan)).not.toThrow();
    const { planPath } = await writePlanFile(dupPlan);
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan': runPlan: duplicate job id 'same'/);
  });

  test('--resume without --journal-dir: kernel input-class throw → exit 2', async () => {
    const { planPath } = await writePlanFile(singleJobPlan('echo'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      '--resume',
    ]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan': runPlan: resume: true requires journalDir/);
  });

  test('non-canonical numeric spellings coerce for numeric fields', async () => {
    // parseFlags runs schema-less for run-plan, so a trailing-zero decimal or
    // exponent stays the raw string (#386); the run-plan normalizer converts
    // it where the schema type is known, so common spellings (--max-usd=5.0,
    // --max-usd=0.50, --max-tokens=1e6, --concurrency=1.0) are accepted
    // instead of rejected as invalid input (exit 2).
    const { planPath } = await writePlanFile(singleJobPlan('echo'));
    const base = [
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      '--allow-advisory-budget',
    ];
    const usd = await capture([...base, '--max-usd=5.0']);
    expect(usd.code).toBe(0);
    expect(RunReportSchema.parse(JSON.parse(usd.out)).counts.done).toBe(1);
    const zeroCap = await capture([...base, '--max-usd=0.50']);
    expect(zeroCap.code).toBe(0);
    expect(RunReportSchema.parse(JSON.parse(zeroCap.out)).counts.done).toBe(1);
    const exponent = await capture([...base, '--max-tokens=1e6']);
    expect(exponent.code).toBe(0);
    expect(RunReportSchema.parse(JSON.parse(exponent.out)).counts.done).toBe(1);
    const concurrency = await capture([...base, '--concurrency=1.0']);
    expect(concurrency.code).toBe(0);
    const garbage = await capture([...base, '--max-usd=abc']);
    expect(garbage.code).toBe(2);
    expect(garbage.out).toBe('');
    expect(garbage.err).toMatch(/invalid input for 'run-plan'/);
  });

  test('a genuine runtime throw stays 1: --journal-dir pointing at a regular file', async () => {
    // The plan path is fine; the JOURNAL open (mkdir) fails (EEXIST/ENOTDIR)
    // mid-run — not an input defect (no 'runPlan: ' prefix) — so it
    // propagates to main.ts's catch: narrated `run-plan threw: …`, exit 1,
    // stdout empty.
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    await writeFile(journalDir, 'a regular file, not a journal directory');
    const thrown = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
    ]);
    expect(thrown.code).toBe(1);
    expect(thrown.out).toBe('');
    expect(thrown.err).toMatch(/cq: run-plan threw:/);
  });
});

// PlanSchema is the kernel-side plan file contract runPlanCommand enforces;
// pin the fixture plans used above against it.
describe('plan file schema', () => {
  test('the fixture plan shape parses against PlanSchema', () => {
    const plan = PlanSchema.parse(singleJobPlan('echo'));
    expect(plan.id).toBe('i1-plan');
    expect(plan.jobs).toHaveLength(1);
  });
});
