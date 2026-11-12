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
  scanClean,
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
    // THE NO-PUSH PUBLICATION CONTRACT (issue #1193 — the worker no longer
    // pushes; the op scans and publishes): the prompt must withhold the
    // push entirely, name the single allowed network use (the base
    // fetch), and redefine `acted` as a LOCAL commit with NOTHING pushed.
    expect(collapsed).toContain('You have NO push step');
    expect(collapsed).toContain(
      'the caller runs a secret scan and pushes the resolved branch itself',
    );
    expect(collapsed).toContain('Do not run `git push` (any form)');
    expect(collapsed).toContain('do not run `git ls-remote`');
    expect(collapsed).toContain('STOP THERE. Do not push.');
    expect(collapsed).toContain(
      'the merge commit was created on the worktree branch and NOTHING was pushed',
    );
    // And the OLD push instructions are gone outright — no push refspec,
    // no propagation poll.
    expect(collapsed).not.toContain('git push origin HEAD:feat/topic');
    expect(collapsed).not.toContain('git ls-remote origin refs/pull/44/head');
    expect(collapsed).not.toContain('poll, bounded');
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
      scan: scanClean,
    });

    const result = await op({ ...baseInput(), conflictFiles: ['src/a.ts'] });
    expect(result.status).toBe('ok');
    expect(firstInvocation(driver).prompt).toBe(renderConflictPrompt(real, vars));
  });
});
