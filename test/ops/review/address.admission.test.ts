import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
// Split provenance: test/ops/review/address.test.ts was split into this file
// plus address.{helpers.ts,composition,reviewRounds,blockedRereview,vendorBoundary,lock,m5b3Correlation}.test.ts.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { devLedgerPath } from '../../../src/ops/dev/record.js';
import { finding, fixture, reportOf } from './address.helpers.js';

test.each(['clean', 'tracked', 'staged', 'untracked'] as const)(
  'head-only clean findings cannot certify %s content',
  async (mode) => {
    const f = await fixture([]);
    try {
      const head = f.record().head;
      if (mode !== 'clean') {
        await f.repo.write(
          mode === 'untracked' ? 'unreviewed.ts' : 'src/a.ts',
          'unreviewed content',
        );
        if (mode === 'staged') f.repo.git('add', 'src/a.ts');
      }
      const result = await makeReviewAddress(f.deps)(f.input);
      expect(result.status).toBe(mode === 'clean' ? 'ok' : 'needs-human');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(head);
      expect(f.calls).toEqual([]);
      if (mode !== 'clean') expect(reportOf(result).reasons.join(' ')).toMatch(/dirty|untracked/);
      expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
        reportOf(result),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test('a clean refreshed record cannot return ok after its wall budget expires', async () => {
  const f = await fixture();
  const realNow = Date.now;
  let clock = realNow();
  try {
    const deps = {
      ...f.deps,
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (finding: Finding) => {
          f.calls.push(`fix:${finding.id}`);
          return {
            finding: { ...finding, status: 'rejected' as const, reason: 'false positive' },
            reason: 'false positive',
            observedHead: f.record().head,
            validation: [],
          };
        },
      }),
      review: async () => {
        clock += 1001;
        return { status: 'ok' as const, value: { ...f.record(), findings: [] } };
      },
    };
    Date.now = () => clock;
    const result = await makeReviewAddress(deps)({ ...f.input, wallMs: 1000, rounds: 1 });
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).reasons.join(' ')).toMatch(/wall/);
    expect(f.calls).toContain('fix:a');
  } finally {
    Date.now = realNow;
    await f.cleanup();
  }
});

test.each([
  'explicit',
  'latest',
  'latest-unknown-head',
  'latest-other-branch',
  'latest-malformed-history',
  'head-mismatch',
  'branch-mismatch',
  'blocked',
  'malformed',
  'missing',
] as const)('local persisted findings admission is fail closed: %s', async (mode) => {
  const f = await fixture([]);
  try {
    const deps = { ...f.deps };
    delete deps.initialRecord;
    const record = f.record();
    if (mode === 'head-mismatch') record.head = 'a'.repeat(40);
    if (mode === 'branch-mismatch') record.branch = 'other';
    if (mode === 'blocked')
      record.sources = [{ kind: 'agent', status: 'blocked', reason: 'review interrupted' }];
    const folder = join(f.repo.root, '.cq', 'review', encodeURIComponent(record.branch));
    await mkdir(folder, { recursive: true });
    const latest = mode.startsWith('latest');
    const path =
      latest || mode === 'missing'
        ? join(folder, '2.json')
        : join(f.input.journalDir, 'record.json');
    if (mode !== 'missing')
      await writeFile(path, mode === 'malformed' ? '{' : JSON.stringify(record));
    if (latest)
      await writeFile(
        join(folder, '1.json'),
        mode === 'latest-malformed-history'
          ? '{'
          : JSON.stringify({
              ...record,
              head:
                mode === 'latest-unknown-head'
                  ? 'a'.repeat(40)
                  : f.repo.git('rev-parse', 'origin/main').trim(),
              ...(mode === 'latest-other-branch' ? { branch: 'other' } : {}),
            }),
      );
    const result = await makeReviewAddress(deps)({
      ...f.input,
      ...(latest || mode === 'missing' ? {} : { record: path }),
    });
    expect(result.status).toBe(mode === 'explicit' || mode === 'latest' ? 'ok' : 'needs-human');
    expect(f.calls).toEqual([]);
    expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
      reportOf(result),
    );
  } finally {
    await f.cleanup();
  }
});

