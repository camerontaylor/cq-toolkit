// ADR-0008 T19 — finding dispositions across the findings-record versions and
// the composition journal (measurement slice M4b2).
//
// What is pinned here:
//   1. FindingsRecordSchema dual-reads schemaVersion 1 and 2. A legacy v1
//      record parses unchanged; a v2 terminal disposition is complete or it
//      is rejected; a v1 record cannot smuggle v2 fields.
//   2. makeReviewAddress emits exactly one `finding-disposition` per durable
//      terminal adjudication, with the ADR-0008 payload, and foldObservations
//      consumes it. Missing acceptance stays unavailable (T20 is deferred),
//      never an empty all-clear.
//   3. A missing legacy value stays unknown: a single evidence string adapts
//      to a one-element array, absent evidence stays null (never []), and a
//      deferred blocker remains open.
//   4. Infrastructure failure stays unresolved: a failing worker emits no
//      disposition and the finding stays open; a failed observation append
//      never rewrites the disposition or the verdict.
// Fake/local inputs only: no provider, no network, no credentials.
import { expect, test } from 'vitest';
import { makeReviewAddress, type ReviewAddressReport } from '../../../src/ops/review/address.js';
import {
  FindingsRecordSchema,
  findingDispositionView,
  openBlocking,
  type Finding,
  type FindingsRecord,
} from '../../../src/ops/review/findings.js';
import { foldObservations } from '../../../src/ops/fix/reportFold.js';
import { readObservations, type ObservationWriter } from '../../../src/kernel/observation.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { fixture, useGitleaksPath } from './address-local.helpers.js';

useGitleaksPath();

const reportOf = (result: Awaited<ReturnType<ReturnType<typeof makeReviewAddress>>>) =>
  ((result as { report?: ReviewAddressReport; value?: ReviewAddressReport }).report ??
    (result as { value?: ReviewAddressReport }).value ??
    null) as ReviewAddressReport | null;

const sha = (character: string) => character.repeat(40);

const v1Finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'seed-a',
  source: 'agent',
  file: 'src/a.ts',
  line: 1,
  severity: 'major',
  text: 'Replace BAD with GOOD',
  status: 'open',
  ...overrides,
});

const v1Record = (record: FindingsRecord): FindingsRecord => ({
  schemaVersion: 1,
  branch: record.branch,
  head: record.head,
  sources: [{ kind: 'agent', status: 'terminal' }],
  findings: [v1Finding()],
});

// ---- T19 round-trip -------------------------------------------------------

