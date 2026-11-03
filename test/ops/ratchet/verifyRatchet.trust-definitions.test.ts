// Split provenance: test/ops/ratchet/verifyRatchet.test.ts was split into
// verifyRatchet.{clean-pr,measurement-artifact,trust-definitions,guard-range,faults,subject-baseline,d11-authorization,advisory-posture}.test.ts
// plus verifyRatchet.helpers.ts (shared fixtures and the original header).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { baselineRelPath } from '../../../src/ops/ratchet/format.js';
import {
  HOOK_MS,
  MANIFEST,
  SLOW,
  artifact,
  baseline,
  commit,
  git,
  prBranch,
  setupFixtures,
  teardownFixtures,
  verify,
  write,
} from './verifyRatchet.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('verifyRatchet: definitions come from the trust ref (A5, D-C)', SLOW, () => {
  test('a head that renames the coverage target and adds a looser baseline changes nothing', async () => {
    const head = prBranch('pr-a5', 'merge-queue', () => {
      const manifest = structuredClone(MANIFEST);
      const cov = manifest.ratchets[1];
      if (cov === undefined) throw new Error('fixture');
      cov.target = 'coverage2';
      write('baselines/ratchets.json', `${JSON.stringify(manifest, null, 2)}\n`);
      git(['rm', '-q', baselineRelPath('coverage', 'coverage')]);
      baseline('coverage2', 'coverage', 'higher-is-better', 50, 'pct');
    });
    const low = artifact('low.json', { schemaVersion: 1, metrics: { coverage: 60 } });
    const v = await verify(head, { measurementPath: low });
    expect(v.verdict).toBe('needs-human');
    expect(v.definitionChanges).toContain('baselines/ratchets.json');
    // The canonical baseline is gone from the head (F4): the rename is
    // caught before any comparison, and the verdict still fails.
    expect(v.results.find((r) => r.metric === 'coverage')).toMatchObject({
      verdict: 'fail',
      value: null,
    });
    expect(v.reasons.join('\n')).toMatch(/is missing at the subject/);
    // And the guard names the unreplaced delete.
    expect(v.guard.ok).toBe(false);
    expect(v.reasons.join('\n')).toMatch(/deleted without a replacement/);
  });

  test('a head that adds a second, looser coverage target is still judged on the trust target', async () => {
    // The A5 intent with the canonical baseline left in place: the trust
    // ref's target and its 90 are what is enumerated and judged.
    const head = prBranch('pr-a5-extra', 'merge-queue', () => {
      baseline('coverage2', 'coverage', 'higher-is-better', 50, 'pct');
    });
    const low = artifact('low2.json', { schemaVersion: 1, metrics: { coverage: 60 } });
    const v = await verify(head, { measurementPath: low });
    expect(v.results.find((r) => r.metric === 'coverage')).toMatchObject({
      target: 'coverage',
      baseline: 90,
      value: 60,
      verdict: 'fail',
    });
  });

  test.each([
    ['.gitattributes', '.gitattributes', 'src/a.ts export-ignore\n'],
    ['a nested .gitattributes', 'src/.gitattributes', '*.ts -diff\n'],
    ['a workflow', '.github/workflows/cq-measure.yml', 'name: x\n'],
    ['the test config', 'vitest.config.ts', 'export default {};\n'],
    ['a tsconfig extends target (graph, not the static set)', 'config/base.json', '{}\n'],
    ['an extensionless extends target added by the head', 'config/base', '{}\n'],
  ])('editing %s is needs-human (D11 records are dormant)', async (_label, rel, content) => {
    const head = prBranch(`pr-def-${rel.replace(/[^a-z]/g, '')}`, 'merge-queue', () =>
      write(rel, content),
    );
    const v = await verify(head);
    expect(v.verdict).toBe('needs-human');
    expect(v.definitionChanges).toEqual([rel]);
    expect(v.reasons[0]).toMatch(/^needs-human \(D11\)/);
  });

  test('a queued sibling definition change on the base is not charged to an unrelated PR', async () => {
    git(['checkout', '-q', 'merge-queue']);
    write('vitest.config.ts', 'export default { queued: true };\n');
    commit('queued definition change');
    git(['checkout', '-q', 'main']);
    const head = prBranch('pr-sibling', 'merge-queue', () =>
      write('src/f.ts', 'export const f = 6;\n'),
    );
    const v = await verify(head);
    expect(v.definitionChanges).toEqual([]);
    expect(v.verdict).toBe('pass');
    // The merge-queue tip itself, judged as a push subject against main, IS charged.
    const tip = git(['rev-parse', 'merge-queue']);
    const pushV = await verify(tip, { subjectKind: 'push', base: 'main' });
    expect(pushV.verdict).toBe('needs-human');
    expect(pushV.definitionChanges).toContain('vitest.config.ts');
  });
});
