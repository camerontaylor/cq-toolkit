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

/**
 * The ledger's retained-finding projection: every ELIGIBLE original witness row — a
 * non-import cycle finding or a verified completed receipt finding — deduped by id,
 * with conflicting content for one id failing closed. Each row carries only the
 * disposition that an eligible witness PRECEDES in ledger order, so a repeated id in a
 * `review.address:import` cycle can never lend authority to a later original finding.
 * The raw ledger is never rewritten.
 */
export function retainedFindings(ledger: DevLedgerFile): Finding[] {
  const collected: Finding[] = [
    ...ledger.records
      .filter((record) => record.kind === 'cycle')
      .filter((record) => record.reviewer !== 'review.address:import')
      .flatMap((record) =>
        record.findings.map((finding): Finding => ({
          id: finding.id,
          source: record.reviewer,
          severity: finding.severity,
          text: finding.excerpt ?? '',
          status: 'open',
          ...(finding.fileName !== undefined ? { file: finding.fileName } : {}),
          ...(finding.line !== undefined ? { line: finding.line } : {}),
          ...(finding.rule !== undefined ? { rule: finding.rule } : {}),
          ...(finding.evidence !== undefined ? { evidence: finding.evidence } : {}),
          ...(finding.evidenceV1 !== undefined ? { evidenceV1: finding.evidenceV1 } : {}),
        })),
      ),
    ...deferredReceiptFindings(
      ledger.records.filter((record) => record.kind === 'vendor-debt').map((record) => record.debt),
    ),
  ];
  const byId = new Map<string, Finding>();
  for (const finding of collected) {
    const previous = byId.get(finding.id);
    if (previous !== undefined && !sameFindingContent(previous, finding))
      throw new Error('conflicting retained finding identity');
    byId.set(finding.id, restoreDurableDisposition(finding, ledger));
  }
  return [...byId.values()];
}
