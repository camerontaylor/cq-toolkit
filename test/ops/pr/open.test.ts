// pr.open op tests over a REAL git repo with a pushed branch and a gh fake:
// the readiness gate (a not-ready branch is refused with the gaps), the
// clean-tree and remote-head rules, adopt-or-create (never a second PR),
// the managed body section, and the dispositions comment.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DEV_LEDGER_VERSION, type DevLedgerFile } from '../../../src/ops/dev/record.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import {
  DEV_READINESS_GAPS_SECTION_MARKER,
  DEV_READINESS_SECTION_MARKER,
  makePrOpen,
  renderDispositionsComment,
  renderReadinessGapsSection,
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
  isDraft?: boolean;
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
        ...(existing.isDraft === undefined ? {} : { isDraft: existing.isDraft }),
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
        ready: true,
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

  test('draftWhenNotReady (with draft): a not-ready branch opens the DRAFT with the gaps section, ready:false', async () => {
    // No seed: the fresh branch has no terminal cycle and no check, so the
    // gaps are real and the flag must publish them instead of refusing.
    const { gh, calls } = ghFake();
    const result = await makePrOpen(
      effects(),
      gh,
    )({
      repoRoot: repo.root,
      draft: true,
      draftWhenNotReady: true,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.ready).toBe(false);
    const create = calls.find((call) => call.effect === 'createPr')?.args[0] as {
      draft: boolean;
      body: string;
    };
    expect(create.draft).toBe(true);
    expect(create.body.startsWith(DEV_READINESS_GAPS_SECTION_MARKER)).toBe(true);
    expect(create.body).toContain('NOT READY');
    expect(create.body).toContain('terminal-review-cycle');
    expect(create.body).toContain('green-check');
    // The round-cap body's SECOND spec section: dispositions (here, the
    // explicit none-note — the fresh branch has none yet).
    expect(create.body).toContain('finding dispositions: 0');
    expect(create.body).toContain('(none recorded)');
    expect(create.body).not.toContain(DEV_READINESS_SECTION_MARKER);
  });

  test('the not-ready gaps section binds advisories to the exact dirty identity', async () => {
    await seed(repo, () => [
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        reviewer: 'agent',
        dirtySha256: 'different-dirty',
        advisories: ['stale dirty advisory'],
      }),
    ]);
    const { gh, calls } = ghFake();
    const result = await makePrOpen(
      effects(),
      gh,
    )({
      repoRoot: repo.root,
      draft: true,
      draftWhenNotReady: true,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.ready).toBe(false);
    const create = calls.find((call) => call.effect === 'createPr')?.args[0] as {
      body: string;
    };
    expect(create.body).toContain('stale-review-identity');
    expect(create.body).not.toContain('stale dirty advisory');
  });

  test('an ADOPTED not-ready re-run refreshes the gaps AND dispositions sections in place', async () => {
    // First pass: open the not-ready draft.
    const first = ghFake();
    const opened = await makePrOpen(
      effects(),
      first.gh,
    )({
      repoRoot: repo.root,
      draft: true,
      draftWhenNotReady: true,
    });
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    // Dispositions land in the ledger AFTER the draft exists. The seed
    // REPLACES the (empty) ledger with a terminal cycle + green check at
    // the same identity, so on the re-read the branch IS ready — the
    // adopt path runs the standard readiness section, which carries the
    // dispositions (the one-time comment never duplicated them). The
    // section refreshes in place inside its span; the gaps section of the
    // first draft stays as history prose.
    await seed(repo, () => [
      dispositionRecord({
        findingId: 'c005-aaaaaaaa#f1',
        action: 'deferred',
        why: 'owner decision needed',
      }),
    ]);
    // Second pass: same branch, the OPEN PR is adopted and its managed
    // section refreshed in place — the dispositions appear inside the
    // refreshed span, nothing duplicates, and the one-time comment stays a
    // creation-time artifact.
    const second = ghFake({ number: 41 });
    const adopted = await makePrOpen(
      effects(),
      second.gh,
    )({
      repoRoot: repo.root,
    });
    expect(adopted.status).toBe('ok');
    if (adopted.status !== 'ok') return;
    expect(adopted.value.ready).toBe(true);
    const edit = second.calls.find((call) => call.effect === 'editPrBody');
    const body = String(edit?.args[1]);
    // The READY section carries the dispositions inside its managed span
    // (its own details block) — refreshed in place, no duplicate comment.
    expect(body).toContain('dispositions recorded: 1');
    expect(body).toContain('`c005-aaaaaaaa#f1` — **deferred**: owner decision needed');
    expect(body.match(/c005-aaaaaaaa#f1/g)?.length).toBe(1);
    expect(body).toContain(DEV_READINESS_SECTION_MARKER);
    expect(second.calls.map((call) => call.effect)).toEqual([
      'searchPrByHead',
      'getPrBody',
      'editPrBody',
    ]);
  });

  test('draftWhenNotReady never has an effect without draft:true (a not-ready branch is still refused)', async () => {
    // No seed: the fresh branch is not ready, and without draft:true the
    // flag must change nothing — the refusal names the gaps.
    const { gh, calls } = ghFake();
    const result = await makePrOpen(
      effects(),
      gh,
    )({
      repoRoot: repo.root,
      draftWhenNotReady: true,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('terminal-review-cycle');
    expect(calls).toEqual([]);
  });

  test('BEFORE (P2 7kNe): adopting a NON-DRAFT PR while not ready refuses naming the transition (#472 seam)', async () => {
    const { gh, calls } = ghFake({ number: 41, isDraft: false });
    // The existing OPEN PR is NOT a draft; the not-ready branch must not
    // ride it as a submission.
    const result = await makePrOpen(
      effects(),
      gh,
    )({
      repoRoot: repo.root,
      draft: true,
      draftWhenNotReady: true,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('not a draft');
    expect(calls.filter((call) => call.effect === 'editPrBody')).toEqual([]);
  });

  test('a ready branch under draftWhenNotReady passes its explicit draft through, ready:true', async () => {
    await ready();
    const { gh, calls } = ghFake();
    const result = await makePrOpen(
      effects(),
      gh,
    )({
      repoRoot: repo.root,
      draft: true,
      draftWhenNotReady: true,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.ready).toBe(true);
    const create = calls.find((call) => call.effect === 'createPr')?.args[0] as {
      draft: boolean;
      body: string;
    };
    // A ready branch under the flag: the explicit draft passes through
    // (the caller asked for one), and the body is the standard readiness
    // section — never the NOT-READY gaps.
    expect(create.draft).toBe(true);
    expect(create.body.startsWith(DEV_READINESS_SECTION_MARKER)).toBe(true);
  });

  test('an unreadable state under draftWhenNotReady is a refusal, never a draft', async () => {
    await seed(repo);
    repo.git('checkout', '-q', '--detach', 'HEAD');
    const { gh, calls } = ghFake();
    const result = await makePrOpen(
      effects(),
      gh,
    )({
      repoRoot: repo.root,
      draft: true,
      draftWhenNotReady: true,
    });
    expect(result.status).toBe('needs-human');
    expect(calls).toEqual([]);
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

  test('review advisories follow the latest matching comparison and stay markdown-safe', () => {
    const advisoryLedger = ledgerWith([
      cycleRecord({ reviewer: 'agent', advisories: ['superseded note'] }),
      cycleRecord({ reviewer: 'agent', advisories: ['large change <script>\nlookups limited'] }),
      cycleRecord({
        reviewer: 'agent',
        scope: 'uncommitted',
        advisories: ['uncommitted note'],
      }),
      cycleRecord({
        reviewer: 'agent',
        dirtySha256: 'different-dirty',
        advisories: ['different dirty note'],
      }),
      cycleRecord({ reviewer: 'agent', head: 'different-head', advisories: ['stale head'] }),
      cycleRecord({ reviewer: 'agent', base: 'different-base', advisories: ['stale base'] }),
      cycleRecord({ reviewer: 'agent', target: 'different-target', advisories: ['stale target'] }),
    ]);
    const ready = renderReadinessSection(record, advisoryLedger, []);
    const gaps = renderReadinessGapsSection(record, advisoryLedger, record.target, []);
    for (const section of [ready, gaps]) {
      expect(section).toContain('### Review advisories');
      expect(section).toContain('- large change script lookups limited');
      expect(section).not.toContain('<script>');
      expect(section).not.toContain('superseded note');
      expect(section).not.toContain('stale head');
      expect(section).not.toContain('stale base');
      expect(section).not.toContain('stale target');
      expect(section).not.toContain('uncommitted note');
      expect(section).not.toContain('different dirty note');
    }
    expect(ready).toContain('terminal, reviewer');
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

describe('the NOT-READY gaps section renderer', () => {
  const state = { branch: BRANCH, head: HEAD, base: BASE };
  const gaps = [
    { field: 'terminal-review-cycle', detail: 'no terminal full-scope review cycle recorded' },
    { field: 'open-blocking-findings', detail: 'open blocking findings: c001|x (major)' },
  ];

  test('the section renders start and end markers and every gap verbatim', () => {
    const section = renderReadinessGapsSection(state, ledgerWith([], BRANCH), 'merge-queue', gaps);
    expect(section.startsWith(DEV_READINESS_GAPS_SECTION_MARKER)).toBe(true);
    expect(section).toContain('<!-- /cq:dev-readiness-gaps -->');
    expect(section).toContain(
      '**terminal-review-cycle**: no terminal full-scope review cycle recorded',
    );
    expect(section).toContain('blocking gaps: 2');
  });

  test('the branch ledger dispositions render inside the managed span (the round-cap body lists them)', () => {
    const section = renderReadinessGapsSection(
      state,
      ledgerWith(
        [
          dispositionRecord({
            findingId: 'c000-aaaaaaaa#f1',
            action: 'rejected',
            why: 'false positive: x',
          }),
          dispositionRecord({
            findingId: 'c000-aaaaaaaa#f2',
            action: 'fixed',
            why: 'addressed in the diff',
          }),
        ],
        BRANCH,
      ),
      'merge-queue',
      gaps,
    );
    expect(section).toContain('finding dispositions: 2');
    expect(section).toContain('`c000-aaaaaaaa#f1` — **rejected**: false positive: x');
    expect(section).toContain('`c000-aaaaaaaa#f2` — **fixed**: addressed in the diff');
    // Inside the span: an adopted re-run replaces, never duplicates.
    expect(section.indexOf('finding dispositions')).toBeLessThan(
      section.indexOf('<!-- /cq:dev-readiness-gaps -->'),
    );
  });

  test('an empty disposition list renders the explicit none-note', () => {
    const section = renderReadinessGapsSection(state, ledgerWith([], BRANCH), 'merge-queue', gaps);
    expect(section).toContain('finding dispositions: 0');
    expect(section).toContain('(none recorded)');
  });

  test('pipes and angle brackets in gap details and disposition reasons cannot fabricate table or markup syntax', () => {
    const section = renderReadinessGapsSection(
      state,
      ledgerWith([dispositionRecord({ why: 'a|b <script>x</script>' })], BRANCH),
      'merge-queue',
      [{ field: 'a|b', detail: '<script>y</script>' }],
    );
    expect(section).toContain('**a\\|b**:');
    expect(section).toContain('a\\|b scriptx/script');
    expect(section).not.toContain('<script>');
  });
});
