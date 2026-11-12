// Split from test/ops/analyze/approval.test.ts (pure move; the shared preamble
// lives in withApprovedMutation.test.ts). Subject: the durable operator nonce
// ledger (ADR-0003 §4c step 2 and §5) — makeFileNonceLedger.

import { existsSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realTmpDirSync } from '../../helpers/tmp-dir.js';
import { describe, expect, test } from 'vitest';
import type { ApprovalSubject } from '../../../src/ops/analyze/approval.js';
import { makeFileNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
  withApprovedMutation,
} from '../../../src/ops/analyze/approval.js';
import {
  CLEAN_STATE,
  fixedStateReader,
  grantingAuthority,
  OP,
  subject,
  TARGETS,
  WORKSPACE,
  writeSpy,
} from './approvalFixtures.js';

describe('the durable operator ledger (ADR-0003 §5)', () => {
  test('an append-lock failure identifies the artifact and retains its filesystem cause', async () => {
    const dir = realTmpDirSync('cq-ledger-lock-error-');
    // The ledger name fits a normal filesystem component; adding the lock
    // suffix exceeds it and produces an immediate non-EEXIST mkdir failure.
    const ledgerPath = join(dir, 'a'.repeat(250));
    const artifact = `${ledgerPath}.append.lock`;
    const failure: unknown = await makeFileNonceLedger(ledgerPath)
      .consume('a'.repeat(32))
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: expect.stringContaining(artifact) as unknown,
      cause: expect.objectContaining({ code: 'ENAMETOOLONG' }) as unknown,
    });
    expect((failure as Error).message).toContain('ENAMETOOLONG');
    expect((failure as Error).message).toContain('never reclaim by age');
    expect(existsSync(ledgerPath)).toBe(false);
  });

  test('a token spent in one run is refused in a LATER run against the same ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-ledger-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    // ADR-shaped nonces (32 lowercase hex), because the durable ledger now
    // validates every record against that shape. Using the fixture's
    // human-readable nonce here would make this test pass for the WRONG
    // reason — refused as MALFORMED rather than refused as SPENT — and it
    // would stop testing the replay case it exists for.
    const nonce = '9'.repeat(32);
    const verified = {
      verifiedFor: (candidate: ApprovalSubject) =>
        Promise.resolve({
          nonce,
          state: { ...CLEAN_STATE, workspace: candidate.workspace },
        }),
    };
    const firstRun = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      approvals: verified,
      ledger: makeFileNonceLedger(ledgerPath),
    });
    const first = await withApprovedMutation(
      firstRun.authority,
      firstRun.subjectOf(TARGETS),
      writeSpy().run,
    );
    expect(first.status).toBe('ok');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(`${nonce}\n`);
    // A fresh process would look exactly like this: a NEW authority over the
    // same operator ledger, with no memory of the first run.
    const secondRun = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      approvals: verified,
      ledger: makeFileNonceLedger(ledgerPath),
    });
    const replayWrite = writeSpy();
    const replay = await withApprovedMutation(
      secondRun.authority,
      secondRun.subjectOf(TARGETS),
      replayWrite.run,
    );
    expect(replay.status).toBe('needs-human');
    // Refused as SPENT — the ADR §5 replay case — not as malformed.
    expect(replay.status === 'needs-human' ? replay.reason : '').toContain('already consumed');
    expect(replayWrite.calls).toBe(0);
  });
});

