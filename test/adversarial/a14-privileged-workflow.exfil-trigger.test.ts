// §7 A14 a PR-edited privileged workflow — token exfiltration and trigger
// injection. Split provenance: test/adversarial/a14-privileged-workflow.test.ts
// was split by subject; the shared scratch-repository fixture lives in
// a14-privileged-workflow.helpers.ts.
import { describe, expect, test } from 'vitest';
import {
  bothPostures,
  GATE_PATH,
  heads,
  judge,
  kinds,
  prSubject,
  pushSubject,
  setupFixture,
  SLOW,
} from './a14-privileged-workflow.helpers.js';

setupFixture();

describe('§7 A14 a PR-edited privileged workflow', SLOW, () => {
  test('a gate whose new step reads PROMOTE_TOKEN is needs-human in both postures', async () => {
    const subject = heads['exfil-gate']!;
    const out = await judge(prSubject(subject), 'human');
    expect(kinds(out)).toContain('privileged-job');
    expect(out.findings).toContainEqual(
      expect.objectContaining({ kind: 'privileged-job', path: GATE_PATH }),
    );
    // The edited copy is judged as the privileged definition it still is: no
    // posture widens the door for it.
    expect(await bothPostures(prSubject(subject))).toEqual({
      human: 'needs-human',
      'diff-check': 'needs-human',
    });
    // The promotion-side recompute judges the same hostile copy, and refuses.
    const promoted = await judge(pushSubject(subject), 'diff-check');
    expect(kinds(promoted)).toContain('privileged-job');
    expect(promoted.verdict).toBe('needs-human');
  });

  test('wiring an untrusted trigger into the token-bearing gate fails closed, in both postures', async () => {
    const subject = heads['prt-gate']!;
    const out = await judge(prSubject(subject), 'diff-check');
    expect(kinds(out)).toContain('lint');
    expect(kinds(out)).toContain('privileged-job');
    expect(kinds(out)).toContain('trigger-changed');
    expect(
      out.findings.some(
        (f) => f.kind === 'lint' && /^pull_request_target job decide has secret /.test(f.reason),
      ),
      JSON.stringify(out.findings),
    ).toBe(true);
    // `fail` beats needs-human in both postures: the edited copy never
    // reaches a state where promotion is merely "needs a human".
    expect(await bothPostures(prSubject(subject))).toEqual({
      human: 'fail',
      'diff-check': 'fail',
    });
    expect((await judge(pushSubject(subject), 'diff-check')).verdict).toBe('fail');
  });
});
