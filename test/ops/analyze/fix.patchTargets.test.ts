// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and a shared fixture module; this is the
// patch-target parsing subject. Siblings: fix.selection.test.ts,
// fix.previewApply.test.ts, fix.applyPreconditions.test.ts,
// fix.ruleOverFiles.test.ts, fix.agentProposal.test.ts,
// fix.agentProposalRefusal.test.ts, fix.schema.test.ts and fix.helpers.ts.
import { describe, expect, test } from 'vitest';
import { patchTargets } from '../../../src/ops/analyze/fix.js';
import { PATCH } from './fix.helpers.js';

describe('patchTargets', () => {
  test('refuses malformed hunk headers', () => {
    expect(patchTargets('--- a/x.ts\n+++ b/x.ts\n@@ malformed\n-a\n+b')).toEqual({
      ok: false,
      reason: 'malformed hunk header',
    });
  });
  test('parses git and plain unified headers', () => {
    expect(patchTargets(PATCH)).toEqual({ ok: true, targets: ['src/index.ts'] });
    expect(patchTargets('--- a/x.ts\t2020\n+++ b/x.ts\t2020\n@@ -1 +1 @@\n-a\n+b\n')).toEqual({
      ok: true,
      targets: ['x.ts'],
    });
    expect(patchTargets('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+a\n')).toEqual({
      ok: true,
      targets: ['new.ts'],
    });
  });

  test('hunk body lines that look like headers are content, not paths', () => {
    const patch = [
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '-- comment',
      '+++ x',
      ' select 1;',
      '',
    ]
      .join('\n')
      .replace('-- comment', '--- comment');
    expect(patchTargets(patch)).toEqual({ ok: true, targets: ['q.sql'] });
    const escaping = patch.replace('--- comment', '--- ../notes');
    expect(patchTargets(escaping)).toEqual({ ok: true, targets: ['q.sql'] });
  });

  test.each([
    ['--- a/../x\n+++ b/../x\n', 'escapes'],
    ['--- a/.git/config\n+++ b/.git/config\n', 'escapes'],
    ['--- a/.cq/analysis/r.json\n+++ b/.cq/analysis/r.json\n', 'report area'],
    ['diff --git a/x b/x\nGIT binary patch\n', 'binary'],
    ['diff --git a/l b/l\nnew file mode 120000\n', 'symlink'],
    [
      'diff --git a/l b/l\nindex abc123..def456 120000\n--- a/l\n+++ b/l\n@@ -1 +1 @@\n-old\n+new\n',
      'symlink',
    ],
    [
      'diff --git a/sub b/sub\nindex abc123..def456 160000\n--- a/sub\n+++ b/sub\n@@ -1 +1 @@\n-Subproject commit abc123\n+Subproject commit def456\n',
      'submodule',
    ],
    ['--- "a/sp ace"\n+++ "b/sp ace"\n', 'quoted'],
    ['hello\n', 'names no files'],
  ])('refuses %j', (patch, reason) => {
    const result = patchTargets(patch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});
