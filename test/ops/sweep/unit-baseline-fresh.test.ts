// M2c — the hostile negative control the spec-conformance audit asked for
// (B05-fix DI7.1): a REUSED tree with a stale run-state baseline snapshot
// must never serve the stale count. The baseline probe always re-runs (I7:
// baselines are never cached), so the reported baseline is the LIVE probe's
// failure population and the snapshot is rewritten with it. In-process fakes
// only: no providers, no network, no credentials.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { sweepRunStateDir } from '../../../src/ops/sweep/unit.js';
import { makeWorld, runUnit } from './unit-scenarios.helpers.js';

test('M2c stale snapshot is ignored', async () => {
  // Both probes see the SAME single live failure, so the regression gate
  // tolerates it and the legacy fix flow completes on both runs.
  const world = await makeWorld([
    { failing: true, message: 'live failure' },
    { failing: true, message: 'live failure' },
  ]);
  try {
    // First run: the CREATE path. The live probe finds exactly one failure
    // and writes the run-state snapshot for it.
    const first = await runUnit(world);
    expect(first.status).toBe('ok');
    if (first.status === 'ok') expect(first.value.baseline.failureSet.failures).toHaveLength(1);

    // Seed the hostile snapshot: a failure population the live probe will
    // NOT find (three fabricated failures) at the exact run-state path the
    // unit writes — the only place stale baseline state could hide.
    const snapshot = join(
      sweepRunStateDir(world.root, 'worktrees', 'cq/unit'),
      'baseline',
      'fix',
      'alpha.json',
    );
    await mkdir(dirname(snapshot), { recursive: true });
    await writeFile(
      snapshot,
      `${JSON.stringify({
        tool: 'vitest',
        failures: [1, 2, 3].map((n) => ({
          file: 'src/a.js',
          line: n,
          column: 1,
          ruleId: null,
          message: `stale failure ${n}`,
          severity: 'error',
        })),
        exitCode: 1,
      })}\n`,
      'utf8',
    );

    // Second run on the REUSED tree: the reported baseline is the live
    // probe's count — never the stale snapshot's.
    const reused = await runUnit(world);
    expect(reused.status).toBe('ok');
    if (reused.status === 'ok') {
      expect(reused.value.worktree.reused).toBe(true);
      expect(reused.value.baseline.failureSet.failures).toHaveLength(1);
      expect(reused.value.baseline.failureSet.failures[0]?.message).toBe('live failure');
    }
    // The snapshot was rewritten with the live evidence (it is written,
    // never read — that is the audit's point).
    const persisted = JSON.parse(await readFile(snapshot, 'utf8')) as {
      failures: Array<{ message: string }>;
    };
    expect(persisted.failures).toHaveLength(1);
    expect(persisted.failures[0]?.message).toBe('live failure');
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});
