// record.ts unit tests — readiness's use of the persisted no-fresh reuse
// resolution: which tails resolve, which anchors are accepted, and the
// intervening-blocker refusals. The selector itself lives in
// record.reuse-selector.test.ts.
// Split provenance: test/ops/dev/record.test.ts was split into record.format.test.ts,
// record.finding-schema.test.ts, record.branch-path.test.ts, record.store.test.ts,
// record.readiness.test.ts, record.reuse-selector.test.ts and
// record.readiness-reuse.test.ts.
import { describe, expect, test } from 'vitest';
import { assembleReadiness, DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { BASE, BRANCH, HEAD, checkRecord, cycleRecord, dispositionRecord } from './fakes.js';
import { assemble, NO_FRESH_REASON, reuseRecord } from './record.helpers.js';

describe('assembleReadiness reuse resolution (no-fresh tail)', () => {
  const blockedTail = () =>
    cycleRecord({
      cycleId: 'c002-aaaaaaaa',
      completion: { kind: 'blocked', reason: NO_FRESH_REASON },
    });

  test.each([NO_FRESH_REASON, `skipped:no-fresh: ${NO_FRESH_REASON}`])(
    'a blocked tail with a resolution record settles ready: %s',
    (reason) => {
      const result = assemble([
        cycleRecord(),
        cycleRecord({ cycleId: 'c002-aaaaaaaa', completion: { kind: 'blocked', reason } }),
        reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
        checkRecord(),
      ]);
      expect(result.ready).toBe(true);
      if (result.ready) expect(result.record.reuse).toBe('r001-aaaaaaaa');
    },
  );

  test('the same tail WITHOUT the resolution record stays a latest-review-blocked gap', () => {
    const result = assemble([cycleRecord(), blockedTail(), checkRecord()]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'latest-review-blocked');
      expect(gap?.detail).toContain('c002-aaaaaaaa');
      expect(gap?.detail).toContain('AFFIRMATIVE no-fresh');
    }
  });

  test('a persisted resolution cannot paper over an intervening genuine blocker', () => {
    // The linkage the old selector wrote (or a forged one): reuse names the
    // terminal A and the no-fresh tail C while genuine blocker B sits between
    // them. Readiness must refuse exactly as the selector now does — no
    // review ever resolved B, so C's notice cannot settle it.
    for (const reason of [
      'reviewer stream carried an error event',
      'reviewer requested action (usage-limit confirmation class) — the cycle never reviewed',
    ]) {
      const result = assemble([
        cycleRecord(),
        cycleRecord({ cycleId: 'c002-aaaaaaaa', completion: { kind: 'blocked', reason } }),
        cycleRecord({
          cycleId: 'c003-aaaaaaaa',
          completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        }),
        reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c003-aaaaaaaa' }),
        checkRecord(),
      ]);
      expect(result.ready, reason).toBe(false);
      if (!result.ready) {
        const gap = result.gaps.find((entry) => entry.field === 'latest-review-blocked');
        expect(gap?.detail, reason).toContain('c003-aaaaaaaa');
      }
    }
  });

  test('a structured vendor failure in between refuses the persisted resolution too', () => {
    const result = assemble([
      cycleRecord(),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        completion: { kind: 'blocked', reason: 'reviewer rate limit exceeded' },
        vendorFailure: {
          source: 'vendor',
          category: 'vendor-rate-limited',
          codes: ['rate_limited'],
        },
      }),
      cycleRecord({
        cycleId: 'c003-aaaaaaaa',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      }),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c003-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready)
      expect(result.gaps.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
  });

  test('consecutive affirmative no-fresh tails stay resolvable when the LATEST one is named', () => {
    const tails = [
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      }),
      cycleRecord({
        cycleId: 'c003-aaaaaaaa',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      }),
    ];
    const resolved = assemble([
      cycleRecord(),
      ...tails,
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c003-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(resolved.ready).toBe(true);
    // Naming the earlier no-fresh attempt leaves the later one unresolved.
    const stale = assemble([
      cycleRecord(),
      ...tails,
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(stale.ready).toBe(false);
  });

  test('a newer genuine terminal after the blocker settles readiness on that terminal', () => {
    const result = assemble([
      cycleRecord(),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        completion: { kind: 'blocked', reason: 'reviewer stream carried an error event' },
      }),
      cycleRecord({ cycleId: 'c003-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.record.cycleId).toBe('c003-aaaaaaaa');
  });

  test('a CR terminal, a later AGENT terminal, then a CR no-fresh tail: the referenced reuse settles ready on the global anchor', () => {
    // PR580 thread 4394615080 / #593: the persisted reuse is validated against
    // the terminal IT names (CodeRabbit A), not the global readiness anchor
    // (agent B) — while the ready record still reports B as its coverage
    // anchor and the reuse row as its reuse evidence.
    const result = assemble([
      cycleRecord(),
      cycleRecord({ cycleId: 'c002-aaaaaaaa', reviewer: 'agent:reviewer' }),
      cycleRecord({
        cycleId: 'c003-aaaaaaaa',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      }),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c003-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.record.cycleId).toBe('c002-aaaaaaaa');
      expect(result.record.reviewer).toBe('agent:reviewer');
      expect(result.record.reuse).toBe('r001-aaaaaaaa');
    }
  });

  test('an AGENT blocked attempt between CR efforts does not pollute the same-reviewer tail', () => {
    // A(CR) -> B(agent blocked error) -> C(CR no-fresh): B is not a terminal and
    // not a CodeRabbit attempt, so the CodeRabbit tail is only C and the reuse
    // still resolves. A genuine CodeRabbit blocker in that position refuses.
    const result = assemble([
      cycleRecord(),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        reviewer: 'agent:reviewer',
        completion: { kind: 'blocked', reason: 'reviewer stream carried an error event' },
      }),
      cycleRecord({
        cycleId: 'c003-aaaaaaaa',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      }),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c003-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.record.cycleId).toBe('c001-aaaaaaaa');
      expect(result.record.reuse).toBe('r001-aaaaaaaa');
    }
  });

  test('interleaved CodeRabbit no-fresh tails around a later AGENT terminal stay resolvable', () => {
    // A(CR) -> C1(CR no-fresh) -> B(agent terminal) -> C2(CR no-fresh): the
    // same-reviewer tail is [C1, C2], both eligible, resolved by naming C2.
    const result = assemble([
      cycleRecord(),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      }),
      cycleRecord({ cycleId: 'c003-aaaaaaaa', reviewer: 'agent:reviewer' }),
      cycleRecord({
        cycleId: 'c004-aaaaaaaa',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      }),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c004-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.record.cycleId).toBe('c003-aaaaaaaa');
      expect(result.record.reuse).toBe('r001-aaaaaaaa');
    }
  });

  test('a referenced anchor that is not the tail reviewer terminal at this identity never resolves', () => {
    const agentTerminal = () =>
      cycleRecord({ cycleId: 'c002-aaaaaaaa', reviewer: 'agent:reviewer' });
    const crTail = () =>
      cycleRecord({
        cycleId: 'c003-aaaaaaaa',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      });
    const notReady = (records: Parameters<typeof assemble>[0], label: string) => {
      const result = assemble(records);
      expect(result.ready, label).toBe(false);
      if (result.ready) return undefined;
      return result.gaps;
    };
    const namesMissing = notReady(
      [
        cycleRecord(),
        agentTerminal(),
        crTail(),
        reuseRecord({
          basis: 'no-fresh-tail',
          resolvesCycleId: 'c003-aaaaaaaa',
          cycleId: 'c099-aaaaaaaa',
        }),
        checkRecord(),
      ],
      'missing referenced cycle',
    );
    expect(namesMissing?.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);

    const namesTail = notReady(
      [
        cycleRecord(),
        agentTerminal(),
        crTail(),
        reuseRecord({
          basis: 'no-fresh-tail',
          resolvesCycleId: 'c003-aaaaaaaa',
          cycleId: 'c003-aaaaaaaa',
        }),
        checkRecord(),
      ],
      'referenced cycle is the blocked tail itself',
    );
    expect(namesTail?.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);

    const namesAgent = notReady(
      [
        cycleRecord(),
        agentTerminal(),
        crTail(),
        reuseRecord({
          basis: 'no-fresh-tail',
          resolvesCycleId: 'c003-aaaaaaaa',
          cycleId: 'c002-aaaaaaaa',
        }),
        checkRecord(),
      ],
      'referenced cycle is the other reviewer terminal',
    );
    expect(namesAgent?.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);

    const namesOtherHead = notReady(
      [
        cycleRecord({ cycleId: 'c001-aaaaaaaa', head: 'd'.repeat(40) }),
        agentTerminal(),
        crTail(),
        reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c003-aaaaaaaa' }),
        checkRecord(),
      ],
      'referenced terminal at another head',
    );
    expect(namesOtherHead?.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);

    const rowBeforeTail = notReady(
      [
        cycleRecord(),
        agentTerminal(),
        reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c003-aaaaaaaa' }),
        crTail(),
        checkRecord(),
      ],
      'reuse row ordered before the tail it resolves',
    );
    expect(rowBeforeTail?.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
  });

  test('a resolution record that names the WRONG tail or wrong anchor never resolves', () => {
    for (const mismatched of [
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c009-aaaaaaaa' }),
      reuseRecord({
        basis: 'no-fresh-tail',
        resolvesCycleId: 'c002-aaaaaaaa',
        cycleId: 'c009-aaaaaaaa',
      }),
    ]) {
      const result = assemble([cycleRecord(), blockedTail(), mismatched, checkRecord()]);
      expect(result.ready).toBe(false);
      if (!result.ready)
        expect(result.gaps.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
    }
  });

  test('a tail at a DIFFERENT identity (stale drift) is a real blocker, never resolved', () => {
    const staleTail = cycleRecord({
      cycleId: 'c002-aaaaaaaa',
      completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      dirtySha256: 'older-dirty',
    });
    const result = assemble([
      cycleRecord(),
      staleTail,
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready)
      expect(result.gaps.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
  });

  test('a NON-no-fresh blocked tail is a real gap even with a resolution record present', () => {
    const result = assemble([
      cycleRecord(),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        completion: { kind: 'blocked', reason: 'reviewer stream carried an error event' },
      }),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready)
      expect(result.gaps.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
  });

  test('a no-fresh tail from an UNCONFIGURED reviewer is not resolved (adjudicated shape)', () => {
    // Adjudication: the reused ANCHOR is configured (so the terminal anchor
    // requirement is met); the unconfigured tail is NOT the latest overall
    // attempt Q4's resolution inspects, and its findings remain subject to
    // disposition. Readiness names the configured terminal reviewer, with
    // no reuse resolution attributed to the unrelated unconfigured tail.
    const result = assembleReadiness({
      branch: BRANCH,
      target: 'main',
      identity: { base: BASE, head: HEAD, dirtySha256: 'dirty' },
      ledger: {
        version: DEV_LEDGER_VERSION,
        branch: BRANCH,
        records: [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            reviewer: 'agent:unreviewer',
            completion: { kind: 'blocked', reason: NO_FRESH_REASON },
          }),
          reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
          checkRecord(),
        ],
      },
      untracked: [],
      configuredReviewers: ['coderabbit'],
      nowIso: '2026-10-17T01:00:00.000Z',
    });
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.record.reviewer).toBe('coderabbit');
      expect(result.record.reuse).toBeUndefined();
    }
  });

  test('blocking findings on the tail still block readiness through the resolution', () => {
    const findingId = 'c002-aaaaaaaa#f1';
    const records = [
      cycleRecord(),
      { ...blockedTail(), findings: [{ id: findingId, severity: 'critical' }] },
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ];
    const result = assemble(records);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.gaps.map((gap) => gap.field)).toEqual(['open-blocking-findings']);
      expect(result.gaps[0]?.detail).toContain(findingId);
    }
    const deferred = assemble([...records, dispositionRecord({ findingId, action: 'deferred' })]);
    expect(deferred.ready).toBe(false);
    if (!deferred.ready)
      expect(deferred.gaps.map((gap) => gap.field)).toEqual(['open-blocking-findings']);
    for (const action of ['fixed', 'rejected'] as const) {
      const adjudicated = assemble([...records, dispositionRecord({ findingId, action })]);
      expect(adjudicated.ready).toBe(true);
      if (adjudicated.ready) {
        expect(adjudicated.record.cycleId).toBe('c001-aaaaaaaa');
        expect(adjudicated.record.reuse).toBe('r001-aaaaaaaa');
      }
    }
  });

  test('reuse evidence rides the ready record verbatim: the caveat stays authoritative', () => {
    const result = assemble([
      cycleRecord(),
      blockedTail(),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.record.evidenceClass).toBe('author');
      expect(result.record.caveat).toContain('not verification');
      expect(result.record.cycleId).toBe('c001-aaaaaaaa');
    }
  });
});
