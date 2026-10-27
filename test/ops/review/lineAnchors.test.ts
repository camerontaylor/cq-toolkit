import { describe, expect, it } from 'vitest';
import { headLineAnchors } from '../../../src/ops/review/internal/lineAnchors.js';
import { partitionReview } from '../../../src/ops/review/internal/reviewPartitions.js';
import { createReviewPlan } from '../../../src/ops/review/internal/reviewPlan.js';

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,6 +20,5 @@',
  ' keep one',
  '-gone first',
  '-gone second',
  '+added after the deleted run',
  ' keep two',
  '+tail line',
  '',
].join('\n');

describe('headLineAnchors', () => {
  it('numbers added lines by head line and anchors removed runs to the next surviving line', () => {
    expect(headLineAnchors(diff)).toBe(
      [
        'removed before L21 (2 lines): gone first',
        'L21 + added after the deleted run',
        'L23 + tail line',
        '',
      ].join('\n'),
    );
  });

  it('ignores lines outside any hunk and resumes from a supplied position', () => {
    expect(headLineAnchors('--- a/x\n+++ b/x\n')).toBe('');
    expect(headLineAnchors('+resumed\n', { oldLine: 5, newLine: 40 })).toBe('L40 + resumed\n');
  });

  it('counts stripped blank context lines and resets at a new file diff', () => {
    const text = '@@ -1,3 +1,3 @@\n\n+added\ndiff --git a/y b/y\n+ignored outside a hunk\n';
    expect(headLineAnchors(text)).toBe('L2 + added\n');
  });

  it('anchors a trailing deletion to the preceding surviving line', () => {
    const text = '@@ -1,4 +1,3 @@\n one\n two\n three\n-four\n';
    expect(headLineAnchors(text)).toBe('removed after L3 (1 line): four\n');
  });

  it('leaves deletion of the whole file explicitly unanchored', () => {
    expect(headLineAnchors('@@ -1,2 +0,0 @@\n-one\n-two\n')).toBe(
      'removed without a surviving head-line anchor (2 lines): one\n',
    );
  });

  it('uses the preceding line for an EOF deletion with no head context', () => {
    expect(headLineAnchors('@@ -4,2 +3,0 @@\n-four\n-five\n')).toBe(
      'removed after L3 (2 lines): four\n',
    );
  });

  it('stops at hunk bounds before file headers, metadata, or extra diff lines', () => {
    const text = [
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/next.ts',
      '+++ b/next.ts',
      '+outside',
      '@@ -5 +7 @@',
      '-old next',
      '+new next',
      '+also outside',
      '',
    ].join('\n');
    expect(headLineAnchors(text)).toBe(
      'removed before L1 (1 line): old\nL1 + new\n' +
        'removed before L7 (1 line): old next\nL7 + new next\n',
    );
  });

  it('does not carry surviving-line knowledge into another file or hunk', () => {
    const text = '@@ -1 +1 @@\n one\ndiff --git a/b b/b\n@@ -1 +0,0 @@\n-only\n';
    expect(headLineAnchors(text)).toBe(
      'removed without a surviving head-line anchor (1 line): only\n',
    );
  });

  it('respects remaining hunk lengths in a continuation slice', () => {
    expect(
      headLineAnchors('-last\n+++ b/next\n+outside\n', {
        oldLine: 4,
        newLine: 4,
        oldRemaining: 1,
        newRemaining: 0,
      }),
    ).toBe('removed after L3 (1 line): last\n');
  });

  it('preserves the preceding line for a zero-length head continuation', () => {
    expect(
      headLineAnchors('-last\n+outside\n', {
        oldLine: 5,
        newLine: 3,
        previousHeadLine: 3,
        oldRemaining: 1,
        newRemaining: 0,
      }),
    ).toBe('removed after L3 (1 line): last\n');
  });

  it('keeps no-newline markers from interrupting a replacement anchor', () => {
    expect(headLineAnchors('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n')).toBe(
      'removed before L1 (1 line): old\nL1 + new\n',
    );
  });

  it('truncates long excerpts and caps the section', () => {
    const long = `@@ -1 +1,1501 @@\n${'+x'.repeat(100)}\n${'+y\n'.repeat(1_500)}`;
    const out = headLineAnchors(long);
    expect(out.length).toBeLessThan(6_100);
    expect(out).toContain('…');
    expect(out).toContain('(further anchors omitted)');
  });
});

describe('anchors and the stable prefix in the review prompts', () => {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);

  it('puts head line anchors before the untouched diff bytes in a session prompt', () => {
    const component = { component: 'tracked:src/a.ts', path: 'src/a.ts', text: diff };
    const session = createReviewPlan({ head, base, scope: 'full', components: [component] })
      .sessions[0]!;
    expect(session.prompt).toContain('### Head line anchors for src/a.ts');
    expect(session.prompt).toContain('L21 + added after the deleted run');
    expect(session.prompt).toContain('nearest surviving head line');
    const placement = session.placements[0]!;
    expect(session.prompt.slice(placement.offset, placement.offset + diff.length)).toBe(diff);
    expect(session.prompt.indexOf('Head line anchors for')).toBeLessThan(placement.offset);
  });

  it('keeps zero-head deletion anchors correct across partition continuations', () => {
    const text = `@@ -4,1500 +3,0 @@\n${'-deleted content from an EOF-only hunk\n'.repeat(1_500)}+outside exhausted hunk\n`;
    const { partitions } = partitionReview({
      head,
      base,
      scope: 'full',
      components: [{ component: 'tracked:src/a.ts', path: 'src/a.ts', text }],
      requireReceipt: false,
    });
    expect(partitions.length).toBeGreaterThan(1);
    for (const part of partitions) {
      const anchors = part.prompt.split('head line anchors:\n')[1]?.split('partition data')[0];
      if (anchors !== undefined) {
        expect(anchors).toContain('removed after L3');
        expect(anchors).not.toContain('before L');
        expect(anchors).not.toContain('outside exhausted hunk');
      }
    }
  });

  it('shares a byte-identical prefix across partitions and keeps data last', () => {
    const text = `@@ -1 +1,9000 @@\n${'+ordinary line of added code\n'.repeat(9_000)}`;
    const { partitions } = partitionReview({
      head,
      base,
      scope: 'full',
      components: [
        { component: 'tracked:src/a.ts', path: 'src/a.ts', text },
        { component: 'tracked:src/b.ts', path: 'src/b.ts', text: diff },
      ],
      requireReceipt: false,
    });
    expect(partitions.length).toBeGreaterThan(2);
    const marker = '---\n';
    const prefixes = partitions.map((part) => part.prompt.slice(0, part.prompt.indexOf(marker)));
    expect(new Set(prefixes).size).toBe(1);
    expect(prefixes[0]).toContain('changed files in this review:');
    expect(prefixes[0]).toContain('src/b.ts');
    for (const part of partitions) {
      const afterPrefix = part.prompt.slice(prefixes[0]!.length);
      expect(afterPrefix.indexOf('"component"')).toBeLessThan(
        afterPrefix.indexOf('partition data'),
      );
      expect(part.prompt).toMatch(/partition data \(UTF-16 range \d+:\d+\):\n[^]*$/);
    }
    expect(partitions[0]!.prompt).toContain('head line anchors:\nL1 + ordinary');
    expect(partitions.at(-1)!.prompt).toContain('L21 + added after the deleted run');
  });
});
