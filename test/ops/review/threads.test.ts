// E1 slice 1 — tests for the shared review-thread vocabulary
// (src/ops/review/threads.ts).
//
// Pinned here:
//   1. countUnresolvedThreads — the external-threads rule the merge ops
//      family (WS-F) depends on: resolved threads never count, threads
//      authored by the excluded responder never count, and a NULL author
//      counts fail-closed (an unknown author could be an external
//      reviewer). Empty input counts zero; an absent/null exclude excludes
//      nobody.
//   2. attachRestReplies — GraphQL reviewThreads.comments(first: 1) yields
//      only the root comment, so reply chains are reconstructed from the
//      flat REST collection: chains anchor at a root REST comment whose
//      numeric id equals a thread's rootDatabaseId (the real GitHub join —
//      GraphQL root comment databaseId ↔ REST id), append in createdAt
//      order (nulls last, ties keep REST order), mutate the passed threads
//      in place, and chains that cannot be anchored to a known thread are
//      dropped silently.
//
// Pure data tests: no gh, no I/O — instant by construction.
import { describe, expect, test } from 'vitest';
import { attachRestReplies, countUnresolvedThreads } from '../../../src/ops/review/threads.js';
import type { RestComment, ReviewThread } from '../../../src/ops/review/threads.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** An unresolved thread by an external reviewer, overridable field by field. */
const thread = (extra?: Partial<ReviewThread>): ReviewThread => ({
  id: 'PRRT_kwDOCr1',
  rootDatabaseId: 100,
  path: 'src/a.ts',
  line: 1,
  isResolved: false,
  isOutdated: false,
  authorLogin: 'alice',
  createdAt: '2026-01-01T00:00:00Z',
  body: 'root',
  replies: [],
  ...extra,
});

/** A REST chain root (a thread's first comment), overridable field by field. */
const rootComment = (extra?: Partial<RestComment>): RestComment => ({
  id: 100,
  nodeId: 'PRRC_100',
  authorLogin: 'alice',
  body: 'root',
  createdAt: '2026-01-01T00:00:00Z',
  inReplyToId: null,
  ...extra,
});

/** A REST reply, overridable field by field. */
const reply = (extra?: Partial<RestComment>): RestComment => ({
  id: 101,
  nodeId: 'R1',
  authorLogin: 'bob',
  body: 'a reply',
  createdAt: '2026-01-01T01:00:00Z',
  inReplyToId: 100,
  ...extra,
});

/** The replies a thread ended up with, as bare [id, createdAt] tuples. */
const repliesOf = (t: ReviewThread): Array<[string | null, string | null]> =>
  t.replies.map((r) => [r.authorLogin, r.createdAt]);

// ---------------------------------------------------------------------------
// countUnresolvedThreads
// ---------------------------------------------------------------------------

