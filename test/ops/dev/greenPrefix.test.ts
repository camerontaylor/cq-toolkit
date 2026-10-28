// #536's pure helpers: the verified-fix chain a red final gate may fall back
// along, and the newest-first scan over it. dev.cycle's integration tests
// drive them end to end; these pin the refusal paths a real run reaches only
// through corrupted or exhausted state.
import { describe, expect, test } from 'vitest';
import {
  recordedFixChain,
  scanNewestFirst,
  type GreenPrefixProbe,
} from '../../../src/ops/dev/internal/greenPrefix.js';
import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import type { AddressFix } from '../../../src/ops/review/addressWorker.js';

const A = 'a'.repeat(40);
const c = (n: number): string => String(n).repeat(40).slice(0, 40);

function fix(commit: string | undefined, observedHead: string): AddressFix {
  return {
    finding: {
      id: `f-${commit ?? 'none'}`,
      source: 'agent',
      severity: 'major',
      text: 'finding',
      status: commit === undefined ? 'deferred' : 'fixed',
    },
    ...(commit === undefined ? {} : { commit }),
    observedHead,
    reason: 'recorded',
    validation: [],
  };
}

function report(fixes: AddressFix[]): ReviewAddressReport {
  return {
    source: 'local',
    reportPath: '/tmp/r.json',
    rounds: [],
    findings: [],
    openBlocking: [],
    fixes,
    attempts: [],
    failed: [],
    fixesPerRun: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    wallMs: 0,
    reasons: [],
  };
}

describe('recordedFixChain', () => {
  test('the commits in recorded order, a repeated consecutive commit counted once', () => {
    expect(
      recordedFixChain(
        report([fix(c(1), A), fix(c(1), A), fix(undefined, c(1)), fix(c(2), c(1))]),
        A,
      ),
    ).toEqual({ commits: [c(1), c(2)] });
  });

  test('a commit that recurs after another refuses: the order is not a linear chain', () => {
    expect(recordedFixChain(report([fix(c(1), A), fix(c(2), c(1)), fix(c(1), c(2))]), A)).toEqual({
      fault: `fix commit ${c(1)} recurs out of order in the address report`,
    });
  });

  test('no verified fix commit refuses', () => {
    expect(recordedFixChain(report([fix(undefined, A)]), A)).toEqual({
      fault: 'the address report records no verified fix commit',
    });
  });

  test('a first fix dispatched anywhere but the admitted head refuses', () => {
    expect(recordedFixChain(report([fix(c(1), c(9))]), A)).toEqual({
      fault: `the first verified fix was dispatched at ${c(9)}, not the admitted head ${A}`,
    });
  });
});

describe('scanNewestFirst', () => {
  const verdicts =
    (map: Record<string, GreenPrefixProbe['verdict']>) =>
    async (commit: string): Promise<GreenPrefixProbe> => ({ commit, verdict: map[commit]! });

  test('stops at the first green candidate, never probing older ones', async () => {
    const probed: string[] = [];
    const scan = await scanNewestFirst(
      [c(3), c(2), c(1)],
      async (commit) => {
        probed.push(commit);
        return verdicts({ [c(3)]: 'red', [c(2)]: 'green', [c(1)]: 'green' })(commit);
      },
      () => undefined,
    );
    expect(scan.selected).toBe(c(2));
    expect(probed).toEqual([c(3), c(2)]);
  });

  test('a refused reserve stops the scan between probes and says how far it got', async () => {
    let calls = 0;
    const scan = await scanNewestFirst(
      [c(3), c(2), c(1)],
      verdicts({ [c(3)]: 'red', [c(2)]: 'green', [c(1)]: 'green' }),
      () => (calls++ === 0 ? undefined : 'the reserve is spent'),
    );
    expect(scan.selected).toBeUndefined();
    expect(scan.probes.map((probe) => probe.commit)).toEqual([c(3)]);
    expect(scan.stopped).toBe('the reserve is spent after probing 1 of 3 candidate(s)');
  });

  test('a fault stops the scan: an environmental failure is never read as red', async () => {
    const scan = await scanNewestFirst(
      [c(3), c(2)],
      async (commit) =>
        commit === c(3)
          ? { commit, verdict: 'fault', detail: 'checkout failed' }
          : { commit, verdict: 'green' },
      () => undefined,
    );
    expect(scan.selected).toBeUndefined();
    expect(scan.probes).toHaveLength(1);
    expect(scan.stopped).toBe(`probe of ${c(3)} faulted: checkout failed`);
  });

  test('every candidate red: no selection, all probed', async () => {
    const scan = await scanNewestFirst(
      [c(2), c(1)],
      verdicts({ [c(2)]: 'red', [c(1)]: 'red' }),
      () => undefined,
    );
    expect(scan).toMatchObject({
      probes: [{ commit: c(2) }, { commit: c(1) }],
      stopped: 'no candidate passed all final gates (2 probed)',
    });
    expect(scan.selected).toBeUndefined();
  });
});
