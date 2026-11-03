// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: renderConflictPrompt — header group 4.
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import { renderConflictPrompt } from '../../../src/ops/merge/resolveConflict.js';

// ---------------------------------------------------------------------------
// renderConflictPrompt
// ---------------------------------------------------------------------------

describe('renderConflictPrompt', () => {
  test('replaces every placeholder globally', () => {
    const rendered = renderConflictPrompt(
      [
        'pr {{pr}} pr {{pr}}',
        'head {{headBranch}} base {{baseBranch}} baseref {{baseRef}}',
        'files {{conflictFiles}} protected {{protectedBranch}} wt {{worktree}}',
      ].join('\n'),
      {
        pr: '44',
        headBranch: 'feat/topic',
        baseBranch: 'main',
        baseRef: 'origin/main',
        conflictFiles: '- src/a.ts',
        protectedBranch: 'trunk',
        worktree: '/wt/pr-44',
      },
    );
    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('pr 44 pr 44');
    expect(rendered).toContain('head feat/topic base main baseref origin/main');
    expect(rendered).toContain('protected trunk wt /wt/pr-44');
  });

  test('leaves unknown placeholders alone and ignores unused vars', () => {
    expect(renderConflictPrompt('keep {{unknown}} as-is', { pr: '1', unused: 'x' })).toBe(
      'keep {{unknown}} as-is',
    );
  });

  test('ONE-pass render: values containing placeholders render VERBATIM (no re-substitution)', () => {
    // Second-order injection: a sequential replaceAll would re-render a
    // value that contains a LATER placeholder. The single-pass callback
    // maps each key exactly once, so values land verbatim (inert by
    // construction, not by caller validation).
    const rendered = renderConflictPrompt(
      'push to {{headBranch}}, never to {{protectedBranch}}, inside {{worktree}}',
      {
        headBranch: 'feat/topic',
        protectedBranch: '{{worktree}}',
        worktree: '{{protectedBranch}}/{{worktree}}',
      },
    );
    expect(rendered).toBe(
      'push to feat/topic, never to {{worktree}}, inside {{protectedBranch}}/{{worktree}}',
    );
  });
});
