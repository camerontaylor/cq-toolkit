// §7 A14 a PR-edited privileged workflow — a benign edit still needs a human,
// for the token-bearing gate and for the privileged ratchet. Split provenance:
// test/adversarial/a14-privileged-workflow.test.ts was split by subject; the
// shared scratch-repository fixture lives in
// a14-privileged-workflow.helpers.ts.
import { describe, expect, test } from 'vitest';
import {
  bothPostures,
  heads,
  judge,
  kinds,
  prSubject,
  setupFixture,
  SLOW,
} from './a14-privileged-workflow.helpers.js';

setupFixture();

describe('§7 A14 a PR-edited privileged workflow', SLOW, () => {
  test('a benign edit to a token-bearing workflow is still needs-human in both postures', async () => {
    const subject = heads['gate-edit']!;
    expect(kinds(await judge(prSubject(subject), 'diff-check'))).toContain('privileged-job');
    expect(await bothPostures(prSubject(subject))).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
  });

  test('an edit to the privileged ratchet workflow is needs-human in both postures', async () => {
    const subject = heads['ratchet-edit']!;
    expect(kinds(await judge(prSubject(subject), 'diff-check'))).toContain('privileged-job');
    expect(await bothPostures(prSubject(subject))).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
  });
});
