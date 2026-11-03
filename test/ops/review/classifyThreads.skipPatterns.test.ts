// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
import { baseState, itemsOf, restComment, review, thread } from './classifyThreads.helpers.js';

// ---------------------------------------------------------------------------
// skipPatterns — bot-anchored patterns fire; human phrasing never matches
// ---------------------------------------------------------------------------

describe('default skipPatterns', () => {
  test.each([
    ['CodeRabbit skipped', 'CodeRabbit skipped this PR because the diff was empty'],
    ['bot-anchored failure', 'coderabbitai failed to post the review: error 500'],
    [
      'configuration problem skip',
      'CodeRabbit: configuration problem detected — skipping this run',
    ],
    ['bot self-skip (skipping)', 'CodeRabbit is skipping this PR — no reviewable diff'],
    ['bot self-skip (not reviewing)', 'chatgpt-codex-connector: not reviewing this run'],
  ])('bot-anchored pattern (%s) fires → bot_skip_notice', (_label, body) => {
    expect(itemsOf(baseState({ restIssueComments: [restComment({ id: 621, body })] }))).toEqual([
      { kind: 'comment', id: '621', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ]);
  });

  test('a HUMAN sentence containing "review failed to consider" must NOT skip → actionable', () => {
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TH1',
              body: 'The review failed to consider the null case — please handle it.',
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TH1',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ]);
  });

  test('a HYPHENATED tool-name mention ("Codex-style tooling failed us here") must NOT skip → actionable', () => {
    // Round-3 pattern fix: the identity requires a trailing \b AND must
    // not run into a hyphen — \b alone is satisfied before '-', which
    // would read this human sentence as the tool's own failure notice.
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TH3',
              body: 'Codex-style tooling failed us here — please fix the harness manually.',
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TH3',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ]);
  });

  test('a HUMAN "I\'m not reviewing the migrations this pass, but …" must NOT skip → actionable', () => {
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TH2',
              body: "I'm not reviewing the migrations this pass, but the API layer needs a null guard.",
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TH2',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ]);
  });

  test('a HUMAN configuration-error sentence ("… makes skipping validation unsafe") must NOT skip → actionable (Codex, PR71)', () => {
    // The configuration/setup-error skip pattern anchors on a bot identity
    // at LINE START like its siblings: this sentence's mid-line
    // "configuration error … skipping" used to match the unanchored form
    // and was silently skipped — it is a human demanding a fix.
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TH4',
              body: 'This configuration error makes skipping validation unsafe; please fix it.',
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TH4',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ]);
  });

  test('a HYPHENATED tool-name mention in a SELF-SKIP sentence ("Codex-style tooling is not reviewing …") must NOT skip → actionable', () => {
    // The self-skip pattern carries the same `(?!-)` hyphen guard as its
    // siblings: without it, "Codex-style tooling is not reviewing generated
    // files correctly" reads the hyphenated MENTION as the tool speaking.
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TH7',
              body: 'Codex-style tooling is not reviewing generated files correctly — it misses half the diff.',
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TH7',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ]);
  });

  test('a HUMAN sentence MENTIONING CodeRabbit alongside "skipped" mid-sentence must NOT skip → actionable', () => {
    // The skip pattern was rebuilt in the family form: the tool identity
    // must LEAD the line (it used to be the one unanchored, unbounded
    // pattern). "I asked CodeRabbit to re-run since it skipped the
    // generated file" mentions the tool — a human's demand, not a verdict.
    expect(
      itemsOf(
        baseState({
          restIssueComments: [
            restComment({
              id: 627,
              body: 'I asked CodeRabbit to re-run since it skipped the generated file — please fix inline.',
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'comment',
        id: '627',
        verdict: 'actionable',
        path: null,
        reason: 'top_level_summary',
      },
    ]);
  });

  test('a bot configuration-error notice ("CodeRabbit: configuration error, skipping review") → skip (bot_skip_notice)', () => {
    // The same pattern still fires on the tool's own notice — the identity
    // LEADS the line, so the skip is the tool's verdict, not a human's.
    expect(
      itemsOf(
        baseState({
          restIssueComments: [
            restComment({ id: 624, body: 'CodeRabbit: configuration error, skipping review' }),
          ],
        }),
      ),
    ).toEqual([
      { kind: 'comment', id: '624', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ]);
  });

  test('an UNANCHORED bare self-skip sentence (no bot identity) no longer skips → actionable', () => {
    // Pinned round 2: "skipping review"/"not reviewing" phrasing only
    // skips when a bot/tool identity LEADS the line.
    expect(
      itemsOf(
        baseState({
          restIssueComments: [restComment({ id: 623, body: 'Skipping review for this draft PR' })],
        }),
      ),
    ).toEqual([
      {
        kind: 'comment',
        id: '623',
        verdict: 'actionable',
        path: null,
        reason: 'top_level_summary',
      },
    ]);
  });

  test('a bot notice on LINE 2 of a multi-line comment skips (the `m` flag: ^ matches every line start)', () => {
    // Bots append their verdict below a preamble; the line-anchored default
    // patterns carry the `m` flag, so "line start" means EVERY line start,
    // not just the body's first character.
    expect(
      itemsOf(
        baseState({
          restIssueComments: [
            restComment({
              id: 625,
              body: 'Review queued; results will appear below.\nCodeRabbit is skipping this PR — no reviewable diff',
            }),
          ],
        }),
      ),
    ).toEqual([
      { kind: 'comment', id: '625', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ]);
    expect(
      itemsOf(
        baseState({
          restIssueComments: [
            restComment({
              id: 626,
              body: 'Preamble line.\ncoderabbitai failed to post the review: error 500',
            }),
          ],
        }),
      ),
    ).toEqual([
      { kind: 'comment', id: '626', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ]);
  });

  test('a SPLIT-LINE notice (identity and skip verb on different lines) skips — the bounded window spans the break', () => {
    // Round 3: the window between the identity and the verb is
    // [\s\S]{0,80} (kept in sync with the merge family's copy of the
    // patterns — src/ops/merge/classify.config.ts): a notice rendered as
    // "CodeRabbit" alone on its line, verb on the next, is still the
    // tool's verdict, never actionable feedback.
    expect(
      itemsOf(
        baseState({
          restIssueComments: [restComment({ id: 627, body: 'CodeRabbit\nskipped this run' })],
        }),
      ),
    ).toEqual([
      { kind: 'comment', id: '627', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ]);
  });

  test('a HUMAN mid-body sentence (line 2, no bot identity) stays actionable even with the `m` flag', () => {
    // The `m` flag widens WHERE the anchors can match, never WHAT counts as
    // a bot: line 2 opening with generic human "failed to consider…"
    // phrasing still finds no bot identity at the line start.
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TH5',
              body: 'Two nits below.\nThe migration helper failed to consider the null case — please handle it.',
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TH5',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ]);
  });

  test('a normal review body matches no default pattern → stays actionable', () => {
    const items = itemsOf(
      baseState({
        threads: [
          thread({
            id: 'TS1',
            body: 'Please extract this loop into a helper and add a regression test.',
          }),
        ],
        reviews: [
          review({ id: 'TS2', body: 'The null-handling branch is untested; please add a case.' }),
        ],
        restIssueComments: [
          restComment({ id: 622, body: 'Overall this looks close — one blocking nit below.' }),
        ],
      }),
    );
    expect(items.map((item) => item.verdict)).toEqual(['actionable', 'actionable', 'actionable']);
    expect(items.map((item) => item.reason)).toEqual([
      'thread_needs_response',
      'review_summary_needs_response',
      'top_level_summary',
    ]);
  });
});
