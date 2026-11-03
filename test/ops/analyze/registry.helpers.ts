// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; the shared fixtures and
// helpers live here. Everything below the header is moved unchanged apart
// from the `export` keywords; this header is the original file header, kept
// with the family.
//
// Analyze lane G1+G2+G3 — registry-slice test evidence: the entries
// (analyze.collectFailures, analyze.clusterErrors, the G2
// analyze.renderAnalysisReport, and the G3 playbook entries) validate the
// full input and only it — strict unknown-key rejection is load-bearing at
// every family boundary — and their importers resolve lazily to the ops
// (the aggregator with its policy-to-failed mapping, the pure clustering
// decision op, the report-pair publisher bound to the containment-checked
// path store, and the playbook lane composed over its SHARED
// registry/ledger singletons).
import { expect } from 'vitest';
import type { ApprovalAuthority, ApprovalState } from '../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../src/ops/analyze/approval.js';

/** A minimal valid FailureSet (the gates registry test's idiom). */
export const EMPTY_FAILURE_SET = { tool: 'eslint', failures: [], exitCode: 0 };

/**
 * A REAL approval authority over a real (in-memory) nonce ledger and the real
 * mutation lock, standing in for the kernel's verified-approval producer.
 *
 * No such producer exists in the tree yet (there is no approval module in
 * src/kernel), which is exactly why this is injected: the registry's
 * contract is that it authorizes writes ONLY through an authority the kernel
 * verified, and this exercises that contract end to end — real registry
 * resolution, real subprocess verifier, real quarantine — without pretending
 * the kernel half exists.
 */
export function trustedAuthorityFor(workspace: string): ApprovalAuthority {
  const state: ApprovalState = { workspace, headSha: 'registry-test-head', treeClean: true };
  return makeApprovalAuthority({
    approvals: {
      verifiedFor: (subject) =>
        Promise.resolve({ nonce: `registry-${subject.inputDigest.slice(0, 12)}`, state }),
    },
    ledger: makeInMemoryNonceLedger(),
    locks: makeProcessLocalMutationLocks(),
    readState: { read: () => Promise.resolve(state) },
  });
}

/** The dispatch evidence a non-ok verifier verdict carries as serialized JSON. */
export function dispatchEvidence(text: string): {
  outcome: string;
  quarantined: boolean;
  restore: { restored: string[]; stranded: unknown[] };
} {
  const marker = 'Dispatch evidence: ';
  const at = text.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(at + marker.length)) as {
    outcome: string;
    quarantined: boolean;
    restore: { restored: string[]; stranded: unknown[] };
  };
}
