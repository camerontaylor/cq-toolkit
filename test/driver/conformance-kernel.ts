// The conformance suite's KERNEL-side leg — b-ii, the governed abort.
//
// Seam v2 moved the driver-conformance suite into the shipped
// src/driver/conformance.ts, which by the one-directional seam rule imports
// NO kernel module. The governor-ladder abort leg (b-ii — the kernel's
// escalation ladder fires the rung-1 signal mid-run) is therefore a
// TEST-TREE leg each lane registers alongside the shipped suite: the lane
// under test must obey the GOVERNED signal exactly as it obeys a plain
// RunOptions.signal (leg b-iii). Post-S6 the RunOptions path is the
// normative channel; this ladder path stays as the kernel-mechanics proof
// (ADR-0002 checklist §4).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLadder } from '../../src/kernel/governor.js';
import type { ConformanceMakeDriver, ConformanceRunner } from '../../src/driver/conformance.js';
import { conformanceInvocation } from '../../src/driver/conformance.js';

/** Register the b-ii governed-abort leg for one lane's makeDriver. */
export function runGovernedAbortLeg(
  makeDriver: ConformanceMakeDriver,
  runner: ConformanceRunner,
): void {
  const { describe, test, expect } = runner;

  describe('driver conformance: governed abort (kernel ladder)', () => {
    test('b-ii. abort: governed signal fired mid-run settles stopReason aborted', async () => {
      const scratchDir = await mkdtemp(join(tmpdir(), 'conformance-'));
      try {
        const driver = makeDriver({ directive: { kind: 'block-until-abort' }, scratchDir });
        // The governor's own channel mechanics: runLadder passes the rung-1
        // signal to the task, which forwards it as RunOptions.signal (the
        // seam-v2 channel); the ladder fires it at wallClockMs. A conforming
        // driver obeys the signal and settles 'aborted' (I8 — the driver
        // decides nothing about WHEN).
        const outcome = await runLadder(
          (ctx) => driver.run(conformanceInvocation(), { signal: ctx.signal }),
          { wallClockMs: 25 },
          { op: 'conformance', jobKey: 'conformance', attempt: 1 },
        );
        expect(outcome.outcome).toBe('completed');
        if (outcome.outcome !== 'completed') return; // narrow for TS
        expect(outcome.value.stopReason).toBe('aborted');
        expect(outcome.value.error).toBeUndefined();
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    });
  });
}
