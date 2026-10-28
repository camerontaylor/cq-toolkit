import type { Finding } from '../findings.js';
import type { DevLedgerFile } from '../../dev/record.js';
import { deferredReceiptFindings } from '../../dev/internal/deferredReview.js';
import { isDeepStrictEqual } from 'node:util';

// review.run persists this exact reviewer spelling while emitting source 'agent'.
function normalizedSource(source: string): string {
  return source === 'agent:reviewer' ? 'agent' : source;
}

/** Compare original normalized content, before applying any retained disposition. */
export function sameFindingContent(incoming: Finding, retained: Finding): boolean {
  return (
    incoming.id === retained.id &&
    normalizedSource(incoming.source) === normalizedSource(retained.source) &&
    incoming.text === retained.text &&
    incoming.file === retained.file &&
    incoming.line === retained.line &&
    incoming.rule === retained.rule &&
    incoming.severity === retained.severity &&
    // Receipt identity: a finding from a different receipt never inherits this one's
    // disposition. One-sided absence fails closed (legacy absence is unknown).
    incoming.evidence === retained.evidence &&
    // R3S payload: structural equality only. It is carried evidence, never authority,
    // so a validation verdict is compared as data and never re-adjudicated here.
    isDeepStrictEqual(incoming.evidenceV1, retained.evidenceV1)
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
          ...(item.line !== undefined ? { line: item.line } : {}),
          ...(item.rule !== undefined ? { rule: item.rule } : {}),
          ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
          ...(item.evidenceV1 !== undefined ? { evidenceV1: item.evidenceV1 } : {}),
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