describe('the operator ledger is durable before it reports a spend (ADR-0003 §4c step 2)', () => {
  test('malformed history fails closed for read-only inspection as well as consume', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cq-malformed-history-')), 'ledger');
    writeFileSync(path, `${'a'.repeat(32)}\nbroken\n`);
    const ledger = makeFileNonceLedger(path);
    expect(() => ledger.spent()).toThrow(/malformed/);
    expect(() => ledger.isSpent('a'.repeat(32))).toThrow(/malformed/);
    await expect(ledger.consume('a'.repeat(32))).rejects.toThrow(/malformed/);
  });

  test('a write that loses only the newline is indeterminate and never reads as spent', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cq-newline-tear-')), 'ledger');
    const nonce = 'a'.repeat(32);
    const torn = makeFileNonceLedger(path, {
      write: (handle, buffer, offset) => {
        if (offset !== 0) throw new Error('newline write failed');
        return writeSync(handle, buffer, offset, 32);
      },
    });
    await expect(torn.consume(nonce)).rejects.toThrow(/INDETERMINATE.*newline write failed/);
    expect(readFileSync(path, 'utf8')).toBe(nonce);
    for (const ledger of [torn, makeFileNonceLedger(path)]) {
      await expect(ledger.consume(nonce)).rejects.toThrow(/unterminated record/);
      expect(() => ledger.isSpent(nonce)).toThrow(/unterminated record/);
      expect(() => ledger.spent()).toThrow(/unterminated record/);
    }
    expect(readFileSync(path, 'utf8')).toBe(nonce);
  });

  test('the authority reports a newline-tear append as indeterminate and never writes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cq-newline-authority-')), 'ledger');
    const ledger = makeFileNonceLedger(path, {
      write: (handle, buffer, offset) => (offset === 0 ? writeSync(handle, buffer, offset, 32) : 0),
    });
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'a'.repeat(32),
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(CLEAN_STATE),
    });
    const write = writeSpy();
    const outcome = await withApprovedMutation(authority, subject(), write.run);
    expect(outcome.status).toBe('needs-human');
    if (outcome.status !== 'needs-human') return;
    expect(outcome.reason).toContain('append persistence is INDETERMINATE');
    expect(outcome.reason).toContain('including a short write');
    expect(write.calls).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('a'.repeat(32));
  });

  test('the nonce is on disk, and the directory entry exists, when consume resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-durable-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const ledger = makeFileNonceLedger(ledgerPath);
    // Synchronous consumption is the observable half of the claim: by the
    // time the promise settles the bytes must be readable from the file, not
    // queued in a buffer. (The fdatasync/dir-fsync that make it survive a
    // POWER loss are not observable from a test process, and are not claimed
    // to be beyond the journal's own F_FULLFSYNC residual.)
    const nonce = 'e'.repeat(32);
    return ledger.consume(nonce).then((outcome) => {
      expect(outcome).toBe('consumed');
      expect(existsSync(ledgerPath)).toBe(true);
      expect(readFileSync(ledgerPath, 'utf8')).toBe(`${nonce}\n`);
      return ledger.consume(nonce);
    });
  });

  test('a SHORT write is looped to completion: the synced record is the whole nonce', async () => {
    // The reported edge: `fs.writeSync` returns a byte COUNT and may write
    // less than asked. A single unchecked call would fdatasync a truncated
    // line, report 'consumed', and leave the full nonce absent — so the
    // very same token would replay cleanly, which is the one outcome this
    // ledger exists to prevent.
    const dir = mkdtempSync(join(tmpdir(), 'cq-short-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const calls: number[] = [];
    const ledger = makeFileNonceLedger(ledgerPath, {
      // A writer that dribbles out five bytes at a time.
      write: (handle, buffer, offset, length) => {
        const count = Math.min(5, length);
        calls.push(count);
        return writeSync(handle, buffer, offset, count);
      },
    });
    const outcome = await ledger.consume('f'.repeat(32));
    expect(outcome).toBe('consumed');
    // It really did take several writes, and the file holds the WHOLE
    // record — not a prefix that would parse as a different nonce.
    expect(calls.length).toBeGreaterThan(1);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(`${'f'.repeat(32)}\n`);
    // And the full nonce is genuinely spent, so the replay is refused.
    const replay = await ledger.consume('f'.repeat(32));
    expect(replay).toBe('spent');
  });

  test('a TORN partial record fails closed on the same instance AND a fresh one', async () => {
    // The corruption path. A short write that lands SOME bytes leaves a
    // partial record; because the next append is O_APPEND, the following
    // record would fuse onto it into a line matching NEITHER nonce, and a
    // fresh instance absorbing that merged line would not see the real nonce
    // as spent.
    const dir = mkdtempSync(join(tmpdir(), 'cq-torn-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const nonce = 'a'.repeat(32);
    // The writer lays down six bytes ONCE, honouring the offset and length
    // it is handed, and then makes no progress. (Writing six bytes on EVERY
    // call and returning 6 would be a different, broken fixture: writeAll
    // would keep looping while the writer re-wrote the same six bytes, and
    // the failure it eventually reported would be the over-report guard
    // rather than the no-progress one.)
    let calls = 0;
    const torn = makeFileNonceLedger(ledgerPath, {
      write: (handle, buffer, offset, length) => {
        calls += 1;
        if (calls > 1) return 0;
        const count = Math.min(6, length);
        writeSync(handle, buffer, offset, count);
        return count;
      },
    });
    // The consume itself FAILS: a partial record is never reported as a
    // consumption, which is the whole point.
    await expect(torn.consume(nonce)).rejects.toThrow(/made no progress/);
    // Exactly six bytes landed, and they are a PREFIX of the real nonce.
    expect(readFileSync(ledgerPath, 'utf8')).toBe(nonce.slice(0, 6));

    // The SAME instance refuses again, and so does a FRESH one (a new
    // process, a resumed run) — neither is allowed to read the torn bytes as
    // history. The TORN-TAIL guard fires first: the six bytes have no
    // terminating newline, and the single read validates that before any
    // record can enter `known`. (A terminated but malformed record is the
    // separate path covered by the malformed tests above.)
    await expect(torn.consume(nonce)).rejects.toThrow(/unterminated record/);
    const fresh = makeFileNonceLedger(ledgerPath);
    await expect(fresh.consume(nonce)).rejects.toThrow(/unterminated record/);
    // Neither refusal appended anything: the file is exactly as torn as it
    // was, so no record was fused and nothing was lost.
    expect(readFileSync(ledgerPath, 'utf8')).toBe(nonce.slice(0, 6));
  });

  test('a record that lost only its NEWLINE is refused by the torn-tail guard', async () => {
    // The realistic tear: every byte of the record landed, but the
    // terminating newline did not (the classic partial-write boundary, and
    // the case the append guard exists for). Here the record IS a
    // well-formed nonce, so the read succeeds and the TORN-TAIL guard is the
    // thing that must refuse — a distinct path from the malformed one.
    const dir = mkdtempSync(join(tmpdir(), 'cq-torn-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const other = 'b'.repeat(32);
    const nonce = 'c'.repeat(32);
    // 32 valid hex bytes, no newline.
    writeFileSync(ledgerPath, other);
    const ledger = makeFileNonceLedger(ledgerPath);
    // The SAME instance: the tail guard refuses the append.
    await expect(ledger.consume(nonce)).rejects.toThrow(/unterminated record/);
    // And a FRESH instance, which reads the unterminated record as a spent
    // nonce but still must not append onto it.
    const fresh = makeFileNonceLedger(ledgerPath);
    await expect(fresh.consume(nonce)).rejects.toThrow(/unterminated record/);
    // Nothing was appended by either refusal.
    expect(readFileSync(ledgerPath, 'utf8')).toBe(other);
  });

  test('a MALFORMED record fails the ledger closed (history is never read wrong)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-malformed-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    // A well-formed record followed by one that is not a nonce shape: the
    // fused-line outcome, or any external corruption. Reading it as history
    // would silently mark a nonce spent that was never spent (or vice
    // versa), so the whole read fails instead.
    writeFileSync(ledgerPath, `${'b'.repeat(32)}\nnot-a-nonce\n`);
    const ledger = makeFileNonceLedger(ledgerPath);
    await expect(ledger.consume('c'.repeat(32))).rejects.toThrow(/malformed/);
    // The well-formed record before it is not enough to make the read
    // succeed: one bad record invalidates the file's trustworthiness.
  });

  test('a well-formed ledger still works end to end (positive control for the validation)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-ok-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const first = makeFileNonceLedger(ledgerPath);
    const nonce = 'd'.repeat(32);
    expect(await first.consume(nonce)).toBe('consumed');
    // A fresh instance sees it spent — which is the whole point of the
    // ledger, and must survive the validation added above.
    const second = makeFileNonceLedger(ledgerPath);
    expect(await second.consume(nonce)).toBe('spent');
  });

  test('a write that cannot progress is REFUSED before any consumption is claimed', async () => {
    // Fail closed: a zero-byte write records no nonce, so the ledger must
    // throw with persistence INDETERMINATE, never report 'consumed'.
    const dir = mkdtempSync(join(tmpdir(), 'cq-short-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const ledger = makeFileNonceLedger(ledgerPath, {
      write: () => 0,
    });
    await expect(ledger.consume('0'.repeat(32))).rejects.toThrow(/made no progress/);
  });

  test('an over-reporting writer is refused too (it is not honouring the contract)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-short-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const ledger = makeFileNonceLedger(ledgerPath, {
      write: (handle, buffer) => {
        writeSync(handle, buffer, 0, buffer.length);
        return buffer.length + 10;
      },
    });
    await expect(ledger.consume('1'.repeat(32))).rejects.toThrow(/not honouring/);
  });

  test('a short-write ledger still makes the op refuse rather than write (end to end, fail-closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-short-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const ledger = makeFileNonceLedger(ledgerPath, { write: () => 0 });
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: '2'.repeat(32),
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(),
    });
    const spy = writeSpy();
    const result = await withApprovedMutation(authority, subject(), spy.run);
    expect(result.status).toBe('needs-human');
    const reason = result.status === 'needs-human' ? result.reason : '';
    expect(reason).toContain('ledger');
    // A fault AFTER the append began is INDETERMINATE, not a clean UNSPENT:
    // the nonce may or may not be on disk. Assert that wording rather than
    // the shared boilerplate's conditional mention of UNSPENT.
    expect(reason).toContain('persistence is INDETERMINATE');
    expect(reason).toContain('made no progress');
    expect(reason).toContain('inspect the ledger and re-approve');
    // The zero-byte writer reached no disk, so the ledger holds no record.
    expect(readFileSync(ledgerPath, 'utf8')).toBe('');
    expect(spy.calls).toBe(0);
  });
});
