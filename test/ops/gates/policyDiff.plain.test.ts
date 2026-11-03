import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  HOOK_MS,
  SLOW,
  importCommits,
  kinds,
  repo,
  run,
  setupFixtures,
  teardownFixtures,
  trust,
  verdicts,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('policyDiff: plain changes', SLOW, () => {
  let c: Record<string, string>;
  beforeAll(() => {
    c = importCommits(repo, {
      clean: { files: { 'src/a.ts': 'export const a = 2;\n' } },
      'lint-edit': { files: { 'lint/x.txt': 'rule2\n' } },
      guarded: { files: { 'src/guarded/g.ts': 'export const g = 2;\n' } },
      pkg: { files: { 'package.json': '{ "name": "fixture2" }\n' } },
    });
  }, HOOK_MS);

  test('a clean non-protected change passes in both postures', async () => {
    const subject = c['clean']!;
    const out = await run(subject);
    expect(out.findings).toEqual([]);
    expect(out.rangeBase).toBe(trust);
    expect(out.report[0]).toBe('posture: human (layer env)');
    expect(out.report).toContain(`range: ${trust}..${subject} (trust ${trust})`);
    expect(out.report.at(-1)).toBe('verdict: pass');
    expect(await verdicts(subject)).toEqual({ human: 'pass', 'diff-check': 'pass' });
  });

  test('a protected non-definition change needs a human only under `human`', async () => {
    const out = await run(c['lint-edit']!, 'diff-check');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: 'lint/x.txt', reason: 'changes a protected path' },
    ]);
    expect(await verdicts(c['lint-edit']!)).toEqual({ human: 'needs-human', 'diff-check': 'pass' });
  });

  test('the trust-ref policy list protects project paths', async () => {
    expect(kinds(await run(c['guarded']!))).toEqual(['privileged-path', 'protected-path']);
    expect(await verdicts(c['guarded']!)).toEqual({ human: 'needs-human', 'diff-check': 'pass' });
  });

  test('advisory: a privileged path (the trust-ref project list) still needs a human', async () => {
    const out = await run(c['guarded']!, 'advisory');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: 'src/guarded/g.ts', reason: 'changes a protected path' },
      {
        kind: 'privileged-path',
        path: 'src/guarded/g.ts',
        reason: 'changes a privileged path (policy/protected-paths.json)',
      },
    ]);
    expect(out.verdict).toBe('needs-human');
    expect(out.report[0]).toBe('posture: advisory (layer env)');
    expect(out.report).toContain(
      'advisory: protected-path: src/guarded/g.ts — changes a protected path',
    );
    expect(out.report).toContain(
      'privileged-path: src/guarded/g.ts — changes a privileged path (policy/protected-paths.json)',
    );
    expect(out.report.at(-1)).toBe('verdict: needs-human');
  });

  test('advisory: an ordinary protected path passes with an advisory annotation', async () => {
    const out = await run(c['lint-edit']!, 'advisory');
    expect(out.verdict).toBe('pass');
    expect(out.posture).toBe('advisory');
    expect(out.report).toContain('advisory: protected-path: lint/x.txt — changes a protected path');
    expect(out.report.at(-1)).toBe('verdict: pass');
  });

  test('advisory: a definition-set change passes with advisory annotations', async () => {
    const out = await run(c['pkg']!, 'advisory');
    expect(kinds(out)).toEqual(['definition-changed', 'protected-path']);
    expect(out.verdict).toBe('pass');
    expect(out.report.filter((line) => line.startsWith('advisory: '))).toEqual([
      'advisory: protected-path: package.json — changes a protected path',
      'advisory: definition-changed: package.json — changes a ratchet definition (definition set or tsconfig graph)',
    ]);
  });

  test('a definition-set file (package.json) is needs-human under diff-check', async () => {
    expect(kinds(await run(c['pkg']!))).toEqual(['definition-changed', 'protected-path']);
    expect(await verdicts(c['pkg']!)).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
  });
});
