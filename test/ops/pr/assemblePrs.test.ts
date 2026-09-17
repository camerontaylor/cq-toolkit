// PR lane (goal D3) — evidence for the tracker-first assembler
// (src/ops/pr/assemblePrs.ts; UC §1 row 22).
//
// Pinned here, on a recording fake PrEffects (zero processes, zero network):
//   1. TRACKER-FIRST ORDER (the goal's required invariant): on a fresh run
//      the tracker is searched first, then created, BEFORE any per-package
//      PR is searched or created.
//   2. NEVER A SECOND TRACKER: an existing tracker PR (same head branch) is
//      reused — createPr is NOT called for the tracker head, the reused
//      number is reported with created:false, and editPrBody refreshes the
//      manifest in place listing the per-package PRs.
//   3. FAIL BEFORE ANY PACKAGE PR: a tracker search OR creation fault fails
//      the whole op with ZERO package PRs attempted.
//   4. PER-ROW ISOLATION: an existing per-package PR is reused (no
//      duplicate create); a per-package fault lands on its row alone.
//   5. BOUNDARY: prefix violations on tracker.branch and packages[].branch,
//      non-boolean draft, and other field faults are `failed` results
//      naming the field, before any gh call.
//   6. The report is plain JSON (round trip) and the draft default is true.
import { describe, expect, test } from 'vitest';
import {
  makeAssemblePrs,
  MANIFEST_SECTION_MARKER,
  READINESS_SECTION_MARKER,
  type AssemblePrsInput,
  type PrCreateRequest,
  type PrEffects,
  type PrState,
} from '../../../src/ops/pr/assemblePrs.js';

// ---------------------------------------------------------------------------
// Recording fake PrEffects
// ---------------------------------------------------------------------------

interface FakeGh {
  gh: PrEffects;
  /** Every effect call, in order: `search:<head>` / `create:<head>` / `edit:<n>` / `comment:<n>`. */
  calls: string[];
  /** createPr requests, in order. */
  creates: PrCreateRequest[];
  /** editPrBody bodies keyed by PR number. */
  edits: Map<number, string>;
  /** Existing PRs by head branch (the search index); absent state means open. */
  prsByHead: Map<string, { number: number; url?: string; state?: PrState }>;
  /** Track the next createPr number. */
  nextNumber: number;
  /** When set, createPr rejects for heads matching this exact string. */
  createFaultOnHead?: string;
  /** Heads the fake recorded search calls FOR, with the base they were searched against. */
  searches: Array<{ head: string; base: string }>;
}

function fakeGh(seed: Partial<FakeGh> = {}): FakeGh {
  const calls: string[] = [];
  const creates: PrCreateRequest[] = [];
  const edits = new Map<number, string>();
  const searches: Array<{ head: string; base: string }> = [];
  const prsByHead =
    seed.prsByHead ?? new Map<string, { number: number; url?: string; state?: PrState }>();
  let nextNumber = seed.nextNumber ?? 101;
  const state: FakeGh = {
    calls,
    creates,
    edits,
    prsByHead,
    nextNumber,
    searches,
    ...(seed.createFaultOnHead !== undefined ? { createFaultOnHead: seed.createFaultOnHead } : {}),
    gh: {
      searchPrByHead: async (head, base) => {
        calls.push(`search:${head}`);
        searches.push({ head, base });
        const hit = prsByHead.get(head);
        if (hit === undefined) return null;
        return {
          number: hit.number,
          state: hit.state ?? 'open',
          ...(hit.url === undefined ? {} : { url: hit.url }),
        };
      },
      createPr: async (request) => {
        calls.push(`create:${request.head}`);
        creates.push(request);
        if (seed.createFaultOnHead === request.head) {
          throw new Error(`gh refused the create for ${request.head}`);
        }
        const number = nextNumber;
        nextNumber += 1;
        state.nextNumber = nextNumber;
        prsByHead.set(request.head, { number });
        return { number, url: `https://github.test/owner/repo/pull/${String(number)}` };
      },
      editPrBody: async (number, body) => {
        calls.push(`edit:${String(number)}`);
        edits.set(number, body);
      },
      comment: async (number) => {
        calls.push(`comment:${String(number)}`);
      },
      getPrChecks: async () => ({ state: 'pass' }),
      getPrReviewState: async () => ({ state: 'none' }),
      getPrMeta: async () => ({ isDraft: false, state: 'open', mergeable: 'mergeable' }),
      getPrBody: async () => '',
    },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRACKER_BRANCH = 'cq/09-16a/tracker';
const PKG_CORE = 'cq/09-16a/fix/core';
const PKG_UTIL = 'cq/09-16a/fix/util';

function inputOf(overrides: Partial<AssemblePrsInput> = {}): AssemblePrsInput {
  return {
    repoRoot: '/repo',
    runPrefix: 'cq/09-16a',
    base: 'origin/merge-queue',
    tracker: { title: 'Fleet run cq/09-16a', branch: TRACKER_BRANCH },
    packages: [
      { name: 'core', branch: PKG_CORE, title: 'core fixes' },
      { name: 'util', branch: PKG_UTIL, title: 'util fixes', body: 'utility notes' },
    ],
    ...overrides,
  };
}

/** Unwraps an `ok` result; anything else fails the test with what came back. */
async function okReport(op: ReturnType<typeof makeAssemblePrs>, input: AssemblePrsInput) {
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
    );
  }
  return result.value;
}