test('report storage failure retains the complete non-ok artifact', async () => {
  const f = await fixture([]);
  try {
    const reportDirectory = join(f.input.journalDir, 'review-address-report.json');
    await mkdir(reportDirectory);
    const result = await makeReviewAddress(f.deps)(f.input);
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('report write failed');
    expect(reportOf(result).findings).toEqual([]);
    expect(reportOf(result).usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(reportOf(result).reportPath).toBe(reportDirectory);
    expect(f.calls).toEqual([]);
    await expect(readFile(reportDirectory, 'utf8')).rejects.toMatchObject({ code: 'EISDIR' });
  } finally {
    await f.cleanup();
  }
});

test('non-directory report ancestor refuses after entry without report persistence', async () => {
  const f = await fixture([]);
  try {
    const journalFile = join(f.input.journalDir, 'file');
    await writeFile(journalFile, 'not a directory');
    const result = await makeReviewAddress(f.deps)({ ...f.input, journalDir: journalFile });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toBe(
      'address lifetime finalization failed; durability unconfirmed: address terminal: report ancestor refused',
    );
    const report = reportOf(result);
    expect(report.stop).toBeUndefined();
    expect(f.calls).toEqual([]);
    expect(report.rounds).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.openBlocking).toEqual([]);
    expect(report.fixes).toEqual([]);
    expect(report.attempts).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(report.reasons).toEqual([result.status === 'failed' && result.error]);
    expect(report.reportPath).toBe(join(journalFile, 'review-address-report.json'));
    expect(await readFile(journalFile, 'utf8')).toBe('not a directory');
    await expect(readFile(report.reportPath, 'utf8')).rejects.toMatchObject({ code: 'ENOTDIR' });
  } finally {
    await f.cleanup();
  }
});

test('journal dir under a regular file (<file>/sub) keeps the base lifetime refusal', async () => {
  const f = await fixture([]);
  try {
    // P2-2: lstat of `<file>/sub` fails with ENOTDIR before any ownership
    // step. That must NOT surface as a writer/report failure or abort the
    // round: any lstat error means "not usable", so the ownership path keeps
    // its own terminal refusal and the same base failure text.
    const journalFile = join(f.input.journalDir, 'file');
    await writeFile(journalFile, 'not a directory');
    const journalDir = join(journalFile, 'sub');
    const result = await makeReviewAddress(f.deps)({ ...f.input, journalDir });
    expect(result.status).toBe('failed');
    const error = result.status === 'failed' ? result.error : '';
    expect(error.startsWith('address lifetime finalization failed; durability unconfirmed: ')).toBe(
      true,
    );
    expect(error).toContain('ENOTDIR');
    expect(error).not.toContain('report write failed');
    const report = reportOf(result);
    expect(report.stop).toBeUndefined();
    expect(f.calls).toEqual([]);
    expect(report.rounds).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.reasons).toEqual([error]);
    // No stream was opened against an unusable journal dir.
    expect(report.observation).toBeUndefined();
    expect(report.reportPath).toBe(join(journalDir, 'review-address-report.json'));
    expect(await readFile(journalFile, 'utf8')).toBe('not a directory');
    await expect(readFile(report.reportPath, 'utf8')).rejects.toMatchObject({ code: 'ENOTDIR' });
  } finally {
    await f.cleanup();
  }
});

