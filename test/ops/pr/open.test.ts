// pr.open op tests over a REAL git repo with a pushed branch and a gh fake:
// the readiness gate (a not-ready branch is refused with the gaps), the
// clean-tree and remote-head rules, adopt-or-create (never a second PR),
// the managed body section, and the dispositions comment.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DEV_LEDGER_VERSION, type DevLedgerFile } from '../../../src/ops/dev/record.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import {
  DEV_READINESS_SECTION_MARKER,
  makePrOpen,
  renderDispositionsComment,
  renderReadinessSection,
} from '../../../src/ops/pr/open.js';
import {
  BASE,
  BRANCH,
  cycleRecord,
  dispositionRecord,
  HEAD,
  ledgerWith,
  makeFakeEffects,
} from '../dev/fakes.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from '../dev/repo.js';

interface GhExisting {
  number?: number;
  state?: 'open' | 'closed' | 'merged';
  isCrossRepository?: boolean;
}

/** A gh fake implementing the PrEffects seam with a recording list. */
function ghFake(existing: GhExisting | null = null) {
  const calls: { effect: string; args: unknown[] }[] = [];
  const gh: PrEffects = {
    searchPrByHead: async (head, base) => {
      calls.push({ effect: 'searchPrByHead', args: [head, base] });
      if (existing === null) return null;
      return {
        number: existing.number ?? 41,
        state: existing.state ?? 'open',
        isCrossRepository: existing.isCrossRepository ?? false,
      };
    },
    createPr: async (request) => {
      calls.push({ effect: 'createPr', args: [request] });
      return { number: 42, url: 'https://example.invalid/pull/42' };
    },
    editPrBody: async (number, body) => {
      calls.push({ effect: 'editPrBody', args: [number, body] });
    },
    getPrBody: async (number) => {
      calls.push({ effect: 'getPrBody', args: [number] });
      return '# existing prose\n\ncustom section\n';
    },
    comment: async (number, body) => {
      calls.push({ effect: 'comment', args: [number, body] });
    },
    getPrReadiness: async (number) => {
      calls.push({ effect: 'getPrReadiness', args: [number] });
      throw new Error('not used by pr.open');
    },
  };
  return { gh, calls };
}

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
  repo.git('push', '-q', 'origin', 'feature/x');
});
afterEach(async () => {
  await repo.cleanup();
});

/** A ready, pushed branch, optionally with a dispositioned minor finding. */
async function ready(withDisposition = false) {
  return seed(repo, (state) =>
    withDisposition
      ? [
          cycleRecord({
            cycleId: 'c000-aaaaaaaa',
            base: state.base,
            head: state.head,
            findings: [{ id: 'c000-aaaaaaaa#f1', severity: 'minor' }],
            completion: { kind: 'blocked', reason: 'earlier attempt' },
          }),
          cycleRecord({
            cycleId: 'c003-aaaaaaaa',
            base: state.base,
            head: state.head,
            dirtySha256: state.dirtySha256,
          }),
          dispositionRecord({
            findingId: 'c000-aaaaaaaa#f1',
            action: 'rejected',
            why: 'false positive: x',
          }),
        ]
      : [],
  );
}

const effects = () => repoEffects(repo);

