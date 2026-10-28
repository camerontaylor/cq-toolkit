// Dev lane — `dev.disposition`: the author's recorded adjudication of one
// finding (strategy §3, disposition row). Judgement stays short and
// RECORDED (strategy §2.6): the verb set is exactly fixed|rejected|deferred,
// the reason is mandatory, and the record lands in the branch dev-record.
//
//   - `fixed` — the finding was addressed in the diff;
//   - `rejected` — a false positive; `why` carries the CONCRETE reason;
//   - `deferred` — a real, accepted-for-now finding; `why` names WHERE it
//     is tracked. A deferral never closes a blocking finding.
//
// THE FINDING MUST EXIST: the findingId is checked against every cycle in
// the branch ledger, so a typo fails instead of writing an orphan
// disposition that closes nothing.
import type { Op } from '../../kernel/types.js';
import type { DevEffects } from './effects.js';
import { faultText, guardDevOp } from './effects.js';
import { DEV_LEDGER_VERSION, type DevDispositionRecord } from './record.js';
import { DevDispositionInputSchema } from './registry.js';
import { deferredReceiptFindings } from './internal/deferredReview.js';
import { readQueueEvidence } from '../review/internal/queueEvidence.js';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { git, gitStdout } from './internal/workState.js';

/** Input of the `dev.disposition` op (plain JSON; the registry schema mirrors it). */
export interface DevDispositionInput {
  /** Repository the branch ledger lives in. */
  repoRoot: string;
  /** The finding's id, exactly as a dev.review cycle recorded it. */
  findingId: string;
  /** The adjudication verb. */
  action: 'fixed' | 'rejected' | 'deferred';
  /** The mandatory reason / fix note / deferral pointer. */
  why: string;
}

/** The recorded disposition — the op's ok value. */
export type DevDispositionReport = DevDispositionRecord;

/**
 * Build the `dev.disposition` op over injected effects. Per call: resolve
 * the branch, verify the finding exists, append under the store mutex.
 */
export function makeDevDisposition(
  effects: DevEffects,
): Op<DevDispositionInput, DevDispositionReport> {
  return guardDevOp('dev.disposition', DevDispositionInputSchema, async (input) => {
    const symbolic = await git(effects, ['symbolic-ref', '--quiet', 'HEAD']);
    if (symbolic.exitCode === 1) {
      return {
        status: 'needs-human',
        reason:
          'dev.disposition: HEAD is detached — dev records are kept per branch; check out a branch and re-run',
      };
    }
    const branchRef = gitStdout(symbolic, 'symbolic-ref HEAD').trim();
    if (!branchRef.startsWith('refs/heads/') || branchRef.length === 'refs/heads/'.length)
      return {
        status: 'needs-human',
        reason: 'dev.disposition: HEAD does not name a local branch ref',
      };
    // Match admission and re-review identity even when refs/<branch> makes --short ambiguous.
    const branch = branchRef.slice('refs/heads/'.length);
    const head = gitStdout(
      await git(effects, ['rev-parse', '--verify', 'HEAD']),
      'rev-parse HEAD',
    ).trim();
    const store = effects.openLedger(branch);
    const retained = store.load();
    const known =
      retained.records.some(
        (entry) =>
          entry.kind === 'cycle' &&
          entry.findings.some((finding) => finding.id === input.findingId),
      ) ||
      deferredReceiptFindings(
        retained.records.filter((entry) => entry.kind === 'vendor-debt').map((entry) => entry.debt),
      ).some((finding) => finding.id === input.findingId);
    if (!known) {
      return {
        status: 'failed',
        error: `dev.disposition: unknown finding '${input.findingId}' — a disposition must name a cycle finding or a verified imported receipt finding on this branch`,
      };
    }
    const imported = retained.records.find(
      (entry) =>
        entry.kind === 'vendor-debt' &&
        entry.debt.vendorCompleted &&
        deferredReceiptFindings([entry.debt]).some((finding) => finding.id === input.findingId),
    );
    if (imported?.kind === 'vendor-debt' && imported.debt.vendorCompleted) {
      const root = gitStdout(
        await git(effects, ['rev-parse', '--show-toplevel']),
        'repository root',
      ).trim();
      const evidence = await readQueueEvidence(
        join(root, '.cq', 'queue-evidence'),
        imported.debt.completion.receiptId,
      );
      if (!isDeepStrictEqual(evidence, imported.debt.completion))
        return {
          status: 'failed',
          error: 'dev.disposition: imported receipt differs from verified immutable bytes',
        };
    }
    const record: DevDispositionRecord = {
      kind: 'disposition',
      findingId: input.findingId,
      action: input.action,
      why: input.why.trim(),
      head,
      at: effects.nowIso(),
    };
    try {
      return {
        status: 'ok',
        value: await store.mutate((ledger) => ({
          ledger: {
            version: DEV_LEDGER_VERSION,
            branch: ledger.branch,
            records: [...ledger.records, record],
          },
          value: record,
        })),
      };
    } catch (err) {
      return {
        status: 'failed',
        error: `dev.disposition: the record could not be persisted — ${faultText(err)}`,
      };
    }
  });
}
