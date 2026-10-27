import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import {
  bindDeferredPublication,
  advanceDeferredVendorDebt,
  type VendorOutageOrigin,
  hasPersistedVendorOutageOrigin,
  deferVendorReview,
  matchesDeferredVendorDebt,
  hasDeferredReviewSources,
  allowsDeferredVendorComposition,
  refreshDeferredVendorDebt,
  classifyDeferredVendorFailure,
  type VendorFailure,
} from '../../../src/ops/dev/internal/deferredReview.js';
import type {
  DeferredQueueClient,
  QueueReference,
  QueueStatus,
  DeferredAuthorBinding,
} from '../../../src/ops/review/internal/queueProtocol.js';
import type { FindingsRecord } from '../../../src/ops/review/findings.js';
import type { DevCycleRecord } from '../../../src/ops/dev/record.js';

const reference: QueueReference & { binding: DeferredAuthorBinding } = {
  requestId: 'cycle-1',
  binding: {
    kind: 'deferred-author',
    repo: 'owner/repo',
    producer: 'author',
    head: 'a'.repeat(40),
    target: 'merge-queue',
    targetSelector: 'promoted-main',
  },
};
const status: QueueStatus = {
  state: 'awaiting-pr',
  pr: null,
  mergeSha: null,
  itemId: null,
  receiptId: null,
  consumed: false,
  reviewed: false,
  fixed: false,
};
const deferral = { id: 'cycle-1', base: 'b'.repeat(40), dirtySha256: 'clean-tree' as const };
function origin(failure: VendorFailure = 'unavailable'): VendorOutageOrigin {
  return {
    cycleId: 'cycle-1',
    head: 'a'.repeat(40),
    base: deferral.base,
    target: 'merge-queue',
    scope: 'full',
    dirtySha256: 'clean-tree',
    failure: {
      source: 'vendor',
      category:
        failure === 'login-required'
          ? 'vendor-needs-action'
          : failure === 'rate-limited'
            ? 'vendor-rate-limited'
            : 'vendor-unavailable',
      codes: [
        failure === 'login-required'
          ? 'auth'
          : failure === 'rate-limited'
            ? 'rate_limited'
            : 'con_err',
      ],
    },
  };
}
const identity = {
  deferralId: deferral.id,
  base: deferral.base,
  dirtySha256: deferral.dirtySha256,
  repo: 'owner/repo',
  producer: 'author',
  head: 'a'.repeat(40),
  target: 'merge-queue',
};

function fake() {
  const saved = new Map<string, QueueStatus>();
  let calls = 0;
  const client: DeferredQueueClient = {
    async enqueue(ref) {
      calls++;
      saved.set(ref.requestId, saved.get(ref.requestId) ?? structuredClone(status));
      return saved.get(ref.requestId)!;
    },
    async bind(input) {
      const row = saved.get(input.requestId);
      if (!row || row.state === 'cancelled') throw new Error('missing or cancelled durable intent');
      row.pr = input.pr;
      row.state = 'awaiting-merge';
      return row;
    },
    async cancel(ref) {
      const row = saved.get(ref.requestId)!;
      row.state = 'cancelled';
      return row;
    },
    async status(ref) {
      return saved.get(ref.requestId)!;
    },
  };
  return { client, saved, calls: () => calls };
}

