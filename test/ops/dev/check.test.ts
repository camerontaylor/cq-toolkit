// dev.check op tests — scripted effects, no process ever spawns. Pinned:
// the gate order and pass-through (test:narrow AS-IS — no vitest flags, only
// the sanctioned --range), the knip §1 approximation, the immutable base
// pin, the red-run record persistence, and the ok/failed mapping.
import { describe, expect, test } from 'vitest';
import type { CommandResult } from '../../../src/ops/dev/effects.js';
import { makeDevCheck, rangeFault } from '../../../src/ops/dev/check.js';
import { BASE, BRANCH, failResult, HEAD, makeFakeEffects, okResult } from './fakes.js';

const GREEN_GATE_OUTPUT = 'test:narrow result=passed ok\n';

/** Default-green effects: every gate exits 0. */
function greenEffects(
  overrides: (
    command: string,
    args: readonly string[],
  ) => CommandResult | string | undefined = () => undefined,
) {
  return makeFakeEffects((command, args) => {
    const scripted = overrides(command, args);
    if (scripted !== undefined) return scripted;
    if (command === 'pnpm') return GREEN_GATE_OUTPUT;
    if (command === 'node') return okResult('', '');
    return undefined;
  });
}

describe('rangeFault', () => {
  test('accepts two distinct non-empty refs; refuses empty halves and identical endpoints', () => {
    expect(rangeFault('abc..def')).toBeNull();
    expect(rangeFault('abc..')).not.toBeNull();
    expect(rangeFault('..def')).not.toBeNull();
    expect(rangeFault('abc')).not.toBeNull();
    expect(rangeFault('abc..abc')).not.toBeNull();
  });
});

