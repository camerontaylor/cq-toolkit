import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { makeQueueClient } from '../../../src/ops/review/queue.js';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { deferredReceiptFindings } from '../../../src/ops/dev/internal/deferredReview.js';
import { loadCurrentDeferredVendorDebt } from '../../../src/ops/dev/internal/deferredLedger.js';
import { fixture, terminalReport } from './deferredLedgerHelpers.js';

test('raw Q1 finding events survive Q3 paged delivery, settlement, findings and explicit disposition', async () => {
  const f = await fixture();
  const terminal = terminalReport(f, [
    {
      type: 'finding',
      severity: 'major',
      fileName: 'src/a.ts',
      comment: 'original raw comment is retained',
      codegenInstructions: 'genuine untruncated CodeRabbit instructions '.repeat(300),
      lineNumber: 7,
      metadata: { original: true },
    },
    { type: 'finding', severity: 'trivial', comment: 'original trivial comment' },
    { type: 'finding', severity: 'none', codegenInstructions: 'original informational event' },
  ]);
  const bytes = Buffer.from(JSON.stringify(terminal.document));
  const receiptId = createHash('sha256').update(bytes).digest('hex');
  const chunks = Math.ceil(bytes.length / 3072);
  let consumed = false;
  const delivered = new Set<number>();
  const common = {
    version: 1,
    receipt_id: receiptId,
    sha256: receiptId,
    bytes: bytes.length,
    chunks,
    encoding: 'base64-utf8-json',
  };
  const client = makeQueueClient(async (raw) => {
    const request = JSON.parse(raw) as Record<string, unknown>;
    let result: unknown;
    if (request['op'] === 'status')
      result = { ...(await terminal.client.status()), receiptId, consumed };
    else if (request['op'] === 'report' && request['cursor'] === null)
      result = { page: { ...common, kind: 'manifest', cursor: receiptId + ':0' } };
    else if (request['op'] === 'report' && typeof request['cursor'] === 'string') {
      const index = Number(request['cursor'].slice(receiptId.length + 1));
      if (index !== delivered.size) throw new Error('out of order fixture delivery');
      const part = bytes.subarray(index * 3072, (index + 1) * 3072);
      delivered.add(index);
      result = {
        page: {
          ...common,
          kind: 'chunk',
          index,
          chunk_sha256: createHash('sha256').update(part).digest('hex'),
          data: part.toString('base64'),
          next_cursor: index + 1 < chunks ? receiptId + ':' + String(index + 1) : null,
        },
      };
    } else if (request['op'] === 'ack' && delivered.size === chunks) {
      consumed = true;
      result = { ...(await terminal.client.status()), receiptId, consumed };
    } else
      throw new Error('unexpected queue operation; no enrollment or vendor dispatch permitted');
    return JSON.stringify({
      v: 1,
      requestId: request['requestId'],
      binding: request['binding'],
      result,
    });
  });
  const completed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'main',
    f.state,
    f.ledger,
    client,
  );
  expect(consumed).toBe(true);
  expect(delivered.size).toBe(chunks);
  expect(chunks).toBeGreaterThan(1);
  if (!completed?.vendorCompleted) throw new Error('missing completion');
  expect(completed.completion.document.findings).toEqual(terminal.document.findings);
  const imported = deferredReceiptFindings([completed]);
  expect(imported.map((finding) => finding.severity)).toEqual(['major', 'trivial', 'none']);
  expect(imported[0]!.text).toBe(terminal.document.findings[0]!['codegenInstructions']);
  expect(imported[0]!.text.length).toBeGreaterThan(4000);
  expect(imported[1]!.text).toBe('original trivial comment');
  expect(imported[2]!.text).toBe('original informational event');
  expect(f.assemble(f.effects.openLedger(f.state.branch).load(), completed).ready).toBe(false);
  const disposition = await makeDevDisposition(f.effects)({
    repoRoot: f.repo.root,
    findingId: imported[0]!.id,
    action: 'fixed',
    why: 'explicit concrete fix for original raw vendor finding',
    owner: 'test',
    evidence: [],
  });
  expect(disposition.status).toBe('ok');
  expect(f.assemble(f.effects.openLedger(f.state.branch).load(), completed).ready).toBe(true);
  expect(completed.completion.document.findings).toEqual(terminal.document.findings);
});
// Real Q1 current_document() preserves events verbatim, including aliases; unknown
// severity and malformed text cannot become a clean or silently dropped finding.
test.each([
  { severity: 'major', comment: 'actual raw comment' },
  { severity: 'minor', codegenInstructions: 'actual raw instructions' },
  { severity: 'trivial', comment: 'low severity raw finding' },
  { severity: 'info', codegenInstructions: '', comment: 'fallback raw comment' },
  { severity: 'none', comment: 'supported none severity' },
])(
  'settles supported raw finding without changing severity or original fields: %j',
  async (raw) => {
    const f = await fixture();
    const terminal = terminalReport(f, [{ type: 'finding', ...raw }]);
    const completed = await loadCurrentDeferredVendorDebt(
      f.effects,
      'main',
      f.state,
      f.ledger,
      terminal.client,
    );
    if (!completed?.vendorCompleted) throw new Error('missing raw event completion');
    expect(completed.completion.document.findings).toEqual([{ type: 'finding', ...raw }]);
    expect(deferredReceiptFindings([completed])[0]!.severity).toBe(raw.severity);
  },
);
test.each([
  { severity: 'unknown', comment: 'unknown severity must block' },
  { severity: 'major', comment: { malformed: true } },
  {
    severity: 'major',
    codegenInstructions: { malformed: true },
    comment: 'cannot hide malformed primary text',
  },
  { severity: 'major', comment: '' },
])('refuses unknown or malformed raw finding and retains pending debt: %j', async (raw) => {
  const f = await fixture();
  const terminal = terminalReport(f, [{ type: 'finding', ...raw }]);
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, terminal.client),
  ).rejects.toThrow('genuine complete');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(f.ledger);
});
