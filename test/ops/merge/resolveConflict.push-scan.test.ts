// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,push-scan,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: the publication gate (issue #1193) — header group 6.
// Fixtures and the full group header: ./resolveConflict.helpers.ts
//
// THE INVARIANT UNDER TEST (contract item 17, fail-closed): no upload
// path may publish unscanned content. The worker no longer pushes at all
// — the op does, and only after: a located resolution commit, a readable
// baseline..resolved patch, and a CLEAN denylist scan. A scan hit or a
// scanner fault refuses (needs-human, nothing pushed); an unscannable
// change refuses (failed); the publication push's own exit code is the
// verdict.
import { describe, expect, test } from 'vitest';
import { mergeWorktreeBranchFor } from '../../../src/adapters/forge-github/mergeEffects.js';
import type { Driver } from '../../../src/driver/types.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import {
  ZERO_USAGE,
  completed,
  baseInput,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  failedError,
  fakeLoadPrompt,
  recordingScan,
  scanClean,
  scanFault,
  scanHits,
} from './resolveConflict.helpers.js';

// A scanner that logs its run INTO the effects call log, so the shared
// sequence pins the ordering: the scan is IN the log before the push is.
const scanIntoLog =
  (inner: DiffSecretScanner, log: string[]): DiffSecretScanner =>
  async (components) => {
    log.push(`scan:${String(components.length)}`);
    return inner(components);
  };

// The acted op under a stubbed gate: driver scripts the worker's decision,
// `scan` is the denylist seam, effects carries the fake git truth.
const actedOp = (driver: Driver, effects: FakeMergeEffects, scan: DiffSecretScanner) =>
  makeResolveConflictOp({
    effects,
    drivers: factoryOf(driver),
    loadPrompt: fakeLoadPrompt,
    scan,
  });

