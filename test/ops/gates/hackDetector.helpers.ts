// Gates lane C3 — test evidence for the hack detector: every shipped
// tamper-diff fixture round-trips to its EXACT expected findings
// (kind/file/line/pattern/snippet/message), the must-NOT-flag fixtures
// (pre-existing suppressions as context lines, a '-'-line removal, a clean
// change) yield zero findings, and the config surface behaves as
// documented (replacement pattern lists, requiresReason, heuristic
// toggles, hunk line-number tracking). All pure — zero I/O beyond reading
// the shipped fixture text.
//
// Split provenance: test/ops/gates/hackDetector.test.ts was split by subject
// into hackDetector.diffParsing.test.ts, hackDetector.pythonDeletion.test.ts,
// hackDetector.pythonMarkers.test.ts, hackDetector.roundtrip.test.ts,
// hackDetector.suppressionConfig.test.ts and hackDetector.tamperToggles.test.ts.
// This module holds the fixture and scan helpers those files share.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { hackDetector } from '../../../src/ops/gates/hackDetector.js';
import type { SuppressionPattern, TamperFinding } from '../../../src/ops/gates/hackDetector.js';

/** Fixture text from the shipped tamper-diff corpus. */
export function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/tamper-diffs/${name}`, import.meta.url), 'utf8');
}

/** The findings of a clean scan — asserts the op status is ok first. */
export async function findingsOf(
  diff: string,
  suppressionPatterns?: readonly SuppressionPattern[],
): Promise<TamperFinding[]> {
  const result = await hackDetector({
    diff,
    ...(suppressionPatterns === undefined ? {} : { suppressionPatterns }),
  });
  expect(result.status).toBe('ok');
  return result.status === 'ok' ? result.value : [];
}
