// dev.ready and dev.disposition over a REAL git repo: readiness is computed
// from the CURRENT state (the identity the ledger records must match), and
// dispositions append only for findings a cycle recorded.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { makeDevReady, readReadinessWithGaps } from '../../../src/ops/dev/ready.js';
import type { DevRecord } from '../../../src/ops/dev/record.js';
import type { WorkState } from '../../../src/ops/dev/internal/workState.js';
import type { DeferredQueueClient } from '../../../src/ops/review/internal/queueProtocol.js';
import { cycleRecord, makeFakeEffects } from './fakes.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

describe('dev.ready', () => {
  test('ready: the author-tier record with the caveat and the evidence ids', async () => {
    const state = await seed(repo);
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value).toMatchObject({
        ready: true,
        evidenceClass: 'author',
        branch: 'feature/x',
        target: 'merge-queue',
        head: state.head,
        cycleId: 'c001-aaaaaaaa',
        reviewer: 'coderabbit',
        checkId: 'k001-aaaaaaaa',
      });
      expect(result.value.caveat).toContain('not verification');
    }
  });

  test('a terminal configured agent cycle satisfies readiness and is named in the record', async () => {
    await seed(repo, (state) => [
      cycleRecord({
        cycleId: 'c002-bbbbbbbb',
        reviewer: 'agent:reviewer',
        base: state.base,
        head: state.head,
        dirtySha256: state.dirtySha256,
      }),
    ]);
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status === 'ok')
      expect(result.value).toMatchObject({ cycleId: 'c002-bbbbbbbb', reviewer: 'agent:reviewer' });
  });

  test('a later blocked agent attempt prevents readiness over an older terminal CodeRabbit cycle', async () => {
    const state = await seed(repo, (identity) => [
      cycleRecord({
        cycleId: 'c002-blocked-agent',
        reviewer: 'agent:reviewer',
        base: identity.base,
        head: identity.head,
        dirtySha256: identity.dirtySha256,
        completion: { kind: 'blocked', reason: 'scripted provider unavailable' },
      }),
    ]);
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('latest-review-blocked');
      expect(result.reason).toContain('c002-blocked-agent');
      expect(result.reason).toContain('scripted provider unavailable');
      expect(result.reason).not.toContain('stale-review-identity');
    }
    const records = repoEffects(repo).openLedger(state.branch).load().records;
    expect(
      records.filter((record) => record.kind === 'cycle').map((record) => record.reviewer),
    ).toEqual(['coderabbit', 'agent:reviewer']);
  });

  test('an unconfigured reviewer terminal cycle cannot satisfy readiness', async () => {
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        review: { reviewers: ['coderabbit'] },
      }),
    );
    repo.commitAll('configure CodeRabbit only');
    const state = await seed(repo);
    const ledgerStore = repoEffects(repo).openLedger(state.branch);
    const ledger = ledgerStore.load();
    ledgerStore.save({
      ...ledger,
      records: ledger.records.map((record) =>
        record.kind === 'cycle' ? { ...record, reviewer: 'agent:reviewer' } : record,
      ),
    });
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('terminal-review-cycle');
  });

  test('malformed cq.json refuses readiness', async () => {
    await repo.write('cq.json', '{ invalid');
    repo.commitAll('malformed config');
    await seed(repo);
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('cq.json');
  });

  test('an edit after the records makes both stale; every gap lands in one reason', async () => {
    await seed(repo);
    await repo.write('src/a.ts', 'export const a = 2;\n');
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('stale-review-identity');
      expect(result.reason).toContain('stale-check-identity');
    }
  });

  test('an untracked file holds readiness, named', async () => {
    await repo.write('scratch/new.ts', 'export {};\n');
    await seed(repo);
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('scratch/new.ts');
  });

  test('records for another target are stale for this one', async () => {
    await seed(repo);
    repo.git('push', '-q', 'origin', 'origin/merge-queue:refs/heads/main');
    repo.git('fetch', '-q', 'origin');
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root, target: 'main' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain("not 'main'");
  });

  test('a same-identity no-fresh tail resolves to ready through its reuse record (#485)', async () => {
    await seed(repo, (current) => [
      cycleRecord({
        cycleId: 'c002-bbbbbbbb',
        completion: {
          kind: 'blocked',
          reason:
            "reviewer completed 'review_completed' with an AFFIRMATIVE no-fresh/skipped notice " +
            '("No fresh detailed file review was performed in this run.") — a fresh detailed review never ran',
        },
        base: current.base,
        head: current.head,
        dirtySha256: current.dirtySha256,
      }),
      {
        kind: 'reuse',
        reuseId: 'r001-bbbbbbbb',
        cycleId: 'c001-aaaaaaaa',
        basis: 'no-fresh-tail',
        resolvesCycleId: 'c002-bbbbbbbb',
        target: 'merge-queue',
        base: current.base,
        head: current.head,
        dirtySha256: current.dirtySha256,
        scope: 'full',
        reviewer: 'coderabbit',
        logPath: '/tmp/reuse.log',
        at: '2026-10-18T00:30:00.000Z',
      },
    ]);
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.cycleId).toBe('c001-aaaaaaaa');
      expect(result.value.reuse).toBe('r001-bbbbbbbb');
    }
  });

  test('the same no-fresh tail without a reuse record stays NOT READY (latest-review-blocked)', async () => {
    await seed(repo, (current) => [
      cycleRecord({
        cycleId: 'c002-bbbbbbbb',
        completion: {
          kind: 'blocked',
          reason:
            "reviewer completed 'review_completed' with an AFFIRMATIVE no-fresh/skipped notice " +
            '("No fresh detailed file review was performed in this run.") — a fresh detailed review never ran',
        },
        base: current.base,
        head: current.head,
        dirtySha256: current.dirtySha256,
      }),
    ]);
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('latest-review-blocked');
      expect(result.reason).toContain('c002-bbbbbbbb');
    }
  });

  test('a genuine later blocker (CLI error) still refuses readiness over an older terminal', async () => {
    await seed(repo, (current) => [
      cycleRecord({
        cycleId: 'c002-bbbbbbbb',
        completion: { kind: 'blocked', reason: 'reviewer stream carried an error event' },
        base: current.base,
        head: current.head,
        dirtySha256: current.dirtySha256,
      }),
      {
        kind: 'reuse',
        reuseId: 'r001-bbbbbbbb',
        cycleId: 'c001-aaaaaaaa',
        basis: 'no-fresh-tail',
        resolvesCycleId: 'c002-bbbbbbbb',
        target: 'merge-queue',
        base: current.base,
        head: current.head,
        dirtySha256: current.dirtySha256,
        scope: 'full',
        reviewer: 'coderabbit',
        logPath: '/tmp/reuse.log',
        at: '2026-10-18T00:30:00.000Z',
      },
    ]);
    const result = await makeDevReady(repoEffects(repo))({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('latest-review-blocked');
  });

  test('a corrupt ledger or a detached head is needs-human, never a silent pass', async () => {
    const state = await seed(repo);
    const effects = repoEffects(repo, undefined, {
      openLedger: () => {
        throw new Error('dev-record: not valid JSON');
      },
    });
    const corrupt = await makeDevReady(effects)({ repoRoot: repo.root });
    expect(corrupt.status).toBe('needs-human');
    if (corrupt.status === 'needs-human') expect(corrupt.reason).toContain('not valid JSON');
    repo.git('checkout', '-q', '--detach', state.head);
    expect((await makeDevReady(repoEffects(repo))({ repoRoot: repo.root })).status).toBe(
      'needs-human',
    );
  });
});

