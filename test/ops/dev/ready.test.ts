// dev.ready op tests — the assembled record on ready, the named gaps on
// not-ready (exit-3 class), and the identity recomputation (a readiness
// claim is only ever about the state on disk right now).
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { makeDevReady } from '../../../src/ops/dev/ready.js';
import { DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { BASE, BRANCH, HEAD, makeFakeEffects, okResult } from './fakes.js';
import { checkRecord, cycleRecord } from './fakes.js';

function readyEffects(workingDiff = '') {
  const effects = makeFakeEffects((command, args) => {
    if (command === 'git' && args[0] === 'diff' && args[1] === '--binary')
      return okResult(workingDiff);
    return undefined;
  });
  return effects;
}

describe('dev.ready', () => {
  test('ready: the author-tier record with the verbatim caveat and the evidence ids', async () => {
    const effects = readyEffects();
    effects.store.save({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [
        cycleRecord({ dirtySha256: 'clean-tree' }),
        checkRecord({ dirtySha256: 'clean-tree' }),
      ],
    });
    const result = await makeDevReady(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toMatchObject({
      ready: true,
      evidenceClass: 'author',
      branch: BRANCH,
      target: 'merge-queue',
      base: BASE,
      head: HEAD,
      cycleId: 'c001-aaaaaaaa',
      checkId: 'k001-aaaaaaaa',
    });
    expect(result.value.caveat).toContain('Author readiness evidence');
  });

  test('ready: dirty evidence hashes the complete newline-terminated patch', async () => {
    const patch =
      'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-before\n+after\n';
    const dirtySha256 = createHash('sha256').update(patch).digest('hex');
    const effects = readyEffects(patch);
    effects.store.save({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [cycleRecord({ dirtySha256 }), checkRecord({ dirtySha256 })],
    });
    const result = await makeDevReady(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.dirtySha256).toBe(dirtySha256);
  });

  test('not ready: every gap in one needs-human reason', async () => {
    const effects = readyEffects();
    const result = await makeDevReady(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.reason).toContain('NOT READY');
    expect(result.reason).toContain('terminal-review-cycle');
    expect(result.reason).toContain('green-check');
  });

  test('stale identities are rejected: the review ran before the last edit', async () => {
    const effects = readyEffects('changed-since-the-review');
    effects.store.save({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [
        cycleRecord({ dirtySha256: 'the-earlier-dirty' }),
        checkRecord({ dirtySha256: 'clean-tree' }),
      ],
    });
    const result = await makeDevReady(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('stale-review-identity');
      expect(result.reason).toContain('working-tree diff changed');
    }
  });

  test('a cycle recorded for ANOTHER target is stale even at an identical identity', async () => {
    // When main and merge-queue share a merge-base, base/head/dirty alone
    // cannot tell the evidence apart — the recorded target must match the
    // requested one (the check record's rule, mirrored for review cycles).
    const effects = readyEffects();
    effects.store.save({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [
        cycleRecord({ target: 'main', dirtySha256: 'clean-tree' }),
        checkRecord({ target: 'merge-queue', dirtySha256: 'clean-tree' }),
      ],
    });
    const result = await makeDevReady(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('stale-review-identity');
      expect(result.reason).toContain("recorded for target 'main', not 'merge-queue'");
    }
  });

  test('untracked files hold readiness with their names', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'ls-files') return okResult('scratch.ts\n');
      return undefined;
    });
    effects.store.save({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [
        cycleRecord({ dirtySha256: 'clean-tree' }),
        checkRecord({ dirtySha256: 'clean-tree' }),
      ],
    });
    const result = await makeDevReady(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('scratch.ts');
  });

  test('a corrupt ledger is needs-human, never a silent empty pass', async () => {
    const effects = readyEffects();
    const store = effects.openLedger(BRANCH);
    const original = store.load.bind(store);
    store.load = () => {
      original();
      throw new Error('schema violation — corrupted');
    };
    const result = await makeDevReady(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('dev-record could not be read');
  });

  test('a detached head is needs-human', async () => {
    const effects = makeFakeEffects(() => undefined, { branch: '' });
    const result = await makeDevReady(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
  });
});
