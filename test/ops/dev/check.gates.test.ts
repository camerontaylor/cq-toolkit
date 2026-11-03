// Split provenance: test/ops/dev/check.test.ts was split by subject into
// check.input-rules.test.ts, check.adopter.test.ts, check.portable-scan.test.ts,
// check.selection.test.ts, check.gates.test.ts and check.diff-gates.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDevCheck } from '../../../src/ops/dev/check.js';
import { failResult } from './fakes.js';
import { devEffectsFor, gateNames, pnpmArgs } from './check.helpers.js';
import { makeTestRepo, type CommandHandler, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const effectsFor = (override?: CommandHandler) => devEffectsFor(repo, override);

describe('dev.check', () => {
  test('a green run: ok report, gates in order, the record persisted at the identity', async () => {
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status, JSON.stringify(effects.openLedger('feature/x').load().records[0])).toBe(
      'ok',
    );
    if (result.status !== 'ok') return;
    const base = repo.git('rev-parse', 'origin/main').trim();
    const head = repo.git('rev-parse', 'HEAD').trim();
    expect(result.value).toMatchObject({
      checkId: `k001-${head.slice(0, 8)}`,
      target: 'main',
      base,
      head,
      dirtySha256: 'clean-tree',
      passed: true,
    });
    expect(result.value.gates.map((gate) => gate.name)).toEqual([
      ...gateNames,
      'diff-check:committed',
      'diff-check:staged',
      'diff-check:unstaged',
    ]);
    expect(result.value.gates.every((gate) => gate.status === 'pass')).toBe(true);
    // test:narrow gets the RESOLVED base sha, never a moving ref.
    expect(pnpmArgs(effects)).toContainEqual(['test:narrow', '--base', base]);
    const records = effects.openLedger('feature/x').load().records;
    expect(records.map((r) => r.kind)).toEqual(['check']);
  });

  test('includeIntegration=false (default) keeps the argv bare and the record silent', async () => {
    const effects = effectsFor();
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const base = repo.git('rev-parse', 'origin/main').trim();
    expect(pnpmArgs(effects)).toContainEqual(['test:narrow', '--base', base]);
    // No gated run happened, so no gate row or record field may claim one.
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.includeIntegration).toBeUndefined();
    expect(pnpmArgs(effects).every((args) => !args.includes('--include-integration'))).toBe(true);
  });

  test('a refused test:narrow keeps the refusal reason in the gate row evidence', async () => {
    const effects = effectsFor((command, args) =>
      command === 'pnpm' && args[0] === 'test:narrow'
        ? failResult(
            2,
            '',
            'gated test files cover the change: test/e2e/review/live.test.ts (integration); pass --include-integration to run them (an opt-in gate, not a refusal — re-run with --include-integration)',
          )
        : undefined,
    );
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    const [record] = effects.openLedger('feature/x').load().records;
    const row =
      record?.kind === 'check' ? record.gates.find((g) => g.name === 'test:narrow') : undefined;
    expect(row?.evidence).toContain('pass --include-integration to run them');
  });

  test('a red gate maps to failed, names the gate, and STILL persists the record', async () => {
    const effects = effectsFor((command, args) =>
      command === 'pnpm' && args[1] === 'check:static' ? failResult(1, '', 'TS2322') : undefined,
    );
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('check:static');
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.passed).toBe(false);
  });

  test('a spawn-faulted gate is a failed row; the record still lands', async () => {
    const effects = effectsFor((command, args) => {
      if (command === 'pnpm' && args[1] === 'format:check') throw new Error('pnpm ENOENT');
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    const [record] = effects.openLedger('feature/x').load().records;
    expect(record?.kind === 'check' && record.gates[1]?.evidence).toContain('pnpm ENOENT');
  });

  test('a detached head or a missing target is needs-human before any gate runs', async () => {
    const missing = effectsFor();
    expect((await makeDevCheck(missing)({ repoRoot: repo.root, target: 'nope' })).status).toBe(
      'needs-human',
    );
    expect(pnpmArgs(missing)).toEqual([]);
    repo.git('checkout', '-q', '--detach');
    expect((await makeDevCheck(effectsFor())({ repoRoot: repo.root })).status).toBe('needs-human');
  });

  test('check ids mint monotonically on one branch', async () => {
    const effects = effectsFor();
    await makeDevCheck(effects)({ repoRoot: repo.root });
    const second = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(second.status === 'ok' && second.value.checkId.startsWith('k002-')).toBe(true);
  });
});