describe('dev.check', () => {
  test('a green run returns ok with the report and persists the check record', async () => {
    const effects = greenEffects();
    const op = makeDevCheck(effects);
    const result = await op({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.passed).toBe(true);
    expect(result.value.base).toBe(BASE);
    expect(result.value.head).toBe(HEAD);
    expect(result.value.gates.map((gate) => gate.name)).toEqual([
      'check:static',
      'format:check',
      'test:narrow',
      'knip',
      'denylist-scan',
      'diff-check:committed',
      'diff-check:staged',
      'diff-check:unstaged',
    ]);
    const ledger = effects.openLedger(BRANCH).load();
    expect(ledger.records).toHaveLength(1);
    const record = ledger.records[0];
    expect(record?.kind).toBe('check');
    if (record?.kind === 'check') {
      expect(record.checkId).toBe('k001-aaaaaaaa');
      expect(record.passed).toBe(true);
      expect(record.loadStamp).toEqual({
        uptimeSeconds: 1000,
        load1: 1.5,
        at: '2026-10-17T00:00:00.000Z',
      });
    }
  });

  test('a red gate maps to failed, names the gate, and STILL persists the record', async () => {
    const effects = greenEffects((command, args) => {
      if (command === 'pnpm' && args[0] === 'test:narrow') {
        return failResult(1, '', 'test:narrow refused: 12 files exceed the cap');
      }
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('test:narrow');
    expect(result.error).toContain('k001-aaaaaaaa');
    const ledger = effects.openLedger(BRANCH).load();
    const record = ledger.records[0];
    expect(record?.kind).toBe('check');
    if (record?.kind === 'check') {
      expect(record.passed).toBe(false);
      const narrow = record.gates.find((gate) => gate.name === 'test:narrow');
      expect(narrow?.status).toBe('fail');
      expect(narrow?.exitCode).toBe(1);
      expect(narrow?.evidence).toContain('refused');
    }
  });

  test('the committed diff-check runs against the pinned merge-base, not a branch tip', async () => {
    const effects = greenEffects();
    await makeDevCheck(effects)({ repoRoot: '/repo' });
    const committed = effects.commands.find(
      (entry) => entry.command === 'git' && entry.args[0] === 'diff' && entry.args[1] === '--check',
    );
    expect(committed?.args).toEqual(['diff', '--check', BASE, 'HEAD']);
    const mergeBase = effects.commands.find((entry) => entry.args[0] === 'merge-base');
    expect(mergeBase?.args).toEqual(['merge-base', 'origin/merge-queue', 'HEAD']);
  });

  test('an explicit range scopes the diff leg and passes --range to test:narrow', async () => {
    const effects = greenEffects();
    await makeDevCheck(effects)({ repoRoot: '/repo', range: `${BASE}..HEAD` });
    const committed = effects.commands.find(
      (entry) => entry.command === 'git' && entry.args[0] === 'diff' && entry.args[1] === '--check',
    );
    // Both endpoints are RESOLVED to shas before use (an immutable pair).
    expect(committed?.args).toEqual(['diff', '--check', BASE, HEAD]);
    const narrow = effects.commands.find((entry) => entry.args[0] === 'test:narrow');
    expect(narrow?.args).toEqual(['test:narrow', '--range', `${BASE}..HEAD`]);
    // No merge-base call in range mode.
    expect(effects.commands.find((entry) => entry.args[0] === 'merge-base')).toBeUndefined();
  });

  test('a range whose end is not HEAD is needs-human (the record describes HEAD)', async () => {
    const effects = greenEffects();
    const result = await makeDevCheck(effects)({
      repoRoot: '/repo',
      range: `${BASE}..${BASE}~1`,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('must end at HEAD');
  });

  test('an unresolvable range endpoint is needs-human', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1]?.endsWith('^{commit}')) {
        return { exitCode: 128, stdout: '', stderr: 'unknown revision', timedOut: false };
      }
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo', range: 'nope..also-nope' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('did not resolve');
  });

  test('a malformed range fails at the boundary before any command runs', async () => {
    const effects = greenEffects();
    const result = await makeDevCheck(effects)({ repoRoot: '/repo', range: 'nope' });
    expect(result.status).toBe('failed');
    expect(effects.commands).toHaveLength(0);
  });

  test('a schema-bypassing repoRoot fails at the boundary before any command runs', async () => {
    const effects = greenEffects();
    const result = await makeDevCheck(effects)({ repoRoot: undefined } as unknown as {
      repoRoot: string;
    });
    expect(result.status).toBe('failed');
    expect(effects.commands).toHaveLength(0);
  });

  test('knip auto: skipped when the diff is inert; run when an import line changes', async () => {
    const inert = greenEffects();
    const inertResult = await makeDevCheck(inert)({ repoRoot: '/repo' });
    expect(inertResult.status).toBe('ok');
    if (inertResult.status === 'ok') {
      const knip = inertResult.value.gates.find((gate) => gate.name === 'knip');
      expect(knip?.status).toBe('skipped');
      expect(knip?.evidence).toContain('knip condition not met');
    }
    expect(
      inert.commands.find((entry) => entry.args[0] === 'run' && entry.args[1] === 'knip'),
    ).toBeUndefined();

    const importer = greenEffects((command, args) => {
      if (
        command === 'git' &&
        args[0] === 'diff' &&
        !args.includes('--check') &&
        !args.includes('--name-status')
      ) {
        const second = args[1];
        if (second !== '--binary' && second !== '--cached') {
          return okResult('+import { x } from "./y.js";\n');
        }
      }
      return undefined;
    });
    const importResult = await makeDevCheck(importer)({ repoRoot: '/repo' });
    expect(importResult.status).toBe('ok');
    if (importResult.status === 'ok') {
      expect(importResult.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('pass');
    }
    expect(
      importer.commands.find((entry) => entry.args[0] === 'run' && entry.args[1] === 'knip'),
    ).toBeDefined();
  });

  test('knip force runs even on an inert diff', async () => {
    const effects = greenEffects();
    const result = await makeDevCheck(effects)({ repoRoot: '/repo', knip: 'force' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('pass');
    }
  });

  test('knip auto runs when an untracked non-ignored file exists (a new file is the orphan class)', async () => {
    const scripted = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'ls-files') return okResult('new-file.ts\n');
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    const result = await makeDevCheck(scripted)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('pass');
    }
  });

  test('a detached head is needs-human before any gate runs', async () => {
    const effects = makeFakeEffects(() => undefined, { branch: '' });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    expect(effects.commands.every((entry) => entry.command === 'git')).toBe(true);
  });

  test('a missing origin target ref is needs-human naming the ref', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'merge-base')
        return failResult(128, '', 'unknown revision');
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo', target: 'main' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('origin/main');
  });

  test('check ids mint monotonically across runs on one branch', async () => {
    const effects = greenEffects();
    const op = makeDevCheck(effects);
    const first = await op({ repoRoot: '/repo' });
    const second = await op({ repoRoot: '/repo' });
    expect(first.status === 'ok' && first.value.checkId).toBe('k001-aaaaaaaa');
    expect(second.status === 'ok' && second.value.checkId).toBe('k002-aaaaaaaa');
  });
});
