// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// in sweep.e2e.helpers.ts and the original suite header sits there.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { JournalEventSchema } from '../../../src/kernel/schema.js';
import { fingerprintFailure } from '../../../src/ops/gates/fingerprint.js';
import { SWEEP_PLAN_ID } from '../../../src/plans/sweep.js';
import {
  ALPHA_FAILURE_MESSAGE,
  ALPHA_FIX,
  SCRATCH_PACKAGE_FILES,
} from '../../fixtures/scratch-repo/generate.js';
import type { RunReport } from '../../../src/kernel/types.js';
import { runEventsAt, runSweepPlan } from './run-sweep.js';
import {
  assembleReport,
  expectCompleteJournal,
  expectTrackerFirstFleet,
  expectUnitOverlap,
  gitOut,
  optsFor,
  prompts,
  readInWorktree,
  scenario,
  unitRow,
} from './sweep.e2e.helpers.js';

// ---------------------------------------------------------------------------
// 1. The happy path
// ---------------------------------------------------------------------------

describe('sweep e2e: probes → fix → gates → PRs (arm-a §4.2 steps 1–7)', () => {
  test(
    'two seeded packages: alpha fixed + committed, beta untouched, tracker-first fleet, clean journal, failures-only output',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-happy');
      const outcome = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, {}), { concurrency: 2 }),
      );

      // Phase A: both packages selected, one unit each.
      expect(outcome.planner.units).toEqual([
        { package: 'alpha', fixer: 'fix', files: SCRATCH_PACKAGE_FILES['alpha'] },
        { package: 'beta', fixer: 'fix', files: SCRATCH_PACKAGE_FILES['beta'] },
      ]);

      // Phase B: every unit job done — plan + two units (the assemble leg is
      // the marker-filtered second dispatch, jTPa8).
      expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0, queued: 0 });

      // Alpha: failing baseline → fixed → clean final → no-regression → committed.
      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('ok');
      const alphaReport = alpha.report;
      expect(alphaReport?.baseline.verdict).toBe('failing');
      expect(alphaReport?.baseline.failureSet?.failures[0]?.message).toBe(ALPHA_FAILURE_MESSAGE);
      expect(alphaReport?.final?.verdict).toBe('clean');
      expect(alphaReport?.regression?.verdict).toBe('no-regression');
      expect(alphaReport?.regression?.fixedFailures).toHaveLength(1);
      // The fixed failure IS the seeded one: it keeps the baseline failure's
      // fingerprint (identity through the gate, not just a count).
      const originalFailure = alphaReport?.baseline.failureSet?.failures[0];
      const fixedFailure = alphaReport?.regression?.fixedFailures[0];
      expect(originalFailure).toBeDefined();
      expect(fixedFailure).toBeDefined();
      if (originalFailure !== undefined && fixedFailure !== undefined) {
        expect(fingerprintFailure(fixedFailure)).toBe(fingerprintFailure(originalFailure));
      }
      expect(alphaReport?.worktree.reused).toBe(false);
      expect(alphaReport?.tamperFindings).toEqual([]);
      expect(alphaReport?.committed).toBe(true);
      expect(alphaReport?.prBranch).toBe('cq/e2e-happy/fix/alpha');

      // Alpha's production fix landed in the worktree AND in a commit; beta's
      // module is untouched and its branch carries no commit.
      expect(readInWorktree(scene.repo, 'alpha', 'packages/alpha/src/calculation.js')).toContain(
        ALPHA_FIX.newText,
      );
      const alphaCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-happy/fix/alpha'],
        scene.repo,
      );
      expect(alphaCommits.trim()).toBe('1');
      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('ok');
      expect(beta.report?.baseline.verdict).toBe('clean');
      expect(beta.report?.committed).toBe(false);
      const betaCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-happy/fix/beta'],
        scene.repo,
      );
      expect(betaCommits.trim()).toBe('0');

      // The fleet: tracker-first, manifest updated in place — and composed
      // from the COMMITTED MARKERS (jTPa8): beta no-oped (nothing to fix →
      // uncommitted → no marker), so the assemble covers ALPHA ONLY; a
      // no-change unit never assembles an empty-diff PR.
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.tracker).toMatchObject({ number: 1, created: true });
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
      expectTrackerFirstFleet(
        scene,
        'cq/e2e-happy',
        ['cq/e2e-happy/fix/alpha'],
        assembled.packages,
      );

      // The journal shows every step: run 0 = units, run 1 = the marker-
      // filtered assemble dispatch.
      await expectCompleteJournal(
        scene.journalDir,
        [
          ['sweep-plan', 'sweep.planSweep'],
          ['sweep-alpha-fix', 'sweep.unit'],
          ['sweep-beta-fix', 'sweep.unit'],
        ],
        0,
      );
      await expectCompleteJournal(
        scene.journalDir,
        [
          ['sweep-tracker-branch', 'pr.ensureTrackerBranch'],
          ['sweep-assemble', 'pr.assemblePrs'],
        ],
        1,
      );
      await expectUnitOverlap(scene.journalDir, 0, ['sweep-alpha-fix', 'sweep-beta-fix']);
      const journalFiles = readdirSync(scene.journalDir).filter((name) => name.endsWith('.ndjson'));
      expect(journalFiles).toHaveLength(2); // units run + assemble run
      // Raw-file schema check: openRunLog.read drops an invalid unterminated
      // tail as a torn write, so parse every line directly and require a
      // clean trailing newline.
      for (const name of journalFiles) {
        const raw = readFileSync(join(scene.journalDir, name), 'utf8');
        expect(raw.endsWith('\n')).toBe(true);
        for (const line of raw.split('\n').filter((l) => l !== '')) {
          const parsed = JournalEventSchema.safeParse(JSON.parse(line));
          expect(parsed.success, `journal line must parse: ${line}`).toBe(true);
        }
      }

      // The failures-only DEFAULT output: a clean run names no package.
      expect(outcome.output).not.toMatch(/alpha|beta/);
      expect(outcome.output).toContain('0 failing unit(s) of 2');

      // The push leg (jSKJL): the committed unit's branch reached the origin
      // BEFORE the fleet assembled; the no-commit unit pushed nothing (a PR
      // head without a commit would be a fabricated deliverable).
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-happy/fix/alpha');
      expect(originHeads).not.toContain('cq/e2e-happy/fix/beta');
      // The tracker branch is pushed before assembly, and every recorded PR
      // head exists on the real bare origin.
      expect(originHeads).toContain('cq/e2e-happy/tracker');
      expect(scene.gh.created.map((pr) => pr.head)).toEqual([
        'cq/e2e-happy/tracker',
        'cq/e2e-happy/fix/alpha',
      ]);
      for (const pr of scene.gh.created) {
        expect(originHeads, `PR head '${pr.head}' must exist on the remote`).toContain(pr.head);
      }
      const assembleEvents = await runEventsAt(scene.journalDir, SWEEP_PLAN_ID, 1);
      const trackerFinished = assembleEvents.findIndex(
        (event) => event.type === 'job-finished' && event.jobId === 'sweep-tracker-branch',
      );
      const assembleStarted = assembleEvents.findIndex(
        (event) => event.type === 'job-started' && event.jobId === 'sweep-assemble',
      );
      expect(trackerFinished).toBeGreaterThan(-1);
      expect(assembleStarted).toBeGreaterThan(trackerFinished);
    },
  );
});