describe('dev.disposition', () => {
  const finding = (state: WorkState): DevRecord[] => [
    cycleRecord({
      cycleId: 'c002-bbbbbbbb',
      base: state.base,
      head: state.head,
      findings: [{ id: 'c002-bbbbbbbb#f1', severity: 'major' }],
    }),
  ];

  test('records a disposition for a recorded finding; its reason is trimmed', async () => {
    const state = await seed(repo, finding);
    const effects = repoEffects(repo);
    const result = await makeDevDisposition(effects)({
      repoRoot: repo.root,
      findingId: 'c002-bbbbbbbb#f1',
      action: 'rejected',
      why: '  false positive: the path is test-only  ',
    });
    expect(result).toEqual({
      status: 'ok',
      value: {
        kind: 'disposition',
        findingId: 'c002-bbbbbbbb#f1',
        action: 'rejected',
        why: 'false positive: the path is test-only',
        head: state.head,
        at: '2026-10-18T00:00:00.000Z',
      },
    });
    expect(effects.openLedger('feature/x').load().records.at(-1)?.kind).toBe('disposition');
  });

  test('an unknown finding id fails and writes nothing', async () => {
    await seed(repo, finding);
    const effects = repoEffects(repo);
    const before = effects.openLedger('feature/x').load();
    const result = await makeDevDisposition(effects)({
      repoRoot: repo.root,
      findingId: 'c009-zzzzzzzz#f1',
      action: 'fixed',
      why: 'done',
    });
    expect(result.status).toBe('failed');
    expect(effects.openLedger('feature/x').load()).toEqual(before);
  });

  test.each([
    { repoRoot: '/repo' },
    { repoRoot: '/repo', findingId: 'x', action: 'ignored', why: 'w' },
    { repoRoot: '/repo', findingId: 'x', action: 'fixed', why: '  ' },
    { repoRoot: '/repo', findingId: 'x', action: 'fixed', why: 3 },
  ])('a schema-bypassing input %j fails before any command runs', async (input) => {
    const effects = makeFakeEffects();
    const result = await makeDevDisposition(effects)(input as never);
    expect(result.status).toBe('failed');
    expect(effects.commands).toEqual([]);
  });

  test.each(['refs/tags/not-a-branch', 'refs/heads/'])(
    'refuses non-local or empty branch identity %s before opening a ledger',
    async (ref) => {
      const effects = makeFakeEffects((_command, args) =>
        args.includes('symbolic-ref') ? `${ref}\n` : undefined,
      );
      effects.openLedger = () => {
        throw new Error('must not open a ledger for an invalid branch ref');
      };
      expect(
        await makeDevDisposition(effects)({
          repoRoot: repo.root,
          findingId: 'c001-aaaaaaaa#f1',
          action: 'fixed',
          why: 'done',
        }),
      ).toEqual({
        status: 'needs-human',
        reason: 'dev.disposition: HEAD does not name a local branch ref',
      });
    },
  );

  test('a detached head is needs-human', async () => {
    repo.git('checkout', '-q', '--detach');
    const result = await makeDevDisposition(repoEffects(repo))({
      repoRoot: repo.root,
      findingId: 'c001-aaaaaaaa#f1',
      action: 'fixed',
      why: 'done',
    });
    expect(result.status).toBe('needs-human');
  });
});