/** Unwraps a `failed` result's error; any other status fails the test. */
async function failedAt(op: ReturnType<typeof makeAssemblePrs>, input: AssemblePrsInput) {
  const result = await op(input);
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error;
}

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

// ---------------------------------------------------------------------------
// Fail before any package PR exists
// ---------------------------------------------------------------------------

describe('a tracker fault fails the whole op before any package PR', () => {
  test('a tracker SEARCH fault → failed, zero package searches or creates', async () => {
    const fake = fakeGh();
    fake.gh.searchPrByHead = async (head) => {
      fake.calls.push(`search:${head}`);
      throw new Error('gh api rate-limited');
    };
    const error = await failedAt(makeAssemblePrs(fake.gh), inputOf());
    expect(error).toContain('tracker-first failed');
    expect(error).toContain('rate-limited');
    expect(fake.calls).toEqual([`search:${TRACKER_BRANCH}`]);
  });

  test('a tracker CREATE fault → failed, zero package searches or creates', async () => {
    const fake = fakeGh();
    fake.gh.createPr = async (request) => {
      fake.calls.push(`create:${request.head}`);
      throw new Error('draft PRs disabled on this repo');
    };
    const error = await failedAt(makeAssemblePrs(fake.gh), inputOf());
    expect(error).toContain('tracker-first failed');
    expect(fake.calls).toEqual([`search:${TRACKER_BRANCH}`, `create:${TRACKER_BRANCH}`]);
  });

  test('a tracker MANIFEST-EDIT fault → failed, naming the package PRs already ensured', async () => {
    const fake = fakeGh();
    fake.gh.editPrBody = async (number) => {
      fake.calls.push(`edit:${String(number)}`);
      throw new Error('edit refused');
    };
    const error = await failedAt(makeAssemblePrs(fake.gh), inputOf());
    expect(error).toContain('could not update tracker PR #101');
    expect(error).toContain('#102'); // the second package PR was already created
    expect(fake.calls).toEqual([
      `search:${TRACKER_BRANCH}`,
      `create:${TRACKER_BRANCH}`,
      `search:${PKG_CORE}`,
      `create:${PKG_CORE}`,
      `search:${PKG_UTIL}`,
      `create:${PKG_UTIL}`,
      'edit:101',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Per-row isolation
// ---------------------------------------------------------------------------

describe('per-package rows isolate their outcomes', () => {
  test('an existing per-package PR is reused (no duplicate create), others are created', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55 }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    // The tracker create consumed 101; util's fresh PR is 102.
    expect(result.packages).toEqual([
      { name: 'core', number: 55, created: false },
      { name: 'util', number: 102, created: true, url: 'https://github.test/owner/repo/pull/102' },
    ]);
    expect(fake.calls).not.toContain(`create:${PKG_CORE}`);
    expect(fake.calls).toContain(`create:${PKG_UTIL}`);
  });

  test('a per-package create fault lands on its row alone; the other package still assembles', async () => {
    const fake = fakeGh({ createFaultOnHead: PKG_UTIL });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    // The tracker created first (#101); core's fresh PR is #102.
    expect(result.packages[0]).toEqual({
      name: 'core',
      number: 102,
      created: true,
      url: 'https://github.test/owner/repo/pull/102',
    });
    expect(result.packages[1]).toMatchObject({
      name: 'util',
      created: false,
      fault: 'gh refused the create for cq/09-16a/fix/util',
    });
    expect(result.packages[1]?.number).toBeUndefined();
    // The fault is visible in the refreshed tracker manifest.
    expect(fake.edits.get(101)).toContain('FAULT: gh refused the create');
  });

  test('a per-package search fault isolates to its row too', async () => {
    const fake = fakeGh();
    const baseSearch = fake.gh.searchPrByHead;
    fake.gh.searchPrByHead = async (head, base) => {
      if (head === PKG_CORE) throw new Error('search timed out');
      return baseSearch(head, base);
    };
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.packages[0]).toMatchObject({
      name: 'core',
      created: false,
      fault: 'search timed out',
    });
    expect(result.packages[1]).toMatchObject({ name: 'util', created: true });
  });
});

// ---------------------------------------------------------------------------
// Boundary validation — `failed` naming the field
// ---------------------------------------------------------------------------

describe('boundary validation refuses bad inputs before any gh call', () => {
  test('a package branch outside the run prefix is refused naming the entry', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'core', branch: 'feature/core', title: 'core fixes' }] }),
    );
    expect(error).toContain('packages[0].branch');
    expect(error).toContain("must start with the run prefix 'cq/09-16a/'");
    expect(fake.calls).toEqual([]);
  });

  test('the tracker branch outside the run prefix is refused naming the field', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ tracker: { title: 't', branch: 'elsewhere/tracker' } }),
    );
    expect(error).toContain('tracker.branch');
    expect(fake.calls).toEqual([]);
  });

  test('a branch segment that impersonates a git flag is refused', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'core', branch: 'cq/09-16a/-exec', title: 'x' }] }),
    );
    expect(error).toContain('packages[0].branch');
    expect(fake.calls).toEqual([]);
  });

  test('a whitespace-only package title, a non-boolean draft, and a non-object input are refused', async () => {
    const op = makeAssemblePrs(fakeGh().gh);
    const titleResult = await op(
      inputOf({ packages: [{ name: 'c', branch: PKG_CORE, title: '   ' }] }),
    );
    expect(titleResult.status).toBe('failed');
    expect(titleResult.status === 'failed' && titleResult.error).toContain('packages[0].title');
    const draftResult = await op(inputOf({ draft: 'yes' as unknown as boolean }));
    expect(draftResult.status).toBe('failed');
    expect(draftResult.status === 'failed' && draftResult.error).toContain('draft');
    const nullResult = await op(null as unknown as AssemblePrsInput);
    expect(nullResult.status).toBe('failed');
    expect(nullResult.status === 'failed' && nullResult.error).toContain('input must be an object');
  });

  test('a control character in a string fed to gh is refused', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ tracker: { title: 'fleet\nrun', branch: TRACKER_BRANCH } }),
    );
    expect(error).toContain('tracker.title');
    expect(fake.calls).toEqual([]);
  });

  test('a control character in a package NAME is refused (it feeds the tracker markdown)', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'core\n---', branch: PKG_CORE, title: 'x' }] }),
    );
    expect(error).toContain('packages[0].name');
    expect(error).toContain('control characters');
    expect(fake.calls).toEqual([]);
  });

  test('two packages sharing a branch are refused, naming both entries', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({
        packages: [
          { name: 'core', branch: PKG_CORE, title: 'core fixes' },
          { name: 'core-two', branch: PKG_CORE, title: 'another core PR' },
        ],
      }),
    );
    expect(error).toContain('packages[0] and packages[1]');
    expect(error).toContain(PKG_CORE);
    expect(fake.calls).toEqual([]);
  });

  test('a package on the tracker’s own branch is refused', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'core', branch: TRACKER_BRANCH, title: 'x' }] }),
    );
    expect(error).toContain('packages[0].branch');
    expect(error).toContain("is the tracker's own branch");
    expect(fake.calls).toEqual([]);
  });

  test('every search is base-threaded — the PR identity is head AND base', async () => {
    // PR-165 r1#2: a PR from an earlier run against a DIFFERENT base must
    // never be adopted as this fleet's member, so the op passes its own
    // base on every search.
    const fake = fakeGh();
    await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(fake.searches).toEqual([
      { head: TRACKER_BRANCH, base: 'origin/merge-queue' },
      { head: PKG_CORE, base: 'origin/merge-queue' },
      { head: PKG_UTIL, base: 'origin/merge-queue' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Plain-JSON report
// ---------------------------------------------------------------------------

describe('the report is plain JSON', () => {
  test('the ok value survives a JSON round trip unchanged', async () => {
    const fake = fakeGh({
      prsByHead: new Map([
        [PKG_CORE, { number: 55, url: 'https://github.test/owner/repo/pull/55' }],
      ]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test('a faulted row survives a JSON round trip unchanged', async () => {
    const fake = fakeGh({ createFaultOnHead: PKG_UTIL });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// State-aware per-package adoption (PR-165 r2#1)
// ---------------------------------------------------------------------------

describe('a non-open package PR is refused as a ROW fault, never adopted', () => {
  test('a MERGED package PR → its row faults, the op stays ok, the sibling still assembles', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55, state: 'merged' }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.packages[0]).toMatchObject({ name: 'core', created: false });
    expect(result.packages[0]?.fault).toContain("is in state 'merged'");
    expect(result.packages[0]?.number).toBeUndefined();
    expect(result.packages[1]).toMatchObject({ name: 'util', created: true });
    expect(fake.calls).not.toContain(`create:${PKG_CORE}`);
  });

  test('the adoption refusal shows in the tracker manifest', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55, state: 'closed' }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    const manifest = fake.edits.get(result.tracker.number);
    expect(manifest).toContain('FAULT:');
    expect(manifest).toContain("is in state 'closed'");
  });

  test('an OPEN package PR is still adopted in place (the positive pole)', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55, state: 'open' }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.packages[0]).toEqual({ name: 'core', number: 55, created: false });
  });
});

// ---------------------------------------------------------------------------
// The section compose protocol + markdown safety (PR-165 r2#4, r2#7)
// ---------------------------------------------------------------------------

describe('the tracker write composes, never clobbers', () => {
  test('the manifest upsert preserves an existing readiness section verbatim', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[TRACKER_BRANCH, { number: 7 }]]),
    });
    const readinessBody = [
      '<!-- cq:readiness -->',
      '<!-- cq-toolkit fleet-run report: runPrefix cq/09-16a (generated; merge-readiness, never auto-merges) -->',
      '# Fleet run `cq/09-16a` — merge readiness',
      '',
      '- `core` — #11 — checks: pass; review: approved — READY',
      '',
    ].join('\n');
    fake.gh.getPrBody = async () => readinessBody;
    await okReport(makeAssemblePrs(fake.gh), inputOf());
    const written = fake.edits.get(7);
    expect(written).toContain(MANIFEST_SECTION_MARKER);
    expect(written).toContain(READINESS_SECTION_MARKER);
    expect(written).toContain('`core` — #101'); // the fresh manifest content landed
    // The readiness section survived BYTE-FOR-BYTE.
    expect(written).toContain(readinessBody.trimEnd());
  });

  test('markdown metacharacters in a package name cannot break the manifest bullets', async () => {
    const fake = fakeGh();
    await okReport(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'co`re<b>', branch: PKG_CORE, title: 'x' }] }),
    );
    const written = fake.edits.get(101);
    expect(written).toContain('`co\\`reb`'); // backtick escaped, angle stripped
    expect(written).not.toContain('<b>');
  });

  test('a MULTILINE markdown body is accepted and transported verbatim (r3 codex jMJpG)', async () => {
    // The body rides stdin (--body-file -) straight to the PR and is never
    // interpolated into the tracker manifest — control characters and
    // newlines are its business, so the old Cc refusal is gone.
    const fake = fakeGh();
    const multilineBody = '## Notes\n\n- one\n- two\n\n```sh\nnpm test\n```';
    const result = await okReport(
      makeAssemblePrs(fake.gh),
      inputOf({
        packages: [{ name: 'core', branch: PKG_CORE, title: 'core fixes', body: multilineBody }],
      }),
    );
    expect(result.packages[0]).toMatchObject({ name: 'core', created: true });
    // creates[0] is the TRACKER (tracker-first); the package create is second.
    expect(fake.creates[1]?.head).toBe(PKG_CORE);
    expect(fake.creates[1]?.body).toBe(multilineBody);
  });

  test('a non-string body is still refused naming the field', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({
        packages: [{ name: 'core', branch: PKG_CORE, title: 'x', body: 42 as unknown as string }],
      }),
    );
    expect(error).toContain('packages[0].body must be a string');
    expect(fake.calls).toEqual([]);
  });
});
