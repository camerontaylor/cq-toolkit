// Split from test/ops/analyze/approval.test.ts (pure move; the shared preamble
// lives in withApprovedMutation.test.ts). Subject: lock-only sections, provider
// faults and nested lock domains (Opus review, PR #258).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  isExercisedScope,
  makeApprovalAuthority,
  makeLedgerBesideMutationLocks,
  makeProcessLocalMutationLocks,
  withApprovedMutation,
  withMutationLock,
} from '../../../src/ops/analyze/approval.js';
import {
  makeFileNonceLedger,
  makeInMemoryNonceLedger,
} from '../../../src/adapters/store/nonceLedger.js';
import {
  fixedStateReader,
  grantingAuthority,
  OP,
  subject,
  TARGETS,
  WORKSPACE,
  writeSpy,
} from './approvalFixtures.js';

// Opus review (PR #258).
describe('lock-only sections, provider faults and nested lock domains', () => {
  test('withMutationLock hands its callback NO scope — a lock is not a spent approval', async () => {
    const { authority } = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const held = await withMutationLock(authority, WORKSPACE, async (...args: unknown[]) =>
      args.some((arg) => isExercisedScope(arg)),
    );
    expect(held).toEqual({ ok: true, value: false });
  });

  test('a faulting verified-approval provider is a needs-human refusal, not a rejection', async () => {
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: { verifiedFor: () => Promise.reject(new Error('token snapshot unreadable')) },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(),
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(authority, subject(), spy.run);
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain(
      'token snapshot unreadable',
    );
    expect(spy.calls).toBe(0);
    expect(ledger.spent()).toBe(0);
  });

  test('nested containment roots inside one worktree share ONE mutation lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-domain-'));
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    const other = join(dir, 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    const locks = makeLedgerBesideMutationLocks(join(dir, 'state', 'approvals.ndjson'));
    expect(locks.forWorkspace(join(repo, 'src'))).toBe(locks.forWorkspace(repo));
    expect(locks.forWorkspace(other)).not.toBe(locks.forWorkspace(repo));
  });

  test('a nested repository (submodule) shares the PARENT repository lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-domain-nested-'));
    const parent = join(dir, 'parent');
    const sub = join(parent, 'vendor', 'sub');
    mkdirSync(join(parent, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n');
    const locks = makeLedgerBesideMutationLocks(join(dir, 'state', 'approvals.ndjson'));
    expect(locks.forWorkspace(sub)).toBe(locks.forWorkspace(parent));
  });

  test('a malformed nonce is refused BEFORE the ledger is touched and does not wedge it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-badnonce-'));
    const path = join(dir, 'approvals.ndjson');
    const ledger = makeFileNonceLedger(path);
    for (const bad of ['', 'ABC', 'a'.repeat(31), 'A'.repeat(32)]) {
      await expect(ledger.consume(bad)).rejects.toThrow(/malformed nonce/);
    }
    expect(existsSync(path)).toBe(false);
    await expect(ledger.consume('d'.repeat(32))).resolves.toBe('consumed');
  });

  test('two ledger instances on one file serialize through the ledger-wide lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-appendlock-'));
    const path = join(dir, 'approvals.ndjson');
    const a = makeFileNonceLedger(path);
    const b = makeFileNonceLedger(path);
    const results = await Promise.all([
      a.consume('1'.repeat(32)),
      b.consume('2'.repeat(32)),
      a.consume('2'.repeat(32)),
    ]);
    expect(results.filter((r) => r === 'consumed')).toHaveLength(2);
    expect(readFileSync(path, 'utf8').trim().split('\n').sort()).toEqual([
      '1'.repeat(32),
      '2'.repeat(32),
    ]);
  });
});
