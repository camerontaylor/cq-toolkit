// dev.disposition op tests — the mandatory reason, the recorded verb set,
// and the finding-exists check (a typo fails naming the ledger, never
// writes an orphan disposition).
import { describe, expect, test } from 'vitest';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { BRANCH, HEAD, makeFakeEffects, okResult } from './fakes.js';
import { cycleRecord } from './fakes.js';

function effectsWithCycle() {
  const effects = makeFakeEffects();
  effects.store.save({
    version: DEV_LEDGER_VERSION,
    branch: BRANCH,
    records: [cycleRecord({ findings: [{ id: 'c001-aaaaaaaa#f1', severity: 'major' }] })],
  });
  return effects;
}

describe('dev.disposition', () => {
  test('records a disposition and returns it as the ok value', async () => {
    const effects = effectsWithCycle();
    const result = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c001-aaaaaaaa#f1',
      action: 'rejected',
      why: 'false positive: the narrowing is enforced two lines above',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toMatchObject({
      kind: 'disposition',
      findingId: 'c001-aaaaaaaa#f1',
      action: 'rejected',
      head: HEAD,
    });
    const ledger = effects.openLedger(BRANCH).load();
    expect(ledger.records).toHaveLength(2);
    expect(ledger.records[1]?.kind).toBe('disposition');
  });

  test('an empty (whitespace) reason fails before any command runs', async () => {
    const effects = effectsWithCycle();
    const result = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c001-aaaaaaaa#f1',
      action: 'rejected',
      why: '   ',
    });
    expect(result.status).toBe('failed');
    expect(effects.commands).toHaveLength(0);
  });

  test('an unknown finding id fails naming the ledger, writing nothing', async () => {
    const effects = effectsWithCycle();
    const result = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c999-zzzzzzzz#f1',
      action: 'fixed',
      why: 'typo',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('unknown finding');
    expect(effects.openLedger(BRANCH).load().records).toHaveLength(1);
  });

  test('a detached head is needs-human', async () => {
    const effects = makeFakeEffects(() => undefined, { branch: '' });
    const result = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c001-aaaaaaaa#f1',
      action: 'fixed',
      why: 'x',
    });
    expect(result.status).toBe('needs-human');
  });

  test('git read failures surface as needs-human, not throws', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { exitCode: null, stdout: '', stderr: 'fatal', timedOut: false };
      }
      return okResult('');
    });
    const result = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c001-aaaaaaaa#f1',
      action: 'fixed',
      why: 'x',
    });
    expect(result.status).toBe('needs-human');
  });
});
