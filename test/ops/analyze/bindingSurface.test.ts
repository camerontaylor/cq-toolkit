// Split from test/ops/analyze/approval.test.ts (pure move; the shared preamble
// lives in withApprovedMutation.test.ts). Subject: index-hidden edits, ledger
// identity, the approvalInputDigest and the public binding surface.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realTmpDirSync } from '../../helpers/tmp-dir.js';
import { describe, expect, test } from 'vitest';
import {
  approvalInputDigest,
  DENY_ALL_APPROVALS,
  makeApprovalAuthority,
  makeGitApprovalStateReader,
  makeLedgerBesideMutationLocks,
  makeProcessLocalMutationLocks,
  withApprovedMutation,
} from '../../../src/ops/analyze/approval.js';
import {
  makeFileNonceLedger,
  makeInMemoryNonceLedger,
} from '../../../src/adapters/store/nonceLedger.js';
import { makeGitMutex } from '../../../src/shared/gitMutex.js';
import * as toolkit from '../../../src/index.js';
import { git, OP, realRepo, realpathOf, writeSpy } from './approvalFixtures.js';

describe('approvalInputDigest', () => {
  test('is stable across key order and sensitive to every input change', () => {
    expect(approvalInputDigest({ a: 1, b: [2, { d: 4, c: 3 }] })).toBe(
      approvalInputDigest({ b: [2, { c: 3, d: 4 }], a: 1 }),
    );
    expect(approvalInputDigest({ approved: true })).not.toBe(
      approvalInputDigest({ approved: false }),
    );
    expect(approvalInputDigest({ a: 1 })).not.toBe(approvalInputDigest({ a: 2 }));
    expect(approvalInputDigest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// Conductor pass (2026-10-08): the three Codex findings fixed on this head.
describe('index-hidden edits, ledger identity, and the public binding surface', () => {
  test('a relative dangling ledger link uses its canonical parent through a directory alias', async () => {
    const root = realTmpDirSync('cq-ledger-parent-alias-');
    const real = join(root, 'real');
    const sub = join(real, 'sub');
    mkdirSync(sub, { recursive: true });
    symlinkSync(sub, join(root, 'alias'));
    symlinkSync('../ledger', join(sub, 'link'));
    const nonce = 'b'.repeat(32);

    await expect(makeFileNonceLedger(join(root, 'alias', 'link')).consume(nonce)).resolves.toBe(
      'consumed',
    );
    await expect(makeFileNonceLedger(join(real, 'ledger')).consume(nonce)).resolves.toBe('spent');
    expect(existsSync(join(root, 'ledger'))).toBe(false);
    expect(readFileSync(join(real, 'ledger'), 'utf8')).toBe(`${nonce}\n`);
  });

  test('a dangling final symlink shares the target append lock before the ledger exists', async () => {
    const dir = realTmpDirSync('cq-dangling-ledger-');
    const path = join(dir, 'ledger');
    const alias = join(dir, 'alias');
    symlinkSync('ledger', alias);
    const ledger = makeFileNonceLedger(alias);
    let settled = false;
    let pending: Promise<'consumed' | 'spent'> | undefined;
    await makeGitMutex({ lockPath: `${path}.append` }).withLock(async () => {
      pending = ledger.consume('a'.repeat(32)).finally(() => {
        settled = true;
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      expect(settled).toBe(false);
      expect(existsSync(path)).toBe(false);
    });
    expect(await pending).toBe('consumed');
    expect(await makeFileNonceLedger(path).consume('a'.repeat(32))).toBe('spent');
    expect(readFileSync(path, 'utf8')).toBe(`${'a'.repeat(32)}\n`);
  });

  test('an aged append lock cannot be stolen while its holder is alive', async () => {
    const dir = realTmpDirSync('cq-aged-ledger-');
    const path = join(dir, 'ledger');
    const ledger = makeFileNonceLedger(path);
    let settled = false;
    let pending: Promise<'consumed' | 'spent'> | undefined;
    await makeGitMutex({ lockPath: `${path}.append` }).withLock(async () => {
      // Deterministically simulate a stalled heartbeat beyond the 30s lease.
      const old = new Date(Date.now() - 120_000);
      utimesSync(`${path}.append.lock`, old, old);
      pending = ledger.consume('b'.repeat(32)).finally(() => {
        settled = true;
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      expect(settled).toBe(false);
      expect(existsSync(path)).toBe(false);
    });
    expect(await pending).toBe('consumed');
    expect(readFileSync(path, 'utf8')).toBe(`${'b'.repeat(32)}\n`);
  });

  test.each(['--assume-unchanged', '--skip-worktree'])(
    'an index entry flagged %s cannot hide an edit from the clean predicate',
    async (flag) => {
      const repo = realRepo();
      const headSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      git(repo, ['update-index', flag, 'src/a.ts']);
      writeFileSync(join(repo, 'src/a.ts'), 'const x = 2;\n');
      // The premise: the status the clean predicate runs is blind to the edit.
      expect(
        execFileSync(
          'git',
          [
            '-C',
            repo,
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--ignore-submodules=none',
          ],
          { encoding: 'utf8' },
        ),
      ).toBe('');
      const reader = makeGitApprovalStateReader();
      await expect(reader.read(repo)).rejects.toThrow(
        /assume-unchanged or skip-worktree \('src\/a\.ts'\)/,
      );
      // And through the authority: refused at admission, nothing written,
      // nothing spent — even though the kernel "signed" the clean HEAD state.
      const ledger = makeInMemoryNonceLedger();
      const authority = makeApprovalAuthority({
        approvals: {
          verifiedFor: (candidate) =>
            Promise.resolve({
              nonce: 'e'.repeat(32),
              state: { workspace: candidate.workspace, headSha, treeClean: true },
            }),
        },
        ledger,
        locks: makeProcessLocalMutationLocks(),
        readState: reader,
      });
      const write = writeSpy();
      const outcome = await withApprovedMutation(
        authority,
        { op: OP, workspace: repo, targets: ['src/a.ts'], inputDigest: 'sha256:hidden' },
        write.run,
      );
      expect(outcome.status).toBe('needs-human');
      expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain(
        'never treated as unchanged',
      );
      expect(write.calls).toBe(0);
      expect(ledger.spent()).toBe(0);
    },
    20_000,
  );

  test('two spellings of one ledger (a symlink and its target) share ONE append lock', async () => {
    const real = realpathOf(mkdtempSync(join(tmpdir(), 'cq-ledger-real-')));
    const alias = join(realpathOf(mkdtempSync(join(tmpdir(), 'cq-ledger-alias-'))), 'state');
    symlinkSync(real, alias);
    const canonicalPath = join(real, 'approvals.ndjson');
    const viaAlias = makeFileNonceLedger(join(alias, 'approvals.ndjson'));
    // Hold the lock the CANONICAL spelling derives. A consume through the
    // alias must queue behind it; a raw-path-keyed lock would be a second,
    // unrelated artifact and the consume would complete inside this hold.
    const canonicalLock = makeGitMutex({ lockPath: `${canonicalPath}.append` });
    const nonce = 'f'.repeat(32);
    let settled = false;
    let pending: Promise<'consumed' | 'spent'> | undefined;
    await canonicalLock.withLock(async () => {
      pending = viaAlias.consume(nonce).finally(() => {
        settled = true;
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      expect(settled).toBe(false);
      expect(existsSync(canonicalPath)).toBe(false);
    });
    expect(await pending).toBe('consumed');
    expect(readFileSync(canonicalPath, 'utf8')).toBe(`${nonce}\n`);
    expect(makeFileNonceLedger(canonicalPath).isSpent(nonce)).toBe(true);
  }, 20_000);

  test('the root barrel exports the authority construction and binding surface', () => {
    expect(toolkit.makeApprovalAuthority).toBe(makeApprovalAuthority);
    expect(toolkit.makeFileNonceLedger).toBe(makeFileNonceLedger);
    expect(toolkit.makeLedgerBesideMutationLocks).toBe(makeLedgerBesideMutationLocks);
    expect(toolkit.makeProcessLocalMutationLocks).toBe(makeProcessLocalMutationLocks);
    expect(toolkit.makeGitApprovalStateReader).toBe(makeGitApprovalStateReader);
    expect(toolkit.makeInMemoryNonceLedger).toBe(makeInMemoryNonceLedger);
    expect(toolkit.approvalInputDigest).toBe(approvalInputDigest);
    expect(toolkit.DENY_ALL_APPROVALS).toBe(DENY_ALL_APPROVALS);
    expect(typeof toolkit.setAnalyzeApprovalAuthority).toBe('function');
  });
});