test.each(['matching', 'uncommitted', 'different-base', 'missing'] as const)(
  'clean record needs immutable full review scope: %s',
  async (mode) => {
    const f = await fixture([]);
    try {
      const record = f.record();
      if (mode === 'uncommitted') record.reviewed!.scope = 'uncommitted';
      if (mode === 'different-base') record.reviewed!.base = record.head;
      if (mode === 'missing') delete record.reviewed;
      const result = await makeReviewAddress({ ...f.deps, initialRecord: record })(f.input);
      expect(result.status).toBe(mode === 'matching' ? 'ok' : 'needs-human');
      expect(f.calls).toEqual([]);
      if (mode !== 'matching')
        expect(reportOf(result).reasons.join(' ')).toContain('reviewed base/scope');
      expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
        reportOf(result),
      );
    } finally {
      await f.cleanup();
    }
  },
);
test('a record reviewed against HEAD cannot certify the wider target diff on the same clean head', async () => {
  const f = await fixture([]);
  try {
    const record = { ...f.record(), reviewed: { base: f.record().head, scope: 'full' as const } };
    const same = await makeReviewAddress({ ...f.deps, initialRecord: record })({
      ...f.input,
      base: record.head,
    });
    expect(same.status).toBe('ok');
    const wider = await makeReviewAddress({ ...f.deps, initialRecord: record })(f.input);
    expect(wider.status).toBe('needs-human');
    expect(reportOf(wider).reasons.join(' ')).toContain('reviewed base/scope');
    expect(f.calls).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('re-review keeps the original full comparison when a mutable target ref moves during work', async () => {
  const f = await fixture();
  const originalBase = f.record().reviewed!.base;
  let reviewedBase: string | undefined;
  try {
    const result = await makeReviewAddress({
      ...f.deps,
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (item) => {
          const observedHead = f.record().head;
          await f.repo.write('src/a.ts', 'verified fixture fix\n');
          const commit = f.repo.commitAll('scripted verified fix');
          f.repo.git('update-ref', 'refs/remotes/origin/main', commit);
          return {
            finding: { ...item, status: 'fixed' },
            commit,
            reason: 'fixed',
            observedHead,
            validation: [],
          };
        },
      }),
      review: async (input) => {
        reviewedBase = input.base;
        return {
          status: 'ok',
          value: { ...f.record(), reviewed: { base: input.base!, scope: 'full' }, findings: [] },
        };
      },
    })(f.input);
    await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
    expect(reviewedBase).toBe(originalBase);
    expect(f.repo.git('merge-base', 'origin/main', 'HEAD').trim()).not.toBe(originalBase);
  } finally {
    await f.cleanup();
  }
});

test('a local first run with no review folder reports the review.run guidance', async () => {
  const f = await fixture([]);
  try {
    const deps = { ...f.deps };
    delete deps.initialRecord;
    const result = await makeReviewAddress(deps)(f.input);
    expect(result.status).toBe('needs-human');
    expect(reportOf(result).reasons.join(' ')).toContain(
      'no findings record; run review.run or pass --record',
    );
  } finally {
    await f.cleanup();
  }
});

test('admission pins a local run to its captured base when the target ref moves', async () => {
  const f = await fixture();
  // The real ledger the admission writes lives under the ignored .cq tree.
  await f.repo.write('.git/info/exclude', '.cq/\n');
  const originalBase = f.record().reviewed!.base;
  const deps = { ...f.deps };
  // The injected disposition bypasses admission; this test inspects the real
  // ledger the admission writes.
  delete deps.disposition;
  let reviews = 0;
  try {
    const result = await makeReviewAddress({
      ...deps,
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (item) => {
          const observedHead = f.repo.git('rev-parse', 'HEAD').trim();
          if (item.id === 'b')
            return {
              finding: { ...item, status: 'rejected' as const, reason: 'not a defect' },
              reason: 'not a defect',
              observedHead,
              validation: [],
            };
          await f.repo.write('src/a.ts', 'verified fixture fix\n');
          const commit = f.repo.commitAll('scripted verified fix');
          f.repo.git('update-ref', 'refs/remotes/origin/main', commit);
          return {
            finding: { ...item, status: 'fixed' as const },
            commit,
            reason: 'fixed',
            observedHead,
            validation: [],
          };
        },
      }),
      review: async (input) => {
        reviews += 1;
        return {
          status: 'ok',
          value: {
            ...f.record(),
            reviewed: { base: input.base!, scope: 'full' },
            findings: reviews === 1 ? [finding('b')] : [],
          },
        };
      },
    })(f.input);
    await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
    expect(f.repo.git('merge-base', 'origin/main', 'HEAD').trim()).not.toBe(originalBase);
    const ledger = JSON.parse(await readFile(devLedgerPath(f.repo.root, 'feature/x'), 'utf8')) as {
      records: Array<{ kind: string; base?: string }>;
    };
    const cycles = ledger.records.filter((record) => record.kind === 'cycle');
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    expect(cycles.map((cycle) => cycle.base)).toEqual(cycles.map(() => originalBase));
  } finally {
    await f.cleanup();
  }
});