describe('the publication gate (issue #1193): scan BEFORE any push, fail closed', () => {
  test('CLEAN SCAN → the op pushes the resolved branch and reports ok', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'resolved clean' }));
    const op = actedOp(driver, effects, scanClean);

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'resolved clean', usage: ZERO_USAGE },
    });
    // The exact gate sequence, in order: baseline fetch/validate on the
    // pull ref, then the worktree-branch read, the patch read, and only
    // then the publication push (remove-in-finally still closes).
    expect(effects.calls).toEqual([
      'fetch:refs/pull/44/head',
      `validate:refs/pull/44/head`,
      'prepare:44@refs/pull/44/head',
      `validate:${mergeWorktreeBranchFor(44)}`,
      `parents:${String(effects.resolutionSha)}`,
      `diff:${String(effects.baselineSha)}..${String(effects.resolutionSha)}`,
      `message:${String(effects.resolutionSha)}`,
      `push:${String(effects.resolutionSha)}:refs/heads/feat/topic@/wt/pr-44`,
      'remove:/wt/pr-44',
    ]);
  });

  test('a PREFIXED headBranch (refs/heads/feature) publishes the bare branch — never refs/heads/refs/heads/…', async () => {
    // Review P2 (PR #1628): the input schema admits the refs/heads/<name>
    // spelling, and a prefix-blind refspec would publish a DIFFERENT
    // branch while returning ok. Exactly one leading refs/heads/ is
    // stripped before the destination is constructed.
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op({ ...baseInput(), headBranch: 'refs/heads/feature' });
    expect(result.status).toBe('ok');
    expect(effects.calls).toContain(
      `push:${String(effects.resolutionSha)}:refs/heads/feature@/wt/pr-44`,
    );
    expect(effects.calls.some((call) => call.includes('refs/heads/refs/heads/'))).toBe(false);
  });

  test('NO PUSH BEFORE A SUCCESSFUL SCAN: the scan runs before the push, every time', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanIntoLog(scanClean, effects.calls));

    await op(baseInput());
    const scanAt = effects.calls.findIndex((call) => call.startsWith('scan:'));
    const pushAt = effects.calls.findIndex((call) => call.startsWith('push:'));
    expect(scanAt).toBeGreaterThanOrEqual(0);
    expect(pushAt).toBeGreaterThan(scanAt);
  });

  test('SCAN HIT → needs-human naming the rule and file, NEVER the matched content; NOTHING pushed', async () => {
    const effects = new FakeMergeEffects();
    // The scripted patch carries a denylisted-looking line; the hit stub
    // flags it. The refusal must quote the RULE and the FILE — never the
    // secret itself.
    effects.diffPatchText = [
      'diff --git a/src/leak.ts b/src/leak.ts',
      '--- a/src/leak.ts',
      '+++ b/src/leak.ts',
      '@@ -1 +1 @@',
      '+const token = "ghp_HIDDEN_SECRET_VALUE";',
    ].join('\n');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanHits('project-token-rule'));

    const result = await op(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('project-token-rule');
      expect(result.reason).toContain('src/leak.ts');
      expect(result.reason).toContain('NOT pushed');
      expect(result.reason).not.toContain('ghp_HIDDEN_SECRET_VALUE');
    }
    // Fail closed: no push exists anywhere in the log.
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  test('SCANNER FAULT → needs-human (the human arranges the scanner); NOTHING pushed', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanFault('scanner exploded'));

    const result = await op(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('scanner exploded');
      expect(result.reason).toContain('NOTHING was pushed');
    }
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  test('the scan sees the patch ADDED LINES per path AND the commit message (the scan-input contract)', async () => {
    const effects = new FakeMergeEffects();
    effects.diffPatchText = [
      'diff --git a/src/keep.ts b/src/keep.ts',
      '--- a/src/keep.ts',
      '+++ b/src/keep.ts',
      '@@ -2,3 +2,3 @@',
      ' context survives outside the gate',
      '-const removed = "old line leaves the forge";',
      '+const added = "new line enters the forge";',
      'diff --git a/docs/new.md b/docs/new.md',
      '--- /dev/null',
      '+++ b/docs/new.md',
      '@@ -0,0 +1,1 @@',
      '+brand new file content',
    ].join('\n');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const { scanner, lastComponents } = recordingScan(scanClean);
    const op = actedOp(driver, effects, scanner);

    await op(baseInput());
    const seen = lastComponents();
    expect(seen).toEqual([
      {
        component: 'src/keep.ts',
        text: 'const added = "new line enters the forge";',
        path: 'src/keep.ts',
      },
      { component: 'docs/new.md', text: 'brand new file content', path: 'docs/new.md' },
      {
        // The resolution commit's MESSAGE rides the same scan verdict
        // (review P2 ntJt) — one component, no path (path-scoped rules
        // never fire on a message).
        component: `commit message ${String(effects.resolutionSha).slice(0, 12)}`,
        text: 'fix: resolve conflict with main\n',
        path: '',
      },
    ]);
  });

  test('GATE RUNG 1 — an unresolvable PRE-dispatch baseline: the change cannot be scoped → needs-human, NOTHING pushed', async () => {
    const effects = new FakeMergeEffects();
    effects.baselineSha = null;
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('cannot be scoped');
      expect(result.reason).toContain('NOTHING was pushed');
    }
    // The gate stopped before the patch read, let alone the push.
    expect(effects.calls.some((call) => call.startsWith('diff:'))).toBe(false);
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  test('GATE RUNG 2 — no resolution commit on the worktree branch: needs-human, NOTHING pushed', async () => {
    const effects = new FakeMergeEffects();
    effects.resolutionSha = null;
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'committed' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('no resolution commit is on');
      expect(result.reason).toContain('NOTHING was pushed');
    }
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  test('GATE RUNG 2 — the branch still names the baseline (the commit claim is false): indeterminate, NOTHING pushed', async () => {
    const effects = new FakeMergeEffects();
    effects.resolutionSha = effects.baselineSha; // the agent never committed
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'committed' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('no resolution commit was created');
      expect(result.detail).toContain('NOTHING was pushed');
    }
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  test('GATE RUNG 2 — a throwing branch validate is totality → failed', async () => {
    const effects = new FakeMergeEffects();
    effects.gateValidateThrows = new Error('branch validate lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('branch validate lost');
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  test('GATE RUNG 3 — a nonzero patch read is an UNSCANNABLE change → failed (never a partial scan), NOTHING pushed', async () => {
    const effects = new FakeMergeEffects();
    effects.diffCode = 128;
    effects.diffStderr = 'fatal: bad object';
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('unreadable');
    expect(failedError(result)).toContain('unscannable change');
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  test('GATE RUNG 3 — a throwing patch read is totality → failed, NOTHING pushed', async () => {
    const effects = new FakeMergeEffects();
    effects.diffThrows = new Error('diff read lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('diff read lost');
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });

  test('GATE RUNG 5 — a REFUSED publication push (nonzero exit) → failed with the forge stderr', async () => {
    const effects = new FakeMergeEffects();
    effects.pushCode = 1;
    effects.pushStderr = '! [rejected] non-fast-forward';
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('publication push');
    expect(failedError(result)).toContain('non-fast-forward');
    expect(failedError(result)).toContain('committed locally but unpublished');
  });

  test('GATE RUNG 5 — a throwing publication push is totality → failed', async () => {
    const effects = new FakeMergeEffects();
    effects.pushThrows = new Error('push spawn lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = actedOp(driver, effects, scanClean);

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('push spawn lost');
  });

  test('an ESCALATION short-circuits BEFORE the gate: no scan, no diff, no push', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(
      completed({ decision: 'escalate', summary: 'semantics cannot be reconciled' }),
    );
    const op = actedOp(driver, effects, scanIntoLog(scanFault('never runs'), effects.calls));

    await expect(op(baseInput())).resolves.toEqual({
      status: 'needs-human',
      reason: 'semantics cannot be reconciled',
    });
    expect(effects.calls.some((call) => call.startsWith('scan:'))).toBe(false);
    expect(effects.calls.some((call) => call.startsWith('diff:'))).toBe(false);
    expect(effects.calls.some((call) => call.startsWith('push:'))).toBe(false);
  });
});
