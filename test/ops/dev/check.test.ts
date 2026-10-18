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
    expect(narrow?.args).toEqual(['test:narrow', '--range', `${BASE}..${HEAD}`]);
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

  test('a schema-bypassing non-string range fails at the boundary (never a TypeError)', async () => {
    const effects = greenEffects();
    const result = await makeDevCheck(effects)({
      repoRoot: '/repo',
      range: 1 as unknown as string,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('range must be a string');
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
    // A readable knip.json whose entry set matches nothing the inert diff
    // touches — the only case the condition may SKIP. (An unreadable entry
    // set fails safe toward running — pinned by its own test below.)
    inert.readWorktreeFile = async (path) =>
      path === 'knip.json'
        ? { ok: true as const, text: JSON.stringify({ entry: ['src/index.ts', 'src/cli.ts'] }) }
        : { ok: false as const, reason: 'unreadable' };
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

  test.each(['import {', 'export {'])(
    'an interior multiline %s edit runs Knip',
    async (opening) => {
      const effects = greenEffects((command, args) => {
        if (command === 'git' && args[0] === 'diff' && args.includes('--unified=1000000')) {
          return okResult(
            `diff --git a/src/internal.ts b/src/internal.ts\n@@ -1,7 +1,7 @@\n ${opening}\n   one,\n   two,\n   three,\n-  removed,\n+  added,\n } from './module.js';\n`,
          );
        }
        return undefined;
      });
      const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('pass');
    },
  );

  test('a RENAME row inspects both old and new paths for the knip condition', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-status') {
        return okResult('R100\tpackage.json\tpackage.config.json\n');
      }
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // The rename touches an entrypoint-adjacent path → the whole-project
      // check runs.
      expect(result.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('pass');
    }
  });

  test('test:narrow receives the RESOLVED base sha so the selection is the recorded identity', async () => {
    const effects = greenEffects();
    await makeDevCheck(effects)({ repoRoot: '/repo' });
    const narrow = effects.commands.find((entry) => entry.args[0] === 'test:narrow');
    // The pinned merge-base sha, never the moving origin/<target> ref
    // (test:narrow recomputes the merge-base at invocation time).
    expect(narrow?.args).toEqual(['test:narrow', '--base', BASE]);
    const scoped = greenEffects();
    await makeDevCheck(scoped)({ repoRoot: '/repo', range: `${BASE}..HEAD` });
    const narrowRange = scoped.commands.find((entry) => entry.args[0] === 'test:narrow');
    expect(narrowRange?.args).toEqual(['test:narrow', '--range', `${BASE}..${HEAD}`]);
  });

  test('editing a CONFIGURED ENTRYPOINT (knip.json entry) runs knip without import changes', async () => {
    const scripted = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-status') {
        return okResult('M\tsrc/cli.ts\n');
      }
      if (command === 'git' && args[0] === 'diff' && args.length === 2)
        return okResult('-old line\n');
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    // The fake readWorktreeFile refuses everything → knip entry patterns are
    // unknown → FAIL-SAFE toward running.
    const result = await makeDevCheck(scripted)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('pass');
    }
  });

  test('an entrypoint-only ordinary edit makes entryTouched the SOLE knip reason', async () => {
    // src/cli.ts (a configured entrypoint) edited with ONLY ordinary code:
    // no import/export line, no added files, no config files — the knip
    // run must happen because of the entrypoint match alone (this is the
    // regression for the paths-shadowing bug: the accumulator stayed empty
    // and knip was skipped).
    const scripted = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-status') {
        return okResult('M\tsrc/cli.ts\n');
      }
      if (command === 'git' && args[0] === 'diff' && args.length === 2) {
        return okResult('-const old = 1;\n+const next = compute(2);\n');
      }
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    scripted.readWorktreeFile = async (path) =>
      path === 'knip.json'
        ? { ok: true as const, text: JSON.stringify({ entry: ['src/index.ts', 'src/cli.ts'] }) }
        : { ok: false as const, reason: 'unreadable' };
    const result = await makeDevCheck(scripted)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const knip = result.value.gates.find((gate) => gate.name === 'knip');
      expect(knip?.status).toBe('pass');
    }
  });

  test('unmodelable entry patterns (`**`, braces, backslashes) fail safe: knip runs', async () => {
    // `src/**/index.ts` is NOT modelable (real micromatch also matches
    // `src/index.ts`, which a literal `.*` translation misrepresents);
    // braces and backslashes equally. Any unmodelable pattern runs knip
    // rather than silently missing matches.
    for (const entry of ['src/**/index.ts', 'src/{index,cli}.ts', 'src\\weird.ts']) {
      const scripted = makeFakeEffects((command, args) => {
        if (command === 'git' && args[0] === 'diff' && args[1] === '--name-status') {
          return okResult('M\tsrc/some/ordinary.ts\n');
        }
        if (command === 'git' && args[0] === 'diff' && args.length === 2) {
          return okResult('-old\n');
        }
        if (command === 'pnpm') return GREEN_GATE_OUTPUT;
        if (command === 'node') return okResult();
        return undefined;
      });
      scripted.readWorktreeFile = async (path) =>
        path === 'knip.json'
          ? { ok: true as const, text: JSON.stringify({ entry: [entry] }) }
          : { ok: false as const, reason: 'unreadable' };
      const result = await makeDevCheck(scripted)({ repoRoot: '/repo' });
      expect(result.status, entry).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.gates.find((gate) => gate.name === 'knip')?.status, entry).toBe('pass');
      }
    }
  });

  test('the minimal glob models the shipped pattern SHAPES behaviorally (through the op)', async () => {
    // The shipped knip.json uses exactly these shapes: literals with dots,
    // single-segment `*`. A changed family registry matches
    // `src/ops/*/registry.ts` but NOT deeper paths (single-segment star).
    const scripted = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-status') {
        return okResult('M\tsrc/ops/dev/registry.ts\n');
      }
      if (command === 'git' && args[0] === 'diff' && args.length === 2) {
        return okResult('-old\n');
      }
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    scripted.readWorktreeFile = async (path) =>
      path === 'knip.json'
        ? {
            ok: true as const,
            text: JSON.stringify({ entry: ['src/ops/*/registry.ts', 'scripts/*.mjs'] }),
          }
        : { ok: false as const, reason: 'unreadable' };
    const matched = await makeDevCheck(scripted)({ repoRoot: '/repo' });
    expect(matched.status).toBe('ok');
    if (matched.status === 'ok') {
      expect(matched.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('pass');
    }

    // The same entry set does NOT fire on a non-registry path: the inert
    // skip still applies (single-segment star does not cross segments and
    // unrelated paths never matched).
    const inertPaths = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-status') {
        return okResult('M\tsrc/ops/dev/record.ts\n');
      }
      if (command === 'git' && args[0] === 'diff' && args.length === 2) {
        return okResult('-old\n');
      }
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    inertPaths.readWorktreeFile = async (path) =>
      path === 'knip.json'
        ? { ok: true as const, text: JSON.stringify({ entry: ['src/ops/*/registry.ts'] }) }
        : { ok: false as const, reason: 'unreadable' };
    const inert = await makeDevCheck(inertPaths)({ repoRoot: '/repo' });
    expect(inert.status).toBe('ok');
    if (inert.status === 'ok') {
      expect(inert.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('skipped');
    }
  });

  test('the archive extraction dir comes through the fs seam (no external mkdir)', async () => {
    const effects = greenEffects();
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    expect(
      effects.commands.find((entry) => entry.command === 'mkdir' || entry.args[0] === 'mkdir'),
    ).toBeUndefined();
    expect(effects.commands.find((entry) => entry.command === 'tar')).toBeDefined();
  });

  test('the denylist scan applies the staged/unstaged patch over the archive before scanning', async () => {
    const effects = greenEffects();
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    const commands = effects.commands;
    const diffAt = commands.findIndex(
      (entry) =>
        entry.command === 'git' &&
        entry.args[0] === 'diff' &&
        entry.args.includes('--output') &&
        entry.args[entry.args.length - 1] === 'HEAD',
    );
    const applyAt = commands.findIndex(
      (entry) =>
        entry.command === 'git' &&
        entry.args[0] === '-C' &&
        entry.args[2] === 'apply' &&
        entry.args.includes('--allow-empty'),
    );
    const scanAt = commands.findIndex(
      (entry) => entry.command === 'node' && entry.args[0]?.endsWith('denylist-scan'),
    );
    // The staged/unstaged leg exists, is single-read (`--output` into the
    // scratch dir), and runs AFTER the extraction and BEFORE the scan.
    expect(diffAt).toBeGreaterThanOrEqual(0);
    expect(applyAt).toBeGreaterThan(diffAt);
    expect(scanAt).toBeGreaterThan(applyAt);
    expect(commands[diffAt]?.args).toContain('--binary');
    expect(commands[diffAt]?.args).toContain('--full-index');
  });

  test('an unreadable staged/unstaged diff faults the denylist gate (fail-closed, still recorded)', async () => {
    const effects = greenEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args.includes('--output')) {
        return failResult(128, '', 'fatal: bad object HEAD');
      }
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('failed');
    const ledger = effects.openLedger(BRANCH).load();
    const record = ledger.records[0];
    if (record?.kind === 'check') {
      const row = record.gates.find((entry) => entry.name === 'denylist-scan');
      expect(row?.status).toBe('fail');
      expect(row?.evidence).toContain('staged/unstaged patch could not be read');
    }
  });

  test('a failed patch apply faults the denylist gate (fail-closed, never silently green)', async () => {
    const effects = greenEffects((command, args) => {
      if (command === 'git' && args[0] === '-C' && args[2] === 'apply') {
        return failResult(1, '', 'error: patch failed: src/a.ts:1');
      }
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('failed');
    const ledger = effects.openLedger(BRANCH).load();
    const record = ledger.records[0];
    if (record?.kind === 'check') {
      const row = record.gates.find((entry) => entry.name === 'denylist-scan');
      expect(row?.status).toBe('fail');
      expect(row?.evidence).toContain('could not be applied over the archived tree');
    }
  });

  test('a FAILED ls-files read fails safe toward RUNNING knip (never skipped)', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'ls-files') {
        return { exitCode: 128, stdout: '', stderr: 'fatal', timedOut: false };
      }
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.gates.find((gate) => gate.name === 'knip')?.status).toBe('pass');
    }
  });

  test('a spawn-faulted gate is a FAILED GATE ROW and the op still records (never a crash)', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'pnpm' && args[0] === 'run' && args[1] === 'check:static') {
        throw new Error('spawn pnpm ENOENT');
      }
      if (command === 'pnpm') return GREEN_GATE_OUTPUT;
      if (command === 'node') return okResult();
      return undefined;
    });
    const result = await makeDevCheck(effects)({ repoRoot: '/repo' });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('check:static');
    const ledger = effects.openLedger(BRANCH).load();
    const record = ledger.records[0];
    expect(record?.kind).toBe('check');
    if (record?.kind === 'check') {
      const staticGate = record.gates.find((gate) => gate.name === 'check:static');
      expect(staticGate?.status).toBe('fail');
      expect(staticGate?.evidence).toContain('could not run');
    }
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
