// Split provenance: test/ops/review/address-pr.test.ts was split by subject;
// this file holds its exit-publication, push-fault and mixed-worktree
// withhold-row tests. The shared phase-one orchestration world lives in
// address-pr.helpers.ts.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { world } from './address-pr.helpers.js';

describe('review.address PR phase-one orchestration', () => {
  // Verdict P2 #1 (PR #470): no test drove a publishOnExit throw through
  // the real engine's finish(). The catch rewrites the outcome to
  // "verified publication failed" and clears the report.stop marker; this
  // pins the rewrite on production (a scripted push fault, not a stub
  // engine), so a composition can never draft over a failed verified push.
  // One committed fix makes publication non-idle; the scripted git seam
  // fails the push that carries the verified commit — the same push
  // finish()'s publishOnExit fork reaches, so the outcome rewrite under
  // test is the engine's.
  test('a scripted push fault through the real engine rewrites the outcome to verified publication failed', async () => {
    const w = await world();
    try {
      let exitPushSeen = false;
      // The happy path publishes through the loop's stage-5 push (the
      // composition's own publication is idle after it); the scripted fault
      // rides THE push that carries the verified commit, and finish()
      // reaches the same fault through publishOnExit when the loop already
      // rewrote its own outcome. Either way the ONLY rewrite left is the
      // engine's.
      w.failEveryPush(() => {
        exitPushSeen = true;
        return 'exit push: disk quota exceeded (scripted)';
      });
      const result = await w.run();
      expect(exitPushSeen, 'the fault must hit a push carrying verified work').toBe(true);
      expect(result.status).toBe('needs-human');
      const reason = result.status === 'needs-human' ? result.reason : '';
      expect(reason).toContain('verified publication failed');
      expect(reason).toContain('disk quota exceeded');
      const report = result.report!;
      expect(report.stop).toBeUndefined();
      expect(w.actions).not.toContain('resolve:T1');
      // The persisted artifact agrees with the rewritten envelope.
      expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
    } finally {
      await w.cleanup();
    }
  });

  // #469: when the mixed-worktree guard withheld inside the loop but the
  // run allows a push, the composition's exit publication settles the row's
  // truth: the verified commit IS published (the exact verified range),
  // only this item's reply and resolve stay withheld. The per-item reason
  // must not keep telling the human "the local commit is not published"
  // after the engine itself pushed it (S6 attempt D, commit 8f78ca91).
  test('the withhold row settles to exit-published when the engine pushed the verified range', async () => {
    const w = await world(false, { failer: true });
    try {
      const result = await w.run();
      expect(result.status).toBe('needs-human');
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(w.actions).toContain('push');
      const row = report.reasons.find((reason) =>
        reason.includes('publish-withheld-mixed-worktree'),
      );
      expect(row).toBeDefined();
      expect(row).toContain('exit-published');
      expect(row).not.toContain('pushed nothing');
      // The settled truth is inside the persisted artifact too.
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        reasons: string[];
      };
      expect(persisted.reasons).toContain(row!);
    } finally {
      await w.cleanup();
    }
  });

  test('a withheld row without --push settles to publication-off, the one truly-unpublished state', async () => {
    const w = await world(false, { failer: true });
    try {
      const result = await w.run(false);
      expect(result.status).toBe('needs-human');
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(w.actions).not.toContain('push');
      const row = report.reasons.find((reason) =>
        reason.includes('publish-withheld-mixed-worktree'),
      );
      expect(row).toBeDefined();
      expect(row).toContain('publication is off for this run');
      expect(row).toContain('stays unpublished');
    } finally {
      await w.cleanup();
    }
  });

  // Publication-range truth (PR review thread PRRT_kwDOUY73E86w9hwK): the
  // exit-publication witness used to be run-wide, so after round 1's push
  // succeeded, round 2's pre-mutation push failure could not be recorded
  // ('published' stood) and finish() stamped BOTH rounds' withhold rows
  // "exit-published" — claiming round 2's verified commit was out while it
  // never left the worktree. The real multi-round shape: round 1 pushes
  // (commit 1 published; its row settles at the push), round 2 verifies
  // commit 2 and every later push fails before any remote mutation (the
  // remote head stays at commit 1). Truth: commit 1 published, commit 2
  // local, needs-human "verified publication failed".
  test('a later range whose push fails before mutation keeps the earlier range published and its own row local', async () => {
    const stderr = 'remote storage went read-only mid-run (scripted)';
    const commitSha = (n: number) => `c${String(n).padStart(39, '0')}`;
    const w = await world(false, {
      failer: true,
      rounds: 2,
      incrementingCommits: true,
      failPushFrom: { ordinal: 2, stderr },
    });
    try {
      const result = await w.run();
      expect(result.status).toBe('needs-human');
      const reason = result.status === 'needs-human' ? result.reason : '';
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(reason).toContain('verified publication failed');
      expect(reason).toContain(stderr);
      // Exactly one push left the process — round 1's. Round 2's failed
      // before the remote moved, so the remote head is commit 1, not 2.
      expect(w.actions.filter((action) => action === 'push')).toHaveLength(1);
      expect(w.remoteHead()).toBe(commitSha(1));
      const rows = report.reasons.filter((r) => r.includes('publish-withheld-mixed-worktree'));
      expect(rows).toHaveLength(2);
      // Round 1's row settled at its own successful push and is never
      // rewritten by the later failure.
      expect(rows[0]).toContain('exit-published');
      expect(rows[0]).not.toContain('stays local');
      // Round 2's row carries its own range's failure: the commit stays
      // local, and the earlier success never suppresses it.
      expect(rows[1]).toContain('exit publication failed');
      expect(rows[1]).toContain(stderr);
      expect(rows[1]).toContain('stays local');
      expect(rows[1]).not.toContain('exit-published');
      // The per-range truth is inside the persisted artifact too.
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        reasons: string[];
      };
      expect(persisted.reasons).toContain(rows[0]);
      expect(persisted.reasons).toContain(rows[1]);
    } finally {
      await w.cleanup();
    }
  });
});

test('exit publication uses a lease against the head repository without thread fix jobs', async () => {
  const w = await world(false, {
    fork: true,
    settledLoopReplies: true,
    reviewOutcome: 'open-finding',
  });
  try {
    const result = await w.run();
    expect(w.prompts.length).toBeGreaterThan(0);
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]?.[1]).toBe(`--force-with-lease=refs/heads/feature:${'a'.repeat(40)}`);
    expect(w.pushes[0]?.[2]).toBe('https://github.com/fork-owner/widget.git');
    expect(JSON.stringify(result)).not.toContain('verified publication failed');
  } finally {
    await w.cleanup();
  }
});
test('confirmed loop publication is retained after reply-stage needs-human', async () => {
  const w = await world(false, { recoverResolution: true });
  try {
    const result = await w.run();
    expect(result.status).toBe('needs-human');
    expect(w.pushes).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('verified publication failed');
  } finally {
    await w.cleanup();
  }
});