describe('pr.open', () => {
  test('applies configured readiness severities before opening a PR', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        review: { blockingSeverities: ['critical', 'major', 'minor'] },
      }),
    );
    repo.commitAll('configure adopter readiness policy');
    repo.git('push', '-q', 'origin', 'feature/x');
    const state = await seed(repo, (current) => [
      cycleRecord({
        cycleId: 'c002-minor01',
        head: current.head,
        base: current.base,
        dirtySha256: current.dirtySha256,
        findings: [{ id: 'c002-minor01#f1', severity: 'minor' }],
      }),
    ]);
    const { gh, calls } = ghFake();
    const result = await makePrOpen(effects(), gh)({ repoRoot: repo.root });
    expect(state.dirtySha256).toBe('clean-tree');
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('open-blocking-findings');
    expect(calls).toEqual([]);
  });

  test('creates the PR from a ready record: managed section body, dispositions comment', async () => {
    const state = await ready(true);
    const { gh, calls } = ghFake();
    const result = await makePrOpen(effects(), gh)({ repoRoot: repo.root });
    expect(result).toEqual({
      status: 'ok',
      value: {
        number: 42,
        url: 'https://example.invalid/pull/42',
        created: true,
        base: 'merge-queue',
        head: state.head,
        branch: 'feature/x',
        evidenceClass: 'author',
      },
    });
    const create = calls.find((call) => call.effect === 'createPr')?.args[0] as {
      title: string;
      body: string;
      base: string;
      draft: boolean;
    };
    expect(create.title).toBe('feature');
    expect(create.base).toBe('merge-queue');
    expect(create.draft).toBe(false);
    expect(create.body.startsWith(DEV_READINESS_SECTION_MARKER)).toBe(true);
    expect(create.body).toContain('| check:static | pass |');
    expect(calls.map((call) => call.effect)).toEqual(['searchPrByHead', 'createPr', 'comment']);
  });

  test('adopts the existing OPEN PR: section composed over its prose, no second PR or comment', async () => {
    await ready(true);
    const { gh, calls } = ghFake({ number: 41 });
    const result = await makePrOpen(effects(), gh)({ repoRoot: repo.root });
    expect(result.status === 'ok' && result.value.created).toBe(false);
    const edit = calls.find((call) => call.effect === 'editPrBody');
    const body = String(edit?.args[1]);
    expect(body).toContain('# existing prose');
    expect(body).toContain(DEV_READINESS_SECTION_MARKER);
    expect(calls.map((call) => call.effect)).toEqual(['searchPrByHead', 'getPrBody', 'editPrBody']);
  });

  test.each([{ state: 'merged' as const }, { isCrossRepository: true }])(
    'refuses a landed or foreign PR %j instead of rewriting it',
    async (existing) => {
      await ready();
      const { gh, calls } = ghFake(existing);
      const result = await makePrOpen(effects(), gh)({ repoRoot: repo.root });
      expect(result.status).toBe('failed');
      expect(calls.map((call) => call.effect)).toEqual(['searchPrByHead']);
    },
  );

  test('a not-ready branch is refused with the gaps and ZERO gh calls', async () => {
    const { gh, calls } = ghFake();
    const result = await makePrOpen(effects(), gh)({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('terminal-review-cycle');
    expect(calls).toEqual([]);
  });

  test('a tree with staged, unstaged or untracked work is refused even when the record matches it', async () => {
    await repo.write('src/a.ts', 'export const a = 2;\n');
    repo.git('add', 'src/a.ts');
    await repo.write('src/a.ts', 'export const a = 1;\n');
    await ready();
    const { gh, calls } = ghFake();
    const result = await makePrOpen(effects(), gh)({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('staged, unstaged or untracked');
    expect(calls).toEqual([]);
  });

  test('a never-pushed branch or a remote at another head is needs-human before any gh call', async () => {
    await ready();
    repo.git('push', '-q', 'origin', '--delete', 'feature/x');
    const unpushed = ghFake();
    const never = await makePrOpen(effects(), unpushed.gh)({ repoRoot: repo.root });
    expect(never.status === 'needs-human' && never.reason).toContain('never pushed');
    repo.git('push', '-q', 'origin', 'HEAD~1:refs/heads/feature/x');
    const behind = ghFake();
    const other = await makePrOpen(effects(), behind.gh)({ repoRoot: repo.root });
    expect(other.status === 'needs-human' && other.reason).toContain('push the reviewed head');
    expect([...unpushed.calls, ...behind.calls]).toEqual([]);
  });

  test('a comment fault fails naming the PR (the body already carries the dispositions)', async () => {
    await ready(true);
    const { gh } = ghFake();
    gh.comment = async () => {
      throw new Error('gh: 502');
    };
    const result = await makePrOpen(effects(), gh)({ repoRoot: repo.root });
    expect(result.status === 'failed' && result.error).toContain('PR #42 is open');
  });

  test('--draft and --title pass through to the create request', async () => {
    await ready();
    const { gh, calls } = ghFake();
    await makePrOpen(effects(), gh)({ repoRoot: repo.root, draft: true, title: 'feat: x' });
    expect(calls.find((call) => call.effect === 'createPr')?.args[0]).toMatchObject({
      draft: true,
      title: 'feat: x',
    });
  });

  test('a schema-bypassing input fails before any effect', async () => {
    const dev = makeFakeEffects();
    const { gh, calls } = ghFake();
    const result = await makePrOpen(dev, gh)({ repoRoot: '' });
    expect(result.status).toBe('failed');
    expect([...dev.commands, ...calls]).toEqual([]);
  });
});

describe('the readiness renderers', () => {
  const record = {
    ready: true as const,
    evidenceClass: 'author' as const,
    caveat: 'the caveat',
    branch: BRANCH,
    target: 'merge-queue',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    cycleId: 'c001-aaaaaaaa',
    reviewer: 'coderabbit',
    checkId: 'k001-aaaaaaaa',
    at: '2026-10-17T00:00:00.000Z',
  };
  const ledger: DevLedgerFile = {
    version: DEV_LEDGER_VERSION,
    branch: BRANCH,
    records: [dispositionRecord()],
  };

  test('the section renders start and end markers, a markdown-safe gate table, and the caveat', () => {
    const section = renderReadinessSection(record, ledger, [
      { name: 'check:static', status: 'pass', durationMs: 12 },
      { name: 'a|b', status: 'pass', durationMs: 1 },
    ]);
    expect(section.startsWith(DEV_READINESS_SECTION_MARKER)).toBe(true);
    expect(section).toContain('<!-- /cq:dev-readiness -->');
    expect(section).toContain('| a\\|b |');
    expect(section).toContain('the caveat');
  });

  test('the dispositions comment lists every disposition with its action and reason', () => {
    const body = renderDispositionsComment(ledger);
    expect(body).toContain('c001-aaaaaaaa#f1');
    expect(body).toContain('**fixed**');
    expect(body).toContain('addressed in the diff');
  });

  test('an empty disposition list renders the explicit none-note, never a bare section', () => {
    const body = renderDispositionsComment({ ...ledger, records: [] });
    expect(body).toContain('No findings were dispositioned');
  });
});

describe('the readiness section markdown escaping', () => {
  const baseRecord = {
    ready: true as const,
    evidenceClass: 'author' as const,
    caveat: 'the caveat',
    branch: BRANCH,
    target: 'merge-`queue`',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    cycleId: 'c001-aaaaaaaa',
    reviewer: 'coderabbit',
    checkId: 'k001-aaaaaaaa',
    at: '2026-10-17T00:00:00.000Z',
  };

  test('a backtick in a recorded field cannot close the managed code span', () => {
    const section = renderReadinessSection(baseRecord, ledgerWith([], BRANCH), []);
    // mdSafe's spelling: backticks become typographic apostrophes — the
    // field stays inert inside the generated span.
    expect(section).toContain('`merge-’queue’`');
    expect(section).not.toContain('merge-`queue`');
  });

  test('angle brackets in a disposition reason are stripped, not rendered', () => {
    const ledger = ledgerWith([dispositionRecord({ why: '<script>alert(1)</script>' })], BRANCH);
    const section = renderReadinessSection(baseRecord, ledger, []);
    expect(section).not.toContain('<script>');
    expect(section).toContain('scriptalert(1)/script');
  });
});
