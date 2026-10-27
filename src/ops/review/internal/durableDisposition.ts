import type { Finding } from '../findings.js';
import type { DevLedgerFile } from '../../dev/record.js';
import { deferredReceiptFindings } from '../../dev/internal/deferredReview.js';

/** Compare original normalized content, before applying any retained disposition. */
export function sameFindingContent(incoming: Finding, retained: Finding): boolean {
  return (
    incoming.id === retained.id &&
    incoming.source === retained.source &&
    incoming.text === retained.text &&
    incoming.file === retained.file &&
    incoming.line === retained.line &&
    incoming.rule === retained.rule &&
    incoming.severity === retained.severity
  );
}

/**
 * Restore only a disposition backed by earlier, unambiguous original evidence.
 * This projection never changes raw ledger records or grants review coverage.
 */
export function restoreDurableDisposition(finding: Finding, ledger: DevLedgerFile): Finding {
  const { reason: _reason, ...original } = finding;
  const open: Finding = { ...original, status: 'open' };
  let witnessed = false;
  let ambiguous = false;
  let disposition: { status: Finding['status']; reason: string } | undefined;

  const observe = (retained: Finding): void => {
    if (retained.id !== finding.id) return;
    witnessed = true;
    if (!sameFindingContent(finding, retained)) ambiguous = true;
  };

  for (const record of ledger.records) {
    if (record.kind === 'cycle' && record.reviewer !== 'review.address:import') {
      for (const item of record.findings) {
        observe({
          id: item.id,
          source: record.reviewer,
          text: item.excerpt ?? '',
          severity: item.severity,
          ...(item.fileName !== undefined ? { file: item.fileName } : {}),
          status: 'open',
        });
      }
    } else if (record.kind === 'vendor-debt') {
      for (const retained of deferredReceiptFindings([record.debt])) observe(retained);
    } else if (record.kind === 'disposition' && record.findingId === finding.id) {
      disposition =
        witnessed && !ambiguous ? { status: record.action, reason: record.why } : undefined;
    }
  }
  return !ambiguous && disposition ? { ...open, ...disposition } : open;
}
