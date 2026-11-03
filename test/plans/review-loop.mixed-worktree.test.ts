// Mixed-worktree publication guard (round-3 item 11): the withhold row's
// text pins and caller-neutral publication responsibility (#469, #567).
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

  test.each([true, undefined])(
    'direct caller publication=%s uses caller-neutral wording',
    async (publish) => {
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
        ...(publish === undefined ? {} : { publish }),
      });
      expect(outcome.status).toBe('needs-human');
      // The mixed-worktree guard held: exactly one withhold row, for T2's item.
      const rows = outcome.reasons.filter((reason) =>
        reason.includes('publish-withheld-mixed-worktree'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('T2');
      expect(rows[0]).toContain("; any publication is the caller's responsibility");
      expect(rows[0]).not.toContain('engine exit');
      expect(rows[0]).not.toContain('publication requires --push');
      expect(outcome.fixReport).toBeDefined();
    },
  );
});
