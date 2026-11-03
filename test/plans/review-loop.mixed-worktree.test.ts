// Mixed-worktree publication guard (round-3 item 11): the withhold row's
// text pins and the publish-on engine-exit clause (#469).
import { describe, expect, test } from 'vitest';
import {
  actionableThread,
  BEEF_SHA,
  completeWorker,
  defaultWorld,
  fixLine,
  NEW_SHA,
  runLoop,
  SHA,
} from './review-loop.helpers.js';

describe('mixed-worktree publication (round-3 item 11)', () => {
  test('a failed sibling withholds the push — no push argv, no resolves, reasons present', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, BEEF_SHA];
    world.commitMessages = { [BEEF_SHA]: 'Fix review item T2 in src/b.ts' };
    const gitLog: string[][] = [];
    // A's worker answer is malformed (its worktree state is unknown); B is ok.
    const { outcome, gitLog: log } = await runLoop(world, {
      driverResults: [
        completeWorker('not json at all'),
        completeWorker(fixLine(true, 'Fixed B.', [BEEF_SHA])),
      ],
      gitLog,
    });
    void log;
    expect(outcome.status).toBe('needs-human');
    expect(
      outcome.reasons.some((reason) => reason.includes('publish-withheld-mixed-worktree')),
    ).toBe(true);
    expect(gitLog.some((args) => args[2] === 'push')).toBe(false);
    // Publish-gate unification (jMY2X): the blocked gate withholds B's
    // reply too — NO resolve, and nothing records.
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });

  // #469: the row's own reason text must state exactly what this loop did —
  // pushed NOTHING (the mixed-worktree guard held) and withheld the item's
  // reply and resolve — and must NEVER claim "the local commit is not
  // published": a `--push` run's composition publishes the EXACT verified
  // range at engine exit (review.address publishOnExit, S6 attempt D pushed
  // 8f78ca91 after this text already said otherwise), and publication-off is
  // a different state the loop must not merge into this reason.
  test('the withhold row text states the loop pushed nothing and withheld the reply/resolve, without claiming the commit is unpublished', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, BEEF_SHA];
    world.commitMessages = { [BEEF_SHA]: 'Fix review item T2 in src/b.ts' };
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker('not json at all'),
        completeWorker(fixLine(true, 'Fixed B.', [BEEF_SHA])),
      ],
    });
    expect(outcome.status).toBe('needs-human');
    const row = outcome.reasons.find((reason) =>
      reason.includes('publish-withheld-mixed-worktree'),
    );
    expect(row).toBeDefined();
    // What THIS loop did: pushed nothing, withheld this item's reply/resolve.
    expect(row!).toContain('pushed nothing');
    expect(row!).toContain('withheld');
    // The refuted claim: a sibling failure does NOT leave the verified
    // commit necessarily unpublished — the engine's exit publication is
    // exactly what pushed 8f78ca91 in S6 attempt D (#469).
    expect(row!).not.toContain('not published');
  });

  test('with publication explicitly on, the withhold row keeps the engine-exit publication clause open, never the publication-off denial', async () => {
    // S6 attempt D's exact shape: T1's row ended budget-exhausted, T2's fix
    // committed and verified; the loop withheld, then the engine's exit
    // publication pushed the verified range (8f78ca91). The "exit-published"
    // resolution itself is the composition's to prove (address-pr push-fault
    // suite); this pin owns the loop-side TEXT half of that amendment: the
    // explicit opt-in (`publish: true` — the composition's
    // `input.push === true` shape) must keep the withhold row's engine-exit
    // clause OPEN. The publish-off branch of this exact row appends "this
    // run publishes nothing at engine exit (publication requires --push)"
    // instead — that denial is what a publish-on run must never carry.
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, BEEF_SHA];
    world.commitMessages = { [BEEF_SHA]: 'Fix review item T2 in src/b.ts' };
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(true, 'Fixed A.', [NEW_SHA]), { stopReason: 'budget' }),
        completeWorker(fixLine(true, 'Fixed B.', [BEEF_SHA])),
      ],
      publish: true,
    });
    expect(outcome.status).toBe('needs-human');
    // The mixed-worktree guard held: exactly one withhold row, for T2's item.
    const rows = outcome.reasons.filter((reason) =>
      reason.includes('publish-withheld-mixed-worktree'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('T2');
    // THE PUBLISH-ON OBSERVABLE: the row ends with the OPEN engine-exit
    // clause — the one difference `opts.publish === false` vs otherwise
    // actually makes on this text — never the publish-off denial.
    expect(rows[0]).toContain('; publication may still happen at engine exit');
    expect(rows[0]).not.toContain('publication requires --push');
    expect(outcome.fixReport).toBeDefined();
  });
});