describe('deferred vendor policy', () => {
  test('origin must match one genuine retained blocked vendor cycle and structured failure', () => {
    const proof = origin();
    const cycle: DevCycleRecord & { vendorFailure: VendorOutageOrigin['failure'] } = {
      kind: 'cycle',
      cycleId: proof.cycleId,
      reviewer: 'coderabbit',
      scope: proof.scope,
      target: proof.target,
      base: proof.base,
      head: proof.head,
      dirtySha256: proof.dirtySha256,
      completion: { kind: 'blocked', reason: 'operational vendor failure' },
      vendorFailure: proof.failure,
      findings: [{ id: 'known', severity: 'major', excerpt: 'keep this finding' }],
      logPath: '/outside/review.log',
      untracked: [],
      at: '2026-10-28T00:00:00Z',
    };
    expect(hasPersistedVendorOutageOrigin(proof, [cycle])).toBe(true);
    expect(hasPersistedVendorOutageOrigin(proof, [])).toBe(false);
    expect(hasPersistedVendorOutageOrigin(proof, [cycle, cycle])).toBe(false);
    for (const changed of [
      { ...cycle, reviewer: 'agent:reviewer' },
      { ...cycle, completion: { kind: 'terminal' as const } },
      { ...cycle, head: 'd'.repeat(40) },
      { ...cycle, base: 'd'.repeat(40) },
      { ...cycle, target: 'main' },
      { ...cycle, scope: 'uncommitted' as const },
      { ...cycle, dirtySha256: 'changed' },
      { ...cycle, vendorFailure: origin('login-required').failure },
      { ...cycle, vendorFailure: { ...proof.failure, codes: ['scan'] } },
    ])
      expect(hasPersistedVendorOutageOrigin(proof, [changed])).toBe(false);
    const { vendorFailure: omitted, ...legacy } = cycle;
    expect(omitted).toEqual(proof.failure);
    expect(hasPersistedVendorOutageOrigin(proof, [legacy])).toBe(false);
    expect(cycle.findings[0]!.id).toBe('known');
  });
  test('classifies only wholly recognized structured vendor failures', () => {
    const input = {
      origin: 'vendor-cli' as const,
      codes: ['con_err'],
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      budgetStopped: false,
      malformed: false,
      actionRequired: false,
      skipped: false,
    };
    expect(classifyDeferredVendorFailure(input)?.category).toBe('vendor-unavailable');
    expect(classifyDeferredVendorFailure({ ...input, codes: ['rate_limited'] })?.category).toBe(
      'vendor-rate-limited',
    );
    expect(classifyDeferredVendorFailure({ ...input, codes: ['auth', 'con_err'] })?.category).toBe(
      'vendor-needs-action',
    );
    for (const codes of [
      [],
      ['unknown'],
      ['con_err', 'scan'],
      ['please login'],
      ['auth', 'identity'],
    ]) {
      expect(classifyDeferredVendorFailure({ ...input, codes })).toBeUndefined();
    }
    for (const flag of [
      'timedOut',
      'cancelled',
      'budgetStopped',
      'malformed',
      'actionRequired',
      'skipped',
    ] as const) {
      expect(classifyDeferredVendorFailure({ ...input, [flag]: true })).toBeUndefined();
    }
    expect(classifyDeferredVendorFailure({ ...input, exitCode: null })).toBeUndefined();
    expect(
      classifyDeferredVendorFailure({ ...input, origin: 'queue', codes: ['auth'] }),
    ).toBeUndefined();
  });

  test('queue auth/read exceptions retain original debt without granting fresh continuation', async () => {
    const f = fake();
    const debt = await deferVendorReview(
      f.client,
      reference,
      'login-required',
      deferral,
      origin('login-required'),
    );
    const before = structuredClone(debt);
    f.client.status = async () => {
      throw new Error('queue authentication failed');
    };
    await expect(refreshDeferredVendorDebt(f.client, debt)).rejects.toThrow(
      'queue authentication failed',
    );
    expect(debt).toEqual(before);
    expect(f.saved.size).toBe(1);
    f.client.enqueue = async () => {
      throw new Error('queue authentication failed');
    };
    await expect(
      deferVendorReview(f.client, reference, 'login-required', deferral, origin('login-required')),
    ).rejects.toThrow('queue authentication failed');
  });
  test('typed vendor blockage after enrollment remains debt; queue and unknown failures block', async () => {
    const f = fake();
    for (const category of [
      'vendor-unavailable',
      'vendor-rate-limited',
      'vendor-needs-action',
    ] as const) {
      f.saved.set(reference.requestId, {
        ...status,
        state: 'blocked',
        enqueued: true,
        reason: { source: 'vendor', category, code: 'vendor-error' },
      });
      const debt = await deferVendorReview(
        f.client,
        reference,
        'unavailable',
        deferral,
        origin('unavailable'),
      );
      expect(matchesDeferredVendorDebt(debt, identity)).toBe(true);
      for (const source of ['queue', 'vendor'] as const) {
        for (const category of ['identity', 'scan', 'unknown', 'persistence'] as const) {
          f.saved.set(reference.requestId, {
            ...status,
            reason: { source, category, code: 'blocked' },
          });
          expect(
            matchesDeferredVendorDebt(await refreshDeferredVendorDebt(f.client, debt), identity),
          ).toBe(false);
        }
      }
      f.saved.set(reference.requestId, { ...debt.queue, enqueued: false });
      await expect(
        deferVendorReview(f.client, reference, 'unavailable', deferral, origin('unavailable')),
      ).rejects.toThrow();
    }
  });

  test('substantive fixes retain coverage and findings, while final readiness remains blocked', async () => {
    const f = fake();
    const debt = await deferVendorReview(
      f.client,
      reference,
      'unavailable',
      deferral,
      origin('unavailable'),
    );
    const record: FindingsRecord = {
      schemaVersion: 1,
      branch: 'feature',
      head: identity.head,
      reviewed: { base: identity.base, scope: 'full' },
      sources: [
        {
          kind: 'coderabbit',
          status: 'blocked',
          cycleId: origin().cycleId,
          reason: 'vendor unavailable',
        },
        {
          kind: 'agent',
          status: 'terminal',
          coverage: {
            version: 2,
            head: identity.head,
            base: identity.base,
            scope: 'full',
            mode: 'session',
            modeReason: 'one delivered component',
            pieces: [
              {
                component: 'tracked:a',
                path: 'a',
                sha256: createHash('sha256').update('x').digest('hex'),
                chars: 1,
                bytes: 1,
                state: 'completed',
                sessionId: 's1',
              },
            ],
            sessions: [
              {
                id: 's1',
                status: 'complete',
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                deliveries: [
                  {
                    component: 'tracked:a',
                    start: 0,
                    end: 1,
                    sha256: createHash('sha256').update('x').digest('hex'),
                  },
                ],
                requests: [{ serializedChars: 1, decodedChars: 1 }],
              },
            ],
          },
        },
      ],
      findings: [
        {
          id: 'known',
          source: 'coderabbit',
          severity: 'major',
          text: 'fix required',
          status: 'open',
        },
      ],
    };
    const before = structuredClone(record);
    expect(hasDeferredReviewSources(record, ['agent', 'coderabbit'], debt, identity)).toBe(true);
    expect(
      allowsDeferredVendorComposition(record, ['agent', 'coderabbit'], debt, identity, ['major']),
    ).toBe(false);
    expect(record).toEqual(before);
    record.findings[0]!.status = 'fixed';
    expect(
      allowsDeferredVendorComposition(record, ['agent', 'coderabbit'], debt, identity, ['major']),
    ).toBe(true);
    for (const changed of [
      { ...record, reviewed: { base: identity.base, scope: 'uncommitted' as const } },
      { ...record, head: 'c'.repeat(40) },
      {
        ...record,
        sources: record.sources.map((s) =>
          s.kind === 'agent' ? { ...s, status: 'blocked' as const } : s,
        ),
      },
      {
        ...record,
        sources: record.sources.map((s) =>
          s.kind === 'agent' ? { kind: s.kind, status: s.status } : s,
        ),
      },
      {
        ...record,
        sources: record.sources.map((s) =>
          s.kind === 'coderabbit' ? { ...s, cycleId: 'old-attempt' } : s,
        ),
      },
    ])
      expect(hasDeferredReviewSources(changed, ['agent', 'coderabbit'], debt, identity)).toBe(
        false,
      );
    expect(
      hasDeferredReviewSources(record, ['agent', 'coderabbit', 'pr-threads'], debt, identity),
    ).toBe(false);
    const nextReference: QueueReference = {
      ...reference,
      requestId: 'deferral-2',
      binding: { ...reference.binding, head: 'c'.repeat(40) },
    };
    const nextDeferral = { ...deferral, id: nextReference.requestId };
    const persisted: unknown[] = [];
    const successor = await advanceDeferredVendorDebt(
      f.client,
      debt,
      nextReference,
      nextDeferral,
      async (row) => {
        persisted.push(structuredClone(row));
      },
    );
    const nextIdentity = { ...identity, deferralId: nextDeferral.id, head: 'c'.repeat(40) };
    expect(hasDeferredReviewSources(record, ['agent', 'coderabbit'], successor, nextIdentity)).toBe(
      false,
    );
    const fresh = structuredClone(record);
    fresh.head = nextIdentity.head;
    fresh.sources = fresh.sources.filter((source) => source.kind === 'agent');
    fresh.sources[0]!.coverage!.head = nextIdentity.head;
    expect(hasDeferredReviewSources(fresh, ['agent', 'coderabbit'], successor, nextIdentity)).toBe(
      true,
    );
    expect(
      hasDeferredReviewSources(
        fresh,
        ['agent', 'coderabbit', 'pr-threads'],
        successor,
        nextIdentity,
      ),
    ).toBe(false);
    fresh.findings[0]!.status = 'open';
    expect(
      allowsDeferredVendorComposition(fresh, ['agent', 'coderabbit'], successor, nextIdentity, [
        'major',
      ]),
    ).toBe(false);
    expect(successor.originAttempt).toEqual(debt.originAttempt);
    expect(successor.predecessor).toEqual(reference);
    expect(persisted).toEqual([successor]);
    expect(successor.vendorCompleted).toBe(false);
  });

  test('successor persists before continuation and replays uncertain writes without changing bound obligations', async () => {
    const f = fake();
    const initial = await deferVendorReview(f.client, reference, 'unavailable', deferral, origin());
    const previous = await bindDeferredPublication(f.client, initial, 12);
    const before = structuredClone(previous);
    const next: QueueReference = {
      ...reference,
      requestId: 'deferral-2',
      binding: { ...reference.binding, head: 'c'.repeat(40) },
    };
    const pin = { ...deferral, id: next.requestId };
    let writes = 0;
    const fail = async () => {
      writes++;
      throw new Error('local debt persistence failed');
    };
    await expect(advanceDeferredVendorDebt(f.client, previous, next, pin, fail)).rejects.toThrow(
      'local debt persistence failed',
    );
    expect(writes).toBe(1);
    expect(previous).toEqual(before);
    expect(f.saved.size).toBe(2);
    let persisted: unknown;
    const successor = await advanceDeferredVendorDebt(
      f.client,
      previous,
      next,
      pin,
      async (row) => {
        persisted = structuredClone(row);
      },
    );
    expect(persisted).toEqual(successor);
    expect(previous).toEqual(before);
    expect(f.saved.get(reference.requestId)?.pr).toBe(12);
    expect(f.saved.get(reference.requestId)?.state).toBe('awaiting-merge');
    expect(f.saved.size).toBe(2);
    for (const binding of [
      { ...next.binding, repo: 'other/repo' },
      { ...next.binding, producer: 'other' },
      { ...next.binding, target: 'main' },
      { ...next.binding, targetSelector: 'merge-queue' as const },
      reference.binding,
    ]) {
      await expect(
        advanceDeferredVendorDebt(f.client, previous, { ...next, binding }, pin, async () => {
          throw new Error('must not persist invalid successor');
        }),
      ).rejects.toThrow('lineage');
    }
    expect(f.saved.size).toBe(2);
    f.client.enqueue = async () => {
      throw new Error('queue unavailable');
    };
    await expect(advanceDeferredVendorDebt(f.client, previous, next, pin, fail)).rejects.toThrow(
      'queue unavailable',
    );
    expect(writes).toBe(1);
    expect(previous).toEqual(before);
  });
  test('persists pre-PR debt and replays publication with the original immutable identity', async () => {
    const f = fake();
    const debt = await deferVendorReview(
      f.client,
      reference,
      'unavailable',
      deferral,
      origin('unavailable'),
    );
    expect(debt.vendorCompleted).toBe(false);
    expect(debt.vendor).toBe('vendor-blocked-transient');
    expect(matchesDeferredVendorDebt(debt, identity)).toBe(true);
    const replay = await deferVendorReview(
      f.client,
      reference,
      'unavailable',
      deferral,
      origin('unavailable'),
    );
    expect(f.saved.size).toBe(1);
    const bound = await bindDeferredPublication(f.client, replay, 12);
    expect((await bindDeferredPublication(f.client, bound, 12)).queue.pr).toBe(12);
    expect(bound.reference).toEqual(reference);
    expect(bound.vendorCompleted).toBe(false);
    for (const key of [
      'repo',
      'producer',
      'head',
      'target',
      'base',
      'deferralId',
      'dirtySha256',
    ] as const) {
      expect(matchesDeferredVendorDebt(bound, { ...identity, [key]: 'changed' })).toBe(false);
    }
  });

  test('login is visible needs-action debt; other failure classes never enqueue', async () => {
    const f = fake();
    expect(
      (
        await deferVendorReview(
          f.client,
          reference,
          'login-required',
          deferral,
          origin('login-required'),
        )
      ).vendor,
    ).toBe('vendor-needs-action');
    for (const failure of [
      'scan',
      'tamper',
      'identity',
      'substantive',
      'unknown',
    ] satisfies VendorFailure[]) {
      await expect(
        deferVendorReview(f.client, reference, failure, deferral, origin(failure)),
      ).rejects.toThrow('remains blocking');
    }
    expect(f.calls()).toBe(1);
  });

  test('queue authorization/persistence failure never grants continuation, even after a lost reply', async () => {
    const f = fake();
    const enqueue = f.client.enqueue;
    f.client.enqueue = async (ref) => {
      await enqueue(ref);
      throw new Error('lost persistence reply');
    };
    await expect(
      deferVendorReview(f.client, reference, 'rate-limited', deferral, origin('rate-limited')),
    ).rejects.toThrow('lost persistence reply');
    f.client.enqueue = enqueue;
    expect(
      (
        await deferVendorReview(
          f.client,
          reference,
          'rate-limited',
          deferral,
          origin('rate-limited'),
        )
      ).reference.requestId,
    ).toBe('cycle-1');
    expect(f.saved.size).toBe(1);
    for (const state of [
      'blocked',
      'unsupported',
      'cancelled',
      'terminal-with-findings',
    ] as const) {
      f.saved.set(reference.requestId, { ...status, state });
      await expect(
        deferVendorReview(f.client, reference, 'unavailable', deferral, origin('unavailable')),
      ).rejects.toThrow('does not establish');
    }
  });

  test('cancelled debt cannot be used for readiness', async () => {
    const f = fake();
    const debt = await deferVendorReview(
      f.client,
      reference,
      'unavailable',
      deferral,
      origin('unavailable'),
    );
    debt.queue = await f.client.cancel(reference);
    expect(matchesDeferredVendorDebt(debt, identity)).toBe(false);
    await expect(bindDeferredPublication(f.client, debt, 12)).rejects.toThrow('cancelled');
  });

  test('head-only enrollment cannot authorize a dirty or uncommitted review', async () => {
    const f = fake();
    await expect(
      deferVendorReview(
        f.client,
        reference,
        'unavailable',
        {
          ...deferral,
          dirtySha256: 'changed' as 'clean-tree',
        },
        origin(),
      ),
    ).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });
});
