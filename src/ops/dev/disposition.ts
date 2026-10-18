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
    const symbolic = await git(effects, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (symbolic.exitCode === 1) {
      return {
        status: 'needs-human',
        reason:
          'dev.disposition: HEAD is detached — dev records are kept per branch; check out a branch and re-run',
      };
    }
    const branch = gitStdout(symbolic, 'symbolic-ref HEAD').trim();
    const head = gitStdout(
      await git(effects, ['rev-parse', '--verify', 'HEAD']),
      'rev-parse HEAD',
    ).trim();
    const store = effects.openLedger(branch);
    const known = store
      .load()
      .records.some(
        (entry) =>
          entry.kind === 'cycle' &&
          entry.findings.some((finding) => finding.id === input.findingId),
      );
    if (!known) {
      return {
        status: 'failed',
        error: `dev.disposition: unknown finding '${input.findingId}' — a disposition must name a finding a dev.review cycle recorded on this branch`,
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
