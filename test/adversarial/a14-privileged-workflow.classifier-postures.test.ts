// §7 A14 a classifier-only edit: pinned across every posture on both sides.
// Split provenance: test/adversarial/a14-privileged-workflow.test.ts was split
// by subject; the shared scratch-repository fixture lives in
// a14-privileged-workflow.helpers.ts.
import { describe, expect, test } from 'vitest';
import {
  heads,
  judge,
  kinds,
  prSubject,
  pushSubject,
  setupFixture,
  SLOW,
} from './a14-privileged-workflow.helpers.js';

setupFixture();

describe('§7 A14 promotion needs the D11 authorization (both postures, both sides)', SLOW, () => {
  test('a classifier edit: needs a human under `human` in BOTH checks, and the promotion side never evaluates a D11 record', async () => {
    const subject = heads['classifier']!;
    // The documented relaxation of the `diff-check` posture: a plain
    // protected-path edit passes. It is the relaxation the owner selects
    // explicitly (`CQ_MERGE_PROTECTED_PATHS` / the per-call opt-in), so both
    // sides and both postures are pinned here rather than one.
    const relaxed = await judge(prSubject(subject), 'diff-check');
    expect(kinds(relaxed)).toEqual(['privileged-path', 'protected-path']);
    expect(relaxed.verdict).toBe('pass');
    expect(relaxed.posture).toBe('diff-check');
    expect((await judge(prSubject(subject), 'human')).verdict).toBe('needs-human');
    // The fixture's project list names the classifier, so it is privileged:
    // the `advisory` posture still needs a human for it.
    expect((await judge(prSubject(subject), 'advisory')).verdict).toBe('needs-human');

    // The promotion gate recomputes the SAME range as a push subject, and a
    // push subject is never evaluated for a PR label record: it is authorized
    // only per admitted PR, through a bound D11 authorization (#322). None is
    // bound here, so under the conservative posture the promoted range needs
    // a human whatever the PR side decided.
    const promoted = await judge(pushSubject(subject), 'human');
    expect(promoted.verdict).toBe('needs-human');
    expect(kinds(promoted)).toEqual(['privileged-path', 'protected-path']);
    expect(promoted.override).toEqual({
      status: 'absent',
      reasons: ['not evaluated: a push subject is authorized per admitted PR (D11 authorization)'],
    });
    expect(promoted.report).toContain(
      '  not evaluated: a push subject is authorized per admitted PR (D11 authorization)',
    );
    expect(promoted.report).toContain(
      'd11: no authorization bound for this push subject — needs-human stands',
    );
  });
});