describe('countUnresolvedThreads', () => {
  test.each([
    {
      name: 'empty input counts zero',
      threads: [],
      exclude: 'pr-author' as string | null,
      expected: 0,
    },
    {
      name: 'resolved threads never count, unresolved ones do',
      threads: [thread(), thread({ id: 'T2', isResolved: true })],
      exclude: null,
      expected: 1,
    },
    {
      name: 'threads authored by the excluded responder never count',
      threads: [thread({ authorLogin: 'pr-author' }), thread({ id: 'T2' })],
      exclude: 'pr-author',
      expected: 1,
    },
    {
      name: 'a null author counts fail-closed even with an exclude set',
      threads: [thread({ authorLogin: null })],
      exclude: 'pr-author',
      expected: 1,
    },
    {
      name: 'no exclude counts every unresolved thread',
      threads: [thread(), thread({ id: 'T2', authorLogin: 'pr-author' })],
      exclude: undefined,
      expected: 2,
    },
    {
      name: 'a null exclude excludes nobody',
      threads: [thread(), thread({ id: 'T2', authorLogin: 'pr-author' })],
      exclude: null,
      expected: 2,
    },
  ])('$name', ({ threads, exclude, expected }) => {
    expect(countUnresolvedThreads(threads, { excludeAuthorLogin: exclude })).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// attachRestReplies
// ---------------------------------------------------------------------------

describe('attachRestReplies', () => {
  test('a linear chain appends in createdAt order and maps to ThreadComment shape', () => {
    const t = thread();
    attachRestReplies(
      [t],
      [
        rootComment(),
        reply({ id: 101, createdAt: '2026-01-01T01:00:00Z', inReplyToId: 100 }),
        reply({ id: 102, createdAt: '2026-01-01T02:00:00Z', authorLogin: 'carol', inReplyToId: 101 }),
      ],
    );
    expect(repliesOf(t)).toEqual([
      ['bob', '2026-01-01T01:00:00Z'],
      ['carol', '2026-01-01T02:00:00Z'],
    ]);
    // Only the ThreadComment surface survives the mapping.
    expect(t.replies[0]).toEqual({
      authorLogin: 'bob',
      body: 'a reply',
      createdAt: '2026-01-01T01:00:00Z',
    });
  });

  test('a branched chain (two replies on one root) sorts by createdAt regardless of REST order', () => {
    const t = thread();
    attachRestReplies(
      [t],
      [
        rootComment(),
        reply({ id: 102, createdAt: '2026-01-01T02:00:00Z', authorLogin: 'carol' }),
        reply({ id: 101, createdAt: '2026-01-01T01:00:00Z' }),
      ],
    );
    expect(repliesOf(t)).toEqual([
      ['bob', '2026-01-01T01:00:00Z'],
      ['carol', '2026-01-01T02:00:00Z'],
    ]);
  });

  test.each([
    {
      name: 'a chain whose REST root id matches no thread rootDatabaseId is dropped silently',
      comments: [
        rootComment({ id: 999, nodeId: 'PRRC_999' }),
        reply({ inReplyToId: 999 }),
      ],
    },
    {
      name: 'a thread with a null rootDatabaseId cannot anchor and is dropped silently',
      comments: [rootComment(), reply({ inReplyToId: 100 })],
      anchorless: true,
    },
    {
      name: 'a reply whose parent is missing from the REST collection is dropped silently',
      comments: [rootComment(), reply({ inReplyToId: 999 })],
    },
  ])('$name', ({ comments, anchorless }) => {
    const t = thread(anchorless === true ? { rootDatabaseId: null } : undefined);
    attachRestReplies([t], comments);
    expect(t.replies).toEqual([]);
  });

  test('chain roots themselves are never appended (the thread body already carries the root)', () => {
    const t = thread();
    attachRestReplies([t], [rootComment()]);
    expect(t.replies).toEqual([]);
  });

  test('null createdAt sorts last; equal createdAt keeps REST order (stable)', () => {
    const t = thread();
    attachRestReplies(
      [t],
      [
        rootComment(),
        reply({ id: 103, createdAt: null }),
        reply({ id: 102, createdAt: '2026-01-01T02:00:00Z', authorLogin: 'carol' }),
        reply({ id: 101, createdAt: '2026-01-01T02:00:00Z' }),
      ],
    );
    // REST order is carol (id 102) then bob (id 101); the stable tie keeps it.
    expect(t.replies.map((r) => r.authorLogin)).toEqual(['carol', 'bob', 'bob']);
  });

  test('mutates the passed threads in place (identity preserved, replies appended)', () => {
    const alreadyThere = thread({
      replies: [{ authorLogin: 'dave', body: 'pre-existing', createdAt: null }],
    });
    const threads = [alreadyThere];
    attachRestReplies(
      threads,
      [rootComment(), reply({ createdAt: '2026-01-01T01:00:00Z' })],
    );
    expect(threads[0]).toBe(alreadyThere);
    expect(repliesOf(alreadyThere)).toEqual([
      ['dave', null],
      ['bob', '2026-01-01T01:00:00Z'],
    ]);
  });

  test('multiple threads each receive only their own chains', () => {
    const t1 = thread({ id: 'PRRT_kwDOCa' });
    const t2 = thread({ id: 'PRRT_kwDOCb', rootDatabaseId: 200 });
    attachRestReplies(
      [t1, t2],
      [
        rootComment(),
        rootComment({ id: 200, nodeId: 'PRRC_200', authorLogin: 'carol' }),
        reply({ id: 101, inReplyToId: 100, authorLogin: 'bob' }),
        reply({ id: 201, inReplyToId: 200, authorLogin: 'dave' }),
      ],
    );
    expect(t1.replies.map((r) => r.authorLogin)).toEqual(['bob']);
    expect(t2.replies.map((r) => r.authorLogin)).toEqual(['dave']);
  });
});