test('T19 round-trip', async () => {
  // A v1 record stays valid byte-for-byte through the dual reader.
  const f = await fixture();
  try {
    const legacy = v1Record(f.record);
    expect(FindingsRecordSchema.parse(legacy)).toEqual(legacy);

    const result = await f.op({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const streams = await readObservations(f.journalDir);
    expect(streams).toHaveLength(1);
    const dispositions = streams[0]!.events.flatMap((event) =>
      event.type === 'finding-disposition' ? [event.payload] : [],
    );
    expect(dispositions).toHaveLength(1);
    const payload = dispositions[0]!;
    expect(payload).toMatchObject({
      fingerprint: {
        version: 1,
        checkId: 'agent',
        rule: null,
        path: 'src/a.ts',
        spanContentHash: null,
      },
      status: 'fixed',
      owner: 'review.address',
      reviewTrigger: null,
      observedHead: f.record.head,
      observedAt: payload.observedAt,
      acceptedRisk: null,
      availability: {
        '/fingerprint/spanContentHash': {
          state: 'unavailable',
          reason:
            'address dispatch does not extract the pinned span; a null hash cannot prove equality',
          source: null,
        },
        '/acceptedRisk': {
          state: 'not-collected',
          reason: 'the adjudicator recorded no accepted risk (null is unknown, never none)',
          source: null,
        },
        '/reviewTrigger': {
          state: 'n-a',
          reason: 'the disposition is not deferred, so no re-review trigger applies',
          source: null,
        },
      },
    });
    expect(payload.reason.trim().length).toBeGreaterThan(0);
    expect(payload.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.evidence).toHaveLength(1);
    expect(payload.evidence[0]).toMatch(/^[0-9a-f]{40}$/);

    // A complete v2 terminal disposition round-trips unchanged.
    const v2: FindingsRecord = {
      schemaVersion: 2,
      branch: f.record.branch,
      head: f.record.head,
      sources: [{ kind: 'agent', status: 'terminal' }],
      findings: [
        {
          ...v1Finding({ status: 'fixed', reason: 'addressed' }),
          evidence: [payload.evidence[0]!],
          fingerprint: {
            version: 1,
            checkId: 'agent',
            rule: 'R1',
            path: 'src/a.ts',
            spanContentHash: null,
          },
          owner: 'review.address',
          reviewTrigger: null,
          observedHead: f.record.head,
          observedAt: '2026-11-03T00:00:00.000Z',
          acceptedRisk: null,
        },
      ],
    };
    expect(FindingsRecordSchema.parse(v2)).toEqual(v2);

    // The T36 consumer folds the event into report v2; acceptance stays
    // explicitly unavailable, never an empty all-clear.
    const folded = foldObservations({ streams, producer: 'address' });
    expect(folded.dispositions).toEqual([payload]);
    expect(folded.availability['/dispositions']).toMatchObject({ state: 'known' });
    expect(folded.acceptances).toEqual([]);
    expect(folded.availability['/acceptances']).toMatchObject({ state: 'unavailable' });
  } finally {
    await f.cleanup();
  }
}, 120_000);

// ---- T19 unknown evidence ------------------------------------------------

test('T19 unknown evidence', async () => {
  // A v1 record keeps its one-string evidence unchanged; the v2 wire form is
  // an array, and the wrong form in either version is rejected.
  const legacy = {
    schemaVersion: 1 as const,
    branch: 'feature/x',
    head: sha('a'),
    sources: [{ kind: 'agent' as const, status: 'terminal' as const }],
    findings: [
      v1Finding({
        status: 'rejected',
        reason: 'false positive',
        evidence: '{"path":"src/a.ts","line":1}',
      }),
    ],
  };
  expect(FindingsRecordSchema.parse(legacy)).toEqual(legacy);
  expect(
    FindingsRecordSchema.safeParse({
      ...legacy,
      findings: [{ ...legacy.findings[0]!, evidence: ['{"path":"src/a.ts","line":1}'] }],
    }).success,
  ).toBe(false);

  // Absent evidence stays absent (unknown), never [] and never a zero-fill.
  const withoutEvidenceV1 = {
    ...legacy,
    findings: [v1Finding({ status: 'fixed', reason: 'addressed' })],
  };
  expect(FindingsRecordSchema.parse(withoutEvidenceV1).findings[0]?.evidence).toBeUndefined();

  // ADR-0008 line 214: the ONE dual-read adapter view. A legacy string becomes
  // a one-element array, absent (or whitespace-only) evidence is null, and
  // missing v2 provenance is null WITH availability rather than fabricated.
  expect(
    findingDispositionView(
      v1Finding({
        status: 'rejected',
        reason: 'false positive',
        evidence: '{"path":"src/a.ts","line":1}',
      }),
    ).evidence,
  ).toEqual(['{"path":"src/a.ts","line":1}']);
  expect(
    findingDispositionView(v1Finding({ status: 'fixed', reason: 'addressed', evidence: '  ' }))
      .evidence,
  ).toBeNull();
  const unknownView = findingDispositionView(v1Finding({ status: 'fixed', reason: 'addressed' }));
  expect(unknownView.evidence).toBeNull();
  expect(unknownView.fingerprint).toBeNull();
  expect(unknownView.owner).toBeNull();
  expect(unknownView.observedHead).toBeNull();
  expect(unknownView.observedAt).toBeNull();
  expect(unknownView.acceptedRisk).toBeNull();
  expect(unknownView.reviewTrigger).toBeNull();
  expect(unknownView.availability['/evidence']).toMatchObject({
    state: 'not-collected',
    source: null,
  });
  for (const pointer of ['/fingerprint', '/owner', '/observedHead', '/observedAt'])
    expect(unknownView.availability[pointer]).toMatchObject({ state: 'unavailable', source: null });
  expect(unknownView.availability['/reviewTrigger']?.state).toBe('n-a');
  // A deferred disposition without a trigger is unknown, not "no re-review".
  expect(
    findingDispositionView(v1Finding({ status: 'deferred', reason: 'tracked later' })).availability[
      '/reviewTrigger'
    ]?.state,
  ).toBe('unavailable');

  // A legacy deferred finding has no trigger: unknown, never invented, and
  // the blocker stays open.
  const deferred = v1Finding({
    status: 'deferred',
    reason: 'tracked later',
    severity: 'major',
  });
  expect(deferred.reviewTrigger).toBeUndefined();
  expect(openBlocking({ findings: [deferred] })).toEqual([deferred]);

  // A v2 terminal disposition is complete or rejected: no partial record.
  const complete = {
    schemaVersion: 2 as const,
    branch: 'feature/x',
    head: sha('a'),
    sources: [{ kind: 'agent' as const, status: 'terminal' as const }],
    findings: [
      {
        ...v1Finding({ status: 'deferred', reason: 'tracked later' }),
        evidence: [],
        fingerprint: {
          version: 1 as const,
          checkId: 'agent',
          rule: null,
          path: 'src/a.ts',
          spanContentHash: null,
        },
        owner: 'review.address',
        reviewTrigger: 're-review after the next head',
        observedHead: sha('a'),
        observedAt: '2026-11-03T00:00:00.000Z',
        acceptedRisk: null,
      },
    ],
  };
  expect(FindingsRecordSchema.safeParse(complete).success).toBe(true);
  expect(openBlocking(FindingsRecordSchema.parse(complete)).map((finding) => finding.id)).toEqual([
    'seed-a',
  ]);
  const withoutTrigger = {
    ...complete,
    findings: [{ ...complete.findings[0]!, reviewTrigger: null }],
  };
  expect(FindingsRecordSchema.safeParse(withoutTrigger).success).toBe(false);
  const withoutFingerprint = {
    ...complete,
    findings: complete.findings.map(({ fingerprint: _fingerprint, ...finding }) => finding),
  };
  expect(FindingsRecordSchema.safeParse(withoutFingerprint).success).toBe(false);
  const withoutEvidence = {
    ...complete,
    findings: complete.findings.map(({ evidence: _evidence, ...finding }) => finding),
  };
  expect(FindingsRecordSchema.safeParse(withoutEvidence).success).toBe(false);
  const v1WithV2Field = {
    ...v1Record({
      schemaVersion: 1,
      branch: 'feature/x',
      head: sha('a'),
      sources: [{ kind: 'agent', status: 'terminal' }],
      findings: [],
    }),
    findings: [{ ...v1Finding(), owner: 'review.address' }],
  };
  expect(FindingsRecordSchema.safeParse(v1WithV2Field).success).toBe(false);

  // A live deferral records the trigger on the event and keeps the blocker
  // open in the run report.
  const f = await fixture('defer');
  try {
    const result = await f.op({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
    });
    expect(result.status).toBe('needs-human');
    const report = reportOf(result)!;
    expect(report.findings.map((finding) => finding.status)).toEqual(['deferred']);
    expect(report.openBlocking.map((finding) => finding.status)).toEqual(['deferred']);
    const streams = await readObservations(f.journalDir);
    const payloads = streams[0]!.events.flatMap((event) =>
      event.type === 'finding-disposition' ? [event.payload] : [],
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.status).toBe('deferred');
    expect(payloads[0]!.reviewTrigger).toBe(
      'review.address: retained and re-presented at next re-review',
    );
    expect(payloads[0]!.evidence).toEqual(['src/a.ts:1']);
  } finally {
    await f.cleanup();
  }
}, 120_000);

// ---- T19 failure boundary ------------------------------------------------

test('T19 failure boundary', async () => {
  // An infrastructure-failing worker: the finding stays open (unresolved) and
  // no disposition event claims a deferral.
  const f = await fixture();
  try {
    const failing: DriverFactory = {
      resolve: (request) => {
        const resolved = f.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (invocation) => {
              if (invocation.outputSchema?.name?.startsWith('review.address.'))
                return {
                  stopReason: 'error' as const,
                  error: 'Cannot connect to API: getaddrinfo EAI_AGAIN api.example.invalid',
                  usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
                  denials: [],
                };
              return resolved.driver.run(invocation);
            },
          },
        };
      },
    };
    const result = await makeReviewAddress({ drivers: failing, initialRecord: f.record })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
    });
    expect(result.status).not.toBe('ok');
    const report = reportOf(result)!;
    expect(
      report.findings.map((finding) => finding.status),
      JSON.stringify(report.findings),
    ).toEqual(['open']);
    const streams = await readObservations(f.journalDir);
    const events = streams[0]!.events;
    expect(events.some((event) => event.type === 'finding-disposition')).toBe(false);
    const attempts = events.flatMap((event) =>
      event.type === 'attempt-finished' ? [event.payload] : [],
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => attempt.class === 'infrastructure')).toBe(true);
  } finally {
    await f.cleanup();
  }

  // The same infrastructure failure with an INJECTED disposition authority:
  // the callback adjudicates nothing, so the failure must still stay out of
  // the disposition record. Only `failure` on the fix decides that; an
  // injected dep never promotes an operational failure into a deferral.
  const h = await fixture();
  try {
    let dispositionCalls = 0;
    const failing: DriverFactory = {
      resolve: (request) => {
        const resolved = h.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (invocation) => {
              if (invocation.outputSchema?.name?.startsWith('review.address.'))
                return {
                  stopReason: 'error' as const,
                  error: 'Cannot connect to API: getaddrinfo EAI_AGAIN api.example.invalid',
                  usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
                  denials: [],
                };
              return resolved.driver.run(invocation);
            },
          },
        };
      },
    };
    const result = await makeReviewAddress({
      drivers: failing,
      initialRecord: h.record,
      disposition: async () => {
        dispositionCalls += 1;
        return { status: 'ok' as const, value: undefined };
      },
    })({ repoRoot: h.repo.root, source: 'local', journalDir: h.journalDir });
    expect(result.status).not.toBe('ok');
    expect(dispositionCalls).toBe(0);
    expect(reportOf(result)!.findings.map((finding) => finding.status)).toEqual(['open']);
    const events = (await readObservations(h.journalDir))[0]!.events;
    expect(events.some((event) => event.type === 'finding-disposition')).toBe(false);
  } finally {
    await h.cleanup();
  }

  // A failed observation append never rewrites the durable disposition or the
  // verdict: the fix stays fixed, the surface goes indeterminate.
  const g = await fixture();
  try {
    let dispositionAttempts = 0;
    const failingWriter: ObservationWriter = {
      compositionRunId: 't19-failing-append',
      workId: 't19-failing-append-work',
      persistence: 'unavailable',
      failure: null,
      events: () => [],
      append: async (event) => {
        if (event.type === 'finding-disposition') {
          dispositionAttempts += 1;
          throw new Error('ENOSPC: no space left on device');
        }
      },
      close: async () => {},
    };
    const result = await makeReviewAddress({
      drivers: g.drivers,
      initialRecord: g.record,
      observationWriter: failingWriter,
    })({ repoRoot: g.repo.root, source: 'local', journalDir: g.journalDir });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const report = reportOf(result)!;
    expect(dispositionAttempts).toBe(1);
    expect(report.findings.some((finding) => finding.status === 'deferred')).toBe(false);
    expect(report.openBlocking).toEqual([]);
    expect(report.observation?.status).toBe('indeterminate');
    expect(report.observation?.failure).toContain('ENOSPC');
  } finally {
    await g.cleanup();
  }
}, 180_000);
