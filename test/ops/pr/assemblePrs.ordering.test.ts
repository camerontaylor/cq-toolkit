// Split provenance: test/ops/pr/assemblePrs.test.ts was split by subject;
// this file holds the tracker-first ordering (invariant 1) and the in-place
// reuse of an existing tracker (invariant 2). Shared fixtures live in
// assemblePrs.helpers.ts.
import { afterAll, describe, expect, test } from 'vitest';
import {
  PKG_CORE,
  PKG_UTIL,
  TRACKER_BRANCH,
  cleanupRepoRoot,
  failedAt,
  fakeGh,
  inputOf,
  makeAssemblePrs,
  okReport,
} from './assemblePrs.helpers.js';

afterAll(cleanupRepoRoot);

// ---------------------------------------------------------------------------
// Tracker-first ordering (UC row 22)
// ---------------------------------------------------------------------------

describe('tracker-first ordering', () => {
  test('a fresh run searches the tracker first and creates it before ANY package PR', async () => {
    const fake = fakeGh();
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    // Order: the FIRST call is the tracker search; the tracker create lands
    // before the first per-package search; packages follow in input order.
    expect(fake.calls).toEqual([
      `search:${TRACKER_BRANCH}`,
      `create:${TRACKER_BRANCH}`,
      `search:${PKG_CORE}`,
      `create:${PKG_CORE}`,
      `search:${PKG_UTIL}`,
      `create:${PKG_UTIL}`,
      `edit:${String(result.tracker.number)}`,
    ]);
    expect(result.tracker.created).toBe(true);
    expect(result.packages.map((row) => [row.name, row.created])).toEqual([
      ['core', true],
      ['util', true],
    ]);
  });

  test('the tracker create carries the pending fleet manifest as its body and defaults to draft', async () => {
    const fake = fakeGh();
    await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(fake.creates[0]?.head).toBe(TRACKER_BRANCH);
    expect(fake.creates[0]?.draft).toBe(true);
    expect(fake.creates[0]?.body).toContain('# Fleet run `cq/09-16a`');
    expect(fake.creates[0]?.body).toContain('`core` — pending');
    expect(fake.creates[0]?.body).toContain('`util` — pending');
  });

  test('draft:false is honored on every create', async () => {
    const fake = fakeGh();
    await okReport(makeAssemblePrs(fake.gh), inputOf({ draft: false }));
    expect(fake.creates.every((request) => request.draft === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Never a second tracker
// ---------------------------------------------------------------------------

describe('an existing tracker is reused in place', () => {
  test('createPr is NOT called for the tracker head; editPrBody refreshes its manifest', async () => {
    const fake = fakeGh({
      prsByHead: new Map([
        [TRACKER_BRANCH, { number: 7, url: 'https://github.test/owner/repo/pull/7' }],
      ]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.tracker).toEqual({
      number: 7,
      created: false,
      url: 'https://github.test/owner/repo/pull/7',
    });
    // The ONLY tracker-head call is the search (no create), and the edit
    // lands on the REUSED number after the package PRs exist.
    expect(fake.calls.filter((call) => call.includes(TRACKER_BRANCH))).toEqual([
      `search:${TRACKER_BRANCH}`,
    ]);
    expect(fake.calls.filter((call) => call.startsWith('create:'))).toEqual([
      `create:${PKG_CORE}`,
      `create:${PKG_UTIL}`,
    ]);
    expect(fake.calls[fake.calls.length - 1]).toBe('edit:7');
    // The refreshed manifest lists the freshly created per-package PRs.
    const body = fake.edits.get(7);
    expect(body).toContain('`core` — #101');
    expect(body).toContain('`util` — #102');
    expect(body).not.toContain('pending');
  });

  test('a MERGED or CLOSED tracker is REFUSED — a landed record is never rewritten (zero package PRs)', async () => {
    // PR-165 r1#7 flip: search --state all still FINDS a non-open tracker,
    // but adoption would rewrite a merged PR's body. The op refuses,
    // naming the state and the branch, BEFORE any package PR is attempted.
    for (const closedState of ['merged', 'closed', 'unknown'] as const) {
      const fake = fakeGh({
        prsByHead: new Map([[TRACKER_BRANCH, { number: 3, state: closedState }]]),
      });
      const error = await failedAt(makeAssemblePrs(fake.gh), inputOf());
      expect(error).toContain(`state '${closedState}'`);
      expect(error).toContain(TRACKER_BRANCH);
      expect(error).toContain('pick a fresh run prefix');
      expect(fake.calls).toEqual([`search:${TRACKER_BRANCH}`]);
    }
  });

  test('an OPEN tracker is adopted in place (the r1#7 positive pole)', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[TRACKER_BRANCH, { number: 3, state: 'open' }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.tracker).toEqual({ number: 3, created: false });
  });
});
