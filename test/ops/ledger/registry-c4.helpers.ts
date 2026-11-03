// Split provenance: test/ops/ledger/registry-c4.test.ts was split into the
// registry-c4.*.test.ts siblings in this directory; the shared fixtures and
// helpers live here. Everything below the header is moved unchanged apart
// from the `export` keywords and the scratch factory; this header is the
// original file header, kept with the family.
//
// Ledger lane C4 — registry-slice test evidence: the two entries
// (ledger.record, ledger.query) validate the full input and only it —
// strict unknown-key rejection, because a smuggled field would cross the
// plain-JSON boundary the input-driven store binding depends on — and
// their importers resolve end-to-end through the REAL pathLedgerStore (the
// one place real fs is allowed here, mirroring C1's subprocessRunCheck
// precedent): a record→query round trip over a mkdtemp root, cleaned up
// per test. The containment surface (root → strict descendant), the async
// retried lock, and the atomic publish are all exercised HERE.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registry } from '../../../src/ops/ledger/registry.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';

let scratchDir = '';

/** Create this test's mkdtemp root; the file's `afterEach(removeScratch)` owns it. */
export async function freshScratch(): Promise<string> {
  scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
  return scratchDir;
}

/** Remove the root `freshScratch` created, so each test starts from a clean dir. */
export async function removeScratch(): Promise<void> {
  if (scratchDir !== '') {
    await rm(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
}

export function entryNamed(name: string): OpRegistryEntry {
  const entry = registry.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`${name} missing from the ledger registry`);
  }
  return entry;
}
