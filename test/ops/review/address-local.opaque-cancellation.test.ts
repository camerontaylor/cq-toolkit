// Split provenance: test/ops/review/address-local.test.ts was split into
// subject files sharing ./address-local.helpers.ts. This file holds the
// cancellation case for a whole injected review.
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { restoreDurableDisposition } from '../../../src/ops/review/internal/durableDisposition.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { runLadder } from '../../../src/kernel/governor.js';
import { seed } from '../dev/repo.js';
import { cycleRecord, dispositionRecord } from '../dev/fakes.js';
import { fixture, useGitleaksPath } from './address-local.helpers.js';

useGitleaksPath();
test('cancelled whole injected review drains finally writes but cannot claim terminal evidence or a report', async () => {
  const f = await fixture();
  const parent = new AbortController();
  let calls = 0;
  const diagnostic = {
    entered: false,
    deferredAssertionPassed: false,
    noModelsAssertionPassed: false,
    beforeAbort: false,
    finallyClosed: false,
    entryFindingStatus: 'not-entered',
    entryModelCount: -1,
  };
  const op = makeReviewAddress({
    drivers: f.drivers,
    initialRecord: f.record,
    review: async () => {
      diagnostic.entered = true;
      diagnostic.entryFindingStatus = f.record.findings[0]?.status ?? 'missing';
      diagnostic.entryModelCount = f.models.length;
      expect(f.record.findings[0]?.status).toBe('deferred');
      diagnostic.deferredAssertionPassed = true;
      expect(f.models).toEqual([]);
      diagnostic.noModelsAssertionPassed = true;
      calls += 1;
      try {
        diagnostic.beforeAbort = true;
        parent.abort();
        return { status: 'needs-human', reason: 'opaque review cancelled' };
      } finally {
        await writeFile(join(f.repo.root, 'src/a.ts'), 'OPAQUE finally bytes\n');
        diagnostic.finallyClosed = true;
      }
    },
  });
  try {
    await seed(f.repo, (state) => [
      cycleRecord({
        cycleId: 'opaque-original',
        reviewer: 'agent:reviewer',
        base: state.base,
        head: state.head,
        dirtySha256: state.dirtySha256,
        findings: f.record.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          ...(finding.file !== undefined ? { fileName: finding.file } : {}),
          ...(finding.line !== undefined ? { line: finding.line } : {}),
          excerpt: finding.text,
        })),
      }),
      dispositionRecord({
        findingId: f.record.findings[0]!.id,
        action: 'deferred',
        why: 'retain blocker for opaque cancellation fixture',
        head: state.head,
      }),
    ]);
    const ledger = makeSubprocessDevEffects(f.repo.root).openLedger(f.record.branch).load();
    f.record.findings = f.record.findings.map((finding) =>
      restoreDurableDisposition(finding, ledger),
    );
    expect(f.record.findings[0]?.status).toBe('deferred');
    const governed = await runLadder(
      () => op({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, push: true }),
      {},
      { op: 'review.address', jobKey: 'opaque-cancelled-address', attempt: 1 },
      { signal: parent.signal },
    );
    expect(governed.outcome).toBe('completed');
    if (governed.outcome !== 'completed') return;
    const result = governed.value;
    expect(
      calls,
      JSON.stringify({
        ...diagnostic,
        outcome: governed.outcome,
        resultStatus: result.status,
        modelCount: f.models.length,
        failedCount: (result.status === 'ok' ? result.value : result.report)?.failed.length ?? -1,
        reasonCount: (result.status === 'ok' ? result.value : result.report)?.reasons.length ?? -1,
        durabilityUnconfirmed:
          result.status === 'failed' && result.error.includes('durability unconfirmed'),
        opaqueUnconfirmed:
          result.status === 'failed' &&
          result.error.includes('opaque invocation write-set unconfirmed'),
      }),
    ).toBe(1);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('durability unconfirmed');
    expect(result.error).toContain('opaque invocation write-set unconfirmed');
    expect(result.report?.failed).toEqual([]);
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('OPAQUE finally bytes\n');
    expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.record.head);
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
    expect(f.models).toEqual([]);
    expect(result.report).toBeDefined();
    await expect(readFile(result.report!.reportPath)).rejects.toHaveProperty('code', 'ENOENT');
    const retry = await f.op({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
    expect(retry.status).toBe('needs-human');
    const common = await realpath(
      f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    );
    const gitDir = await realpath(f.repo.git('rev-parse', '--absolute-git-dir').trim());
    const lock = join(
      common,
      'cq-review/slots',
      `checkout-${createHash('sha256').update(gitDir).digest('hex')}.lock`,
    );
    expect(retry.status === 'needs-human' && retry.reason).toBe(`Slot busy: ${lock}`);
    expect(f.models).toEqual([]);
    expect(f.repo.git('ls-remote', '--heads', 'origin', 'cq-address/*')).toBe('');
  } finally {
    await f.cleanup();
  }
});
