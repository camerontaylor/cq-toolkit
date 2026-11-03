// Comment classification: auto-generated sticky suppression and the
// signature-led self-reply marker (drills 6-8, cycle 2).
import { describe, expect, test } from 'vitest';
import {
  completeWorker,
  defaultWorld,
  fixLine,
  iso,
  restComment,
  ROOT_AGE,
  runLoop,
} from './review-loop.helpers.js';

// ---------------------------------------------------------------------------
// Auto-generated sticky comment skip (drill 6) — the loop DEFAULT gains the
// pattern (defaultLoopClassifyConfig); config-as-data, no code branch. The
// author is deliberately a plain reviewer identity: only the BODY pattern
// may classify this skip.
// ---------------------------------------------------------------------------

describe('auto-generated sticky comment skip + self-reply marker (drills 6-8, cycle 2)', () => {
  test('generation-signature stickies skip; a marker-led loop reply plans no job; bare-text and human comments PLAN JOBS; posted replies LEAD with the signature', async () => {
    // The SUPPRESSION patterns anchor on generation signatures only (drill
    // 6: GitHub's auto-generated marker; drills 7-8: the Codex review bot's
    // sticky PR summary — drill 7's comment 5705054746 was that codex
    // summary all along; the diagnostic misread a length-truncated body).
    // The BARE-TEXT suppression ("This comment shows the latest checks")
    // was REMOVED in cycle 2 — author-blind and spoofable — so the same
    // phrase on a HUMAN comment (302) must plan a job, never suppress.
    // Authors are deliberately plain reviewer identities — NEVER the
    // responder — so ONLY body content decides.
    const world = defaultWorld();
    world.threads = []; // ONLY the five issue comments ride the fetched state
    world.issueComments = [
      restComment(
        301,
        'reviewer',
        '<!-- This is an auto-generated comment -->\nThis comment shows the latest checks and updates itself.',
        iso(ROOT_AGE),
        null,
      ),
      // THE ANTI-SUPPRESSION PIN (cycle 2 major): bare housekeeping-sounding
      // text, no generation signature, human-authored — actionable.
      restComment(
        302,
        'reviewer',
        'This comment shows the latest checks and was posted automatically.',
        iso(ROOT_AGE),
        null,
      ),
      restComment(
        303,
        'reviewer',
        '<!-- codex-pull-request-review-summary -->\n## Codex Review Summary\nThis comment shows the latest Codex review activity.',
        iso(ROOT_AGE),
        null,
      ),
      restComment(304, 'reviewer', 'Please also fix the typo in src/a.ts.', iso(ROOT_AGE), null),
      // A PRIOR LOOP REPLY re-fetched as feedback (cycle-1 major): the
      // signature LEADS the composed body, so the START-anchored pattern
      // must match it — this comment plans no job.
      restComment(
        305,
        'reviewer',
        '<!-- cq-review-loop:octo/widget#7 -->\n\nNoted; nothing to change in code.',
        iso(ROOT_AGE),
        null,
      ),
    ];
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(
          fixLine(false, 'The checks comment: noted, the `static` job already covers it.', []),
        ),
        completeWorker(
          fixLine(false, 'Noted; nothing to change, src/a.ts line 3 already guards it.', []),
        ),
      ],
      ghLog,
    });
    // EXACTLY the human comments plan jobs — 302 (the bare-text anti-
    // suppression pin) and 304 — never the marker-led shapes (301, 303,
    // 305).
    expect(outcome.plan.jobs).toHaveLength(2);
    expect(outcome.plan.jobs.map((job) => (job.input as { item: { id: string } }).item.id)).toEqual(
      ['302', '304'],
    );
    expect(outcome.skipped).toEqual([]);
    expect(outcome.status).toBe('ok');
    expect(outcome.actionsPosted).toBe(2);
    // SELF-REPLY MARKER (drill 8, cycle-1 major): EVERY posted reply body
    // OPENS with the loop's signature line — the skip pattern is
    // START-anchored, so a trailing marker would never match the reply it
    // was posted on.
    const posts = ghLog.filter((args) => args.includes('-X'));
    expect(posts, `post argv ${JSON.stringify(posts)}`).toHaveLength(2);
    expect(
      posts.every((args) =>
        args.some((arg) => arg.startsWith('body=<!-- cq-review-loop:octo/widget#7 -->')),
      ),
      `post argv ${JSON.stringify(posts)}`,
    ).toBe(true);
  });
});
