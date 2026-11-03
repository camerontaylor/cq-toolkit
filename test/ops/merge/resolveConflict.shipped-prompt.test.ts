// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: the shipped conflict prompt — header group 7.
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  renderConflictPrompt,
  makeResolveConflictOp,
} from '../../../src/ops/merge/resolveConflict.js';
import {
  baseInput,
  completed,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  firstInvocation,
} from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// The shipped prompt (the real asset — the dist-shipping guard's source half)
// ---------------------------------------------------------------------------

describe('the shipped conflict prompt', () => {
  const promptPath = fileURLToPath(
    new URL('../../../src/ops/merge/prompts/conflict.default.md', import.meta.url),
  );
  const vars = {
    pr: '44',
    headBranch: 'feat/topic',
    baseBranch: 'main',
    baseRef: 'origin/main',
    conflictFiles: '- src/a.ts',
    protectedBranch: 'main',
    worktree: '/wt/pr-44',
  };

  test('renders clean: no placeholder left, fetch-before-merge present, contract present', async () => {
    const real = await readFile(promptPath, 'utf8');
    expect(real.trim().length).toBeGreaterThan(0);

    const rendered = renderConflictPrompt(real, vars);
    // Every placeholder the op renders is consumed by the real template.
    expect(rendered).not.toContain('{{');
    // The base is refreshed BEFORE the merge — FETCH_HEAD, not a stale
    // origin/<base> ref.
    expect(rendered).toContain('git fetch origin main');
    expect(rendered).toContain('git merge FETCH_HEAD');
    // The output contract sentence, verbatim.
    expect(rendered).toContain('{"decision":"acted|escalate","summary":"…"}');
    // The protected-branch constraint is push/destination semantics — NOT
    // a merge-source ban (merging the base when it IS the protected
    // branch is required), and the merge source is FETCH_HEAD.
    // (Whitespace-collapsed so markdown line wrapping cannot split the
    // asserted phrases.)
    const collapsed = rendered.replace(/\s+/g, ' ');
    expect(collapsed).toContain('it is NEVER a push destination');
    expect(collapsed).toContain(
      'Using it as a merge SOURCE is correct and required when it is the base',
    );
    expect(collapsed).toContain('git merge FETCH_HEAD');
    // The acted-verification propagation wait (found live in F5's drill:
    // refs/pull/N/head moves ASYNCHRONOUSLY after a push, so an agent that
    // reports acted on an instantaneous verification reads as a false
    // indeterminate). The prompt must carry the bounded poll, the exact
    // ls-remote shape with the RENDERED pr number, and the fail-closed
    // bound-expiry behavior — and it must come AFTER the push step.
    expect(collapsed).toContain('git ls-remote origin refs/pull/44/head');
    expect(collapsed).toContain('poll, bounded (at most ~30 seconds)');
    expect(collapsed).toContain('do NOT report `acted` on an unobservable push');
    const pushAt = collapsed.indexOf('git push origin HEAD:feat/topic');
    const lsRemoteAt = collapsed.indexOf('git ls-remote origin refs/pull/44/head');
    expect(pushAt).toBeGreaterThanOrEqual(0);
    expect(lsRemoteAt).toBeGreaterThan(pushAt);
  });

  test('the DEFAULT loader reads the same file: the default op renders it verbatim', async () => {
    const real = await readFile(promptPath, 'utf8');
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    // NO loadPrompt dep — the op's default loader resolves the asset
    // beside the module and renders it with exactly these vars.
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
    });

    const result = await op({ ...baseInput(), conflictFiles: ['src/a.ts'] });
    expect(result.status).toBe('ok');
    expect(firstInvocation(driver).prompt).toBe(renderConflictPrompt(real, vars));
  });
});
