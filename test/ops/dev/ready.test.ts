// dev.ready and dev.disposition over a REAL git repo: readiness is computed
// from the CURRENT state (the identity the ledger records must match), and
// dispositions append only for findings a cycle recorded.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { makeDevReady } from '../../../src/ops/dev/ready.js';
import type { DevRecord } from '../../../src/ops/dev/record.js';
import type { WorkState } from '../../../src/ops/dev/internal/workState.js';
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
        checkId: 'k001-aaaaaaaa',
      });
      expect(result.value.caveat).toContain('not verification');
    }
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
