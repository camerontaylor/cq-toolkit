import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { symlinkSync, writeFileSync } from 'node:fs';
import {
  bindD11Authorization,
  type D11Authorization,
} from '../../../src/ops/gates/d11Authorization.js';
import {
  LABEL_EVENTS_MAX_BYTES,
  createPolicyDiff,
  type PolicyDiffInput,
  type PolicyDiffOutcome,
} from '../../../src/ops/gates/policyDiff.js';
import {
  HOOK_MS,
  SLOW,
  attestedTrust,
  eventsDir,
  importCommits,
  lateAttestedTrust,
  placeholderTrust,
  repo,
  run,
  setupFixtures,
  teardownFixtures,
  trust,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('policyDiff: the override record', SLOW, () => {
  const PR = 7;
  const OWNER_ID = 1001;
  const EPOCH = '2026-09-20T10:00:00.000Z';
  let subject: string;
  let cqState: string;

  const labelEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    event: 'labeled',
    label: { name: 'cq-override' },
    actor: { login: 'owner', id: OWNER_ID, type: 'User' },
    created_at: '2026-09-20T11:00:00Z',
    performed_via_github_app: null,
    ...over,
  });

  const events = (name: string, body: unknown): string => {
    const path = join(eventsDir, name);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  };

  const withRecord = (
    labelEventsPath: string,
    trustRef = attestedTrust,
  ): Partial<PolicyDiffInput> => ({
    trustRef,
    pr: PR,
    repository: 'o/r',
    ownerId: OWNER_ID,
    labelEventsPath,
    settleRef: 'cq-state',
  });

  beforeAll(() => {
    subject = importCommits(repo, { override: { files: { 'lint/x.txt': 'rule3\n' } } })[
      'override'
    ]!;
    const ledger = {
      version: 1,
      repo: 'o/r',
      prs: {
        [String(PR)]: {
          tuple: { head: subject, base: trust, forcePushEpoch: 0 },
          observations: [{ observedAt: EPOCH, by: 'test' }],
        },
      },
    };
    cqState = importCommits(repo, {
      'cq-state': { files: { '.cq/settle-state.json': JSON.stringify(ledger) } },
    })['cq-state']!;
  }, HOOK_MS);

  test('attested trust + a valid owner label after the epoch is honoured: pass', async () => {
    const out = await run(subject, 'human', withRecord(events('valid.json', [labelEvent()])));
    expect(out.override.status).toBe('honoured');
    expect(out.verdict).toBe('pass');
    expect(out.report.at(-1)).toBe(
      'verdict: pass (needs-human authorized by the D11 override record)',
    );
  });

  test('#338 P1: a label applied before C3 attestedAt is invalid, never honoured', async () => {
    const out = await run(
      subject,
      'human',
      withRecord(events('valid.json', [labelEvent()]), lateAttestedTrust),
    );
    expect(out.override.status).toBe('invalid');
    expect(out.verdict).toBe('needs-human');
    expect(out.report).toContain(
      '  reason: label created_at 2026-09-20T11:00:00Z is not after the C3 attestation attestedAt 2026-09-26T00:00:00Z',
    );
  });

  test('a placeholder attestation file does not arm records (F5): dormant, noted', async () => {
    const out = await run(
      subject,
      'human',
      withRecord(events('valid.json', [labelEvent()]), placeholderTrust),
    );
    expect(out.override.status).toBe('dormant');
    expect(out.verdict).toBe('needs-human');
    expect(
      out.report.some((line) =>
        line.startsWith('attestation: policy/attestations/c3.json present but invalid ('),
      ),
    ).toBe(true);
  });

  test('without the attestation the record is dormant and logged: needs-human', async () => {
    const out = await run(
      subject,
      'human',
      withRecord(events('valid.json', [labelEvent()]), trust),
    );
    expect(out.override.status).toBe('dormant');
    expect(out.verdict).toBe('needs-human');
    expect(out.report).toContain('  verdict: dormant');
    expect(out.report.some((l) => l.startsWith('  dormant: ADR-0004 D-G.4'))).toBe(true);
  });

  test('a label applied through a GitHub App is invalid and logged', async () => {
    const path = events('bot.json', [labelEvent({ performed_via_github_app: { slug: 'bot' } })]);
    const out = await run(subject, 'human', withRecord(path));
    expect(out.override.status).toBe('invalid');
    expect(out.verdict).toBe('needs-human');
    expect(out.report).toContain(
      "  reason: label applied via GitHub App 'bot', not directly by the owner",
    );
  });

  test('a label before the head observation epoch, or with no ledger, is invalid', async () => {
    const early = events('early.json', [labelEvent({ created_at: '2026-09-20T09:00:00Z' })]);
    expect((await run(subject, 'human', withRecord(early))).override.status).toBe('invalid');
    const noLedger = withRecord(events('valid.json', [labelEvent()]));
    delete noLedger.settleRef;
    const out = await run(subject, 'human', noLedger);
    expect(out.override.status).toBe('invalid');
    expect(out.report).toContain('settle ledger: no settle ref (cq-state absent)');
  });

  test('the composition-bound settleStatePath relocates the ledger read; a path with no ledger fails closed', async () => {
    // The ledger's location is bound at composition (selfhost config,
    // migration 1.2): a ledger at the bound path is read and honoured, and
    // the default wire path is unchanged for compositions that omit the
    // option. The path is never op input — dispatch data cannot choose
    // which bytes supply the override epoch.
    importCommits(repo, {
      'cq-state': {
        from: cqState,
        files: {
          'custom/ledger.json': JSON.stringify({
            version: 1,
            repo: 'o/r',
            prs: {
              [String(PR)]: {
                tuple: { head: subject, base: trust, forcePushEpoch: 0 },
                observations: [{ observedAt: EPOCH, by: 'test' }],
              },
            },
          }),
        },
      },
    });
    const runBound = async (path: string): Promise<PolicyDiffOutcome> => {
      const result = await createPolicyDiff(
        { posture: 'human', layer: 'env' },
        { settleStatePath: path },
      )({
        repo,
        trustRef: attestedTrust,
        subject,
        subjectKind: 'pr',
        base: 'merge-queue',
        pr: PR,
        repository: 'o/r',
        ownerId: OWNER_ID,
        labelEventsPath: events('relocated.json', [labelEvent()]),
        settleRef: 'cq-state',
      });
      if (result.status !== 'ok') throw new Error(JSON.stringify(result));
      return result.value;
    };
    const out = await runBound('custom/ledger.json');
    expect(out.override.status).toBe('honoured');
    expect(out.verdict).toBe('pass');

    const outAbsent = await runBound('custom/missing.json');
    expect(outAbsent.override.status).toBe('invalid');
    expect(outAbsent.report).toContain('settle ledger: custom/missing.json absent at cq-state');
  });

  test('an unreadable events file is an invalid record, never `failed`', async () => {
    const link = join(eventsDir, 'link.json');
    symlinkSync(events('target.json', [labelEvent()]), link);
    const cases: string[] = [
      link,
      events('not-array.json', { event: 'labeled' }),
      events('not-json.json', '{'),
      events('huge.json', ' '.repeat(LABEL_EVENTS_MAX_BYTES + 1)),
      join(eventsDir, 'missing.json'),
    ];
    for (const path of cases) {
      const out = await run(subject, 'human', withRecord(path));
      expect(out.override.status).toBe('invalid');
      expect(out.override.reasons[0]).toMatch(/^label events unreadable: /);
      expect(out.verdict).toBe('needs-human');
    }
  });

  test('a push subject is never evaluated for an override', async () => {
    const out = await run(subject, 'human', {
      ...withRecord(events('valid.json', [labelEvent()])),
      subjectKind: 'push',
      base: 'main',
    });
    const skipped =
      'not evaluated: a push subject is authorized per admitted PR (D11 authorization)';
    expect(out.override).toEqual({ status: 'absent', reasons: [skipped] });
    expect(out.verdict).toBe('needs-human');
    expect(out.report).toContain(`  ${skipped}`);
    expect(out.report).toContain(
      'd11: no authorization bound for this push subject — needs-human stands',
    );
    expect(out.d11).toBeUndefined();
  });

  const C3 = JSON.stringify({
    schemaVersion: 1,
    attests: 'C3',
    attestedAt: '2026-09-20T00:00:00Z',
  });
  const authorization = (
    over: { paths?: string[]; attested?: boolean; events?: unknown[] } = {},
  ): D11Authorization =>
    bindD11Authorization({
      ownerId: OWNER_ID,
      attestation: over.attested === false ? { state: 'absent' } : { state: 'present', text: C3 },
      prs: [
        {
          pr: PR,
          merge: 'c'.repeat(40),
          head: subject,
          paths: over.paths ?? ['lint/x.txt'],
          events: over.events ?? [labelEvent()],
          headObservedAt: EPOCH,
        },
      ],
    });
  const push = (auth: D11Authorization): Partial<PolicyDiffInput> => ({
    subjectKind: 'push',
    base: 'main',
    authorization: auth,
  });

  test('push: a bound, attested record of the PR that changed the path → pass', async () => {
    const out = await run(subject, 'human', push(authorization()));
    expect(out.verdict).toBe('pass');
    expect(out.d11).toMatchObject({ authorized: true, unauthorized: [] });
    expect(out.report).toContain('d11: lint/x.txt authorized by PR #7');
    expect(out.report.at(-1)).toBe(
      "verdict: pass (needs-human authorized by every changing PR's D11 record)",
    );
  });

  test('push: a dormant record (no C3 attestation) stays needs-human, naming the path', async () => {
    const out = await run(subject, 'human', push(authorization({ attested: false })));
    expect(out.verdict).toBe('needs-human');
    expect(out.d11?.unauthorized).toEqual([
      {
        path: 'lint/x.txt',
        why: `PR #7 (merge ${'c'.repeat(40)}) changes it and its D11 record is dormant`,
      },
    ]);
    expect(out.report.at(-1)).toBe('verdict: needs-human');
  });

  test('push: an App-applied or pre-epoch label is invalid → needs-human', async () => {
    for (const event of [
      labelEvent({ performed_via_github_app: { slug: 'bot' } }),
      labelEvent({ created_at: '2026-09-20T09:00:00Z' }),
    ]) {
      const out = await run(subject, 'human', push(authorization({ events: [event] })));
      expect(out.verdict).toBe('needs-human');
      expect(out.d11?.unauthorized[0]?.why).toMatch(/D11 record is invalid$/);
    }
  });

  test('push, advisory: D11 authorizes only the paths that still need a human', async () => {
    const mixed = importCommits(repo, {
      'override-mixed': {
        files: { 'lint/x.txt': 'rule4\n', 'src/guarded/g.ts': 'export const g = 4;\n' },
      },
    })['override-mixed']!;
    const auth = (paths: string[]): D11Authorization =>
      bindD11Authorization({
        ownerId: OWNER_ID,
        attestation: { state: 'present', text: C3 },
        prs: [
          {
            pr: PR,
            merge: 'c'.repeat(40),
            head: mixed,
            paths,
            events: [labelEvent()],
            headObservedAt: EPOCH,
          },
        ],
      });
    // The privileged path alone is authorized: `advisory` passes, `human` does not.
    const advisory = await run(mixed, 'advisory', push(auth(['src/guarded/g.ts'])));
    expect(advisory.verdict).toBe('pass');
    expect(advisory.d11).toMatchObject({ authorized: true, unauthorized: [] });
    expect(advisory.report).toContain('d11: src/guarded/g.ts authorized by PR #7');
    expect(advisory.report.some((line) => line.startsWith('d11: lint/x.txt'))).toBe(false);
    const human = await run(mixed, 'human', push(auth(['src/guarded/g.ts'])));
    expect(human.verdict).toBe('needs-human');
    // Nothing privileged in the range: an advisory push passes with no D11 record at all.
    const plain = await run(subject, 'advisory', { subjectKind: 'push', base: 'main' });
    expect(plain.verdict).toBe('pass');
    expect(plain.d11).toBeUndefined();
  });

  test('push: a path no admitted PR contributed (outside the closure) → needs-human', async () => {
    const out = await run(subject, 'human', push(authorization({ paths: ['src/other.ts'] })));
    expect(out.verdict).toBe('needs-human');
    expect(out.report).toContain(
      'd11: lint/x.txt unauthorized — not contributed by any admitted PR in the closure',
    );
  });
});
