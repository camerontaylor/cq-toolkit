import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { POLICY_LIST_PATH } from '../../../src/ops/gates/policyDiff.js';
import {
  HOOK_MS,
  SLOW,
  COVERAGE_PATH,
  MANIFEST,
  MANIFEST_PATH,
  POLICY,
  baselineText,
  importCommits,
  kinds,
  repo,
  run,
  setupFixtures,
  teardownFixtures,
  verdicts,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('policyDiff: baselines and definitions', SLOW, () => {
  let c: Record<string, string>;
  beforeAll(() => {
    const m = structuredClone(MANIFEST);
    m.definitionSet = m.definitionSet.filter((e) => e !== '(?:^|/)package\\.json$');
    m.ratchets = m.ratchets.filter((r) => r.target !== 'coverage');
    c = importCommits(repo, {
      loosen: { files: { [COVERAGE_PATH]: baselineText(80) } },
      tighten: { files: { [COVERAGE_PATH]: baselineText(95) } },
      manifest: { files: { [MANIFEST_PATH]: `${JSON.stringify(m, null, 2)}\n` } },
      'manifest-bad': { files: { [MANIFEST_PATH]: '{ nope' } },
      'policy-trim': {
        files: {
          [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, protectedPaths: [], requiredChecks: [] }),
        },
      },
      'policy-delete': { files: { [POLICY_LIST_PATH]: null } },
      'policy-trim-jobs': {
        files: { [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, requiredJobs: {} }) },
      },
      'policy-swap-job': {
        files: {
          [POLICY_LIST_PATH]: JSON.stringify({ ...POLICY, requiredJobs: { 'ci.yml': ['other'] } }),
        },
      },
    });
  }, HOOK_MS);

  test('a loosened baseline needs a human in both postures', async () => {
    const out = await run(c['loosen']!, 'diff-check');
    // The canonical value file is judged by the guard, not the definition rule.
    expect(kinds(out)).toEqual(['baseline-loosened', 'protected-path']);
    expect(out.findings.find((f) => f.kind === 'baseline-loosened')?.reason).toMatch(/loosened/);
    expect(await verdicts(c['loosen']!)).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
  });

  test('advisory: a loosened baseline still needs a human; a tightened one passes', async () => {
    const loosen = await run(c['loosen']!, 'advisory');
    expect(loosen.verdict).toBe('needs-human');
    expect(loosen.report.some((line) => line.startsWith('baseline-loosened: '))).toBe(true);
    expect(loosen.report.some((line) => line.startsWith('advisory: protected-path: '))).toBe(true);
    expect((await run(c['tighten']!, 'advisory')).verdict).toBe('pass');
  });

  test('advisory: removed ratchet targets and removed list entries still need a human', async () => {
    const manifest = await run(c['manifest']!, 'advisory');
    expect(manifest.verdict).toBe('needs-human');
    expect(manifest.report).toContain(
      `target-removed: ${MANIFEST_PATH} — removes ratchet coverage/coverage`,
    );
    expect(manifest.report).toContain(
      `entry-removed: ${MANIFEST_PATH} — removes definitionSet entry (?:^|/)package\\.json$`,
    );
    expect(manifest.report).toContain(
      `advisory: definition-changed: ${MANIFEST_PATH} — changes a ratchet definition (definition set or tsconfig graph)`,
    );
    for (const name of ['policy-trim', 'policy-trim-jobs', 'policy-delete']) {
      expect((await run(c[name]!, 'advisory')).verdict, name).toBe('needs-human');
    }
  });

  test('a tightened baseline passes under diff-check', async () => {
    expect(kinds(await run(c['tighten']!))).toEqual(['protected-path']);
    expect(await verdicts(c['tighten']!)).toEqual({ human: 'needs-human', 'diff-check': 'pass' });
  });

  test('a removed definitionSet entry and a removed ratchet target are findings', async () => {
    const out = await run(c['manifest']!, 'diff-check');
    expect(out.findings).toEqual(
      expect.arrayContaining([
        {
          kind: 'entry-removed',
          path: MANIFEST_PATH,
          reason: 'removes definitionSet entry (?:^|/)package\\.json$',
        },
        {
          kind: 'target-removed',
          path: MANIFEST_PATH,
          reason: 'removes ratchet coverage/coverage',
        },
        {
          kind: 'definition-changed',
          path: MANIFEST_PATH,
          reason: 'changes a ratchet definition (definition set or tsconfig graph)',
        },
      ]),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('an unparseable subject manifest is an entry-removed finding', async () => {
    const out = await run(c['manifest-bad']!, 'diff-check');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'entry-removed', path: MANIFEST_PATH }),
    );
    expect(out.findings.find((f) => f.kind === 'entry-removed')?.reason).toMatch(
      /subject manifest unreadable/,
    );
  });

  test('removed policy-list entries and a deleted policy list are findings', async () => {
    expect((await run(c['policy-trim']!, 'diff-check')).findings).toEqual(
      expect.arrayContaining([
        {
          kind: 'entry-removed',
          path: POLICY_LIST_PATH,
          reason: 'removes protectedPaths entry ^src/guarded/',
        },
        {
          kind: 'entry-removed',
          path: POLICY_LIST_PATH,
          reason: 'removes requiredChecks entry static',
        },
      ]),
    );
    expect((await run(c['policy-trim-jobs']!, 'diff-check')).findings).toContainEqual({
      kind: 'entry-removed',
      path: POLICY_LIST_PATH,
      reason: 'removes requiredJobs entry ci.yml:static',
    });
    expect((await run(c['policy-swap-job']!, 'diff-check')).findings).toContainEqual({
      kind: 'entry-removed',
      path: POLICY_LIST_PATH,
      reason: 'removes requiredJobs entry ci.yml:static',
    });
    const out = await run(c['policy-delete']!, 'diff-check');
    expect(out.findings).toContainEqual({
      kind: 'entry-removed',
      path: POLICY_LIST_PATH,
      reason: 'subject policy list unreadable (deleted)',
    });
    expect(out.verdict).toBe('needs-human');
  });
});