// ---------------------------------------------------------------------------
// 1b. Tracker branch create/push + re-invoke reuse (review-debt #173)
// ---------------------------------------------------------------------------

describe('sweep e2e: tracker branch create/push + re-invoke reuse (#173)', () => {
  test(
    'a pre-existing remote tracker branch is reused: the fleet still assembles and the remote head is never rewound',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-tracker-reuse');
      const trackerBranch = 'cq/e2e-tracker-reuse/tracker';
      const baseSha = (await gitOut(['rev-parse', 'main'], scene.repo)).trim();
      const tree = (await gitOut(['rev-parse', `${baseSha}^{tree}`], scene.repo)).trim();
      const prior = (
        await gitOut(
          ['commit-tree', tree, '-p', baseSha, '-m', 'pre-existing tracker branch'],
          scene.repo,
        )
      ).trim();
      await gitOut(['update-ref', `refs/heads/${trackerBranch}`, prior], scene.repo);
      await gitOut(
        ['push', 'origin', `refs/heads/${trackerBranch}:refs/heads/${trackerBranch}`],
        scene.repo,
      );
      const before = (
        await gitOut(['ls-remote', '--heads', 'origin', `refs/heads/${trackerBranch}`], scene.repo)
      ).trim();
      expect(before).toContain(prior);

      const outcome = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.tracker).toMatchObject({ number: 1, created: true });
      const trackerRow = outcome.assembleRun?.jobs.find(
        (candidate) => candidate.jobId === 'sweep-tracker-branch',
      );
      expect(trackerRow?.result.status).toBe('ok');
      if (trackerRow?.result.status === 'ok') {
        expect(trackerRow.result.value).toMatchObject({
          reusedRemote: true,
          created: false,
          pushed: false,
          headSha: prior,
        });
      }
      const after = (
        await gitOut(['ls-remote', '--heads', 'origin', `refs/heads/${trackerBranch}`], scene.repo)
      ).trim();
      expect(after).toBe(before);
      expect(after).toContain(prior);
    },
  );
});