describe('dev.ready deferred lineage', () => {
  const failure = {
    source: 'vendor' as const,
    category: 'vendor-unavailable' as const,
    codes: ['con_err'],
  };
  function vendorCycle(
    identity: { head: string; base: string; dirtySha256: string },
    cycleId: string,
  ) {
    return cycleRecord({
      ...identity,
      cycleId,
      reviewer: 'coderabbit',
      completion: { kind: 'blocked', reason: 'structured vendor outage' },
      vendorFailure: failure,
    });
  }
  function pendingDebt(
    identity: { head: string; base: string; dirtySha256: string },
    requestId: string,
  ) {
    return {
      reference: {
        requestId,
        binding: {
          kind: 'deferred-author' as const,
          repo: 'owner/repo',
          producer: 'author',
          head: identity.head,
          target: 'merge-queue' as const,
          targetSelector: 'promoted-main' as const,
        },
      },
      originAttempt: {
        cycleId: 'c001-vendor-origin',
        head: identity.head,
        base: identity.base,
        target: 'merge-queue',
        scope: 'full' as const,
        dirtySha256: 'clean-tree' as const,
        failure,
      },
      deferral: { id: requestId, base: identity.base, dirtySha256: 'clean-tree' as const },
      queue: {
        state: 'awaiting-pr' as const,
        pr: null,
        mergeSha: null,
        itemId: null,
        receiptId: null,
        consumed: false,
        reviewed: false,
        fixed: false as const,
      },
      vendor: 'vendor-blocked-transient' as const,
      vendorCompleted: false as const,
    };
  }
  const queueClient: DeferredQueueClient = {
    enqueue: async () => {
      throw new Error('no enrollment expected');
    },
    bind: async () => {
      throw new Error('no bind expected');
    },
    cancel: async () => {
      throw new Error('no cancel expected');
    },
    status: async () => ({
      state: 'awaiting-pr',
      pr: null,
      mergeSha: null,
      itemId: null,
      receiptId: null,
      consumed: false,
      reviewed: false,
      fixed: false,
    }),
  };

  test('a pending current enrollment alone still continues readiness', async () => {
    const state = await seed(repo, (identity) => [
      vendorCycle(identity, 'c001-vendor-origin'),
      cycleRecord({ ...identity, cycleId: 'c002-agent', reviewer: 'agent:reviewer' }),
    ]);
    const effects = repoEffects(repo);
    effects.openLedger(state.branch).save({
      version: 2,
      branch: state.branch,
      records: [
        ...effects.openLedger(state.branch).load().records,
        { kind: 'vendor-debt', debt: pendingDebt(state, 'current'), at: effects.nowIso() },
      ],
    });
    const result = await readReadinessWithGaps(
      effects,
      'dev.ready',
      'merge-queue',
      undefined,
      queueClient,
    );
    expect(result.ok).toBe(true);
  });

  test('an unsettled authorized predecessor blocks readiness and the gap is never clean', async () => {
    const state = await seed(repo, (identity) => [
      vendorCycle(identity, 'c001-vendor-origin'),
      cycleRecord({ ...identity, cycleId: 'c002-agent', reviewer: 'agent:reviewer' }),
    ]);
    const effects = repoEffects(repo);
    const ancestor = pendingDebt({ ...state, head: 'a'.repeat(40) }, 'ancestor');
    const current = {
      ...pendingDebt(state, 'current'),
      predecessor: ancestor.reference,
    };
    effects.openLedger(state.branch).save({
      version: 2,
      branch: state.branch,
      records: [
        ...effects.openLedger(state.branch).load().records,
        { kind: 'vendor-debt', debt: ancestor, at: effects.nowIso() },
        { kind: 'vendor-debt', debt: current, at: effects.nowIso() },
      ],
    });
    const result = await readReadinessWithGaps(
      effects,
      'dev.ready',
      'merge-queue',
      undefined,
      queueClient,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected readiness');
    expect(result.reason).toContain('authorized predecessor obligation(s) unsettled');
    expect(result.reason).toContain('ancestor');
  });
});
