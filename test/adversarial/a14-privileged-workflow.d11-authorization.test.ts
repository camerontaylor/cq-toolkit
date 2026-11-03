// §7 A14 the D11 override record: an attested owner label promotes the hostile
// head, and without the attestation the same record is dormant.
// Split provenance: the old test/adversarial/a14-privileged-workflow.test.ts
// was split by subject; the shared scratch-repository fixture lives in
// a14-privileged-workflow.helpers.ts.
import { describe, expect, test } from 'vitest';
import {
  attestedRef,
  events,
  heads,
  judge,
  labelEvent,
  OWNER_ID,
  PR,
  prSubject,
  setupFixture,
  SLOW,
} from './a14-privileged-workflow.helpers.js';

setupFixture();

describe('§7 A14 promotion needs the D11 authorization (both postures, both sides)', SLOW, () => {
  test('positive control: an explicit D11 record promotes the same hostile head', async () => {
    const subject = heads['exfil-gate']!;
    const out = await judge(
      prSubject(subject, {
        trustRef: attestedRef(),
        pr: PR,
        repository: 'o/r',
        ownerId: OWNER_ID,
        labelEventsPath: events('valid.json', [labelEvent()]),
        settleRef: 'cq-state',
      }),
      'human',
    );
    expect(out.override.status).toBe('honoured');
    expect(out.verdict).toBe('pass');
    expect(out.report.at(-1)).toBe(
      'verdict: pass (needs-human authorized by the D11 override record)',
    );
  });

  test('without the attestation the same record is dormant, and the head still needs a human', async () => {
    const subject = heads['exfil-gate']!;
    const out = await judge(
      prSubject(subject, {
        pr: PR,
        repository: 'o/r',
        ownerId: OWNER_ID,
        labelEventsPath: events('dormant.json', [labelEvent()]),
        settleRef: 'cq-state',
      }),
      'human',
    );
    expect(out.override.status).toBe('dormant');
    expect(out.verdict).toBe('needs-human');
  });
});
