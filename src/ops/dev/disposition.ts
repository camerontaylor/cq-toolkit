// Dev lane — `dev.disposition`: the author's recorded adjudication of one
// finding (strategy §3, disposition row). Judgement stays short and
// RECORDED (strategy §2.6): the verb set is exactly fixed|rejected|deferred,
// the reason is mandatory, and the record lands in the branch dev-record.
//
//   - `fixed` — the finding was addressed in the diff;
//   - `rejected` — a false positive; `why` carries the CONCRETE reason
//     (the mechanism that makes the finding wrong), not a shrug;
//   - `deferred` — a real, accepted-for-now finding; `why` names WHERE it
//     is tracked. A deferral never closes a blocking finding — dev.ready
//     still refuses readiness while one is open.
//
// THE FINDING MUST EXIST: the findingId is checked against every cycle in
// the branch ledger, so a typo fails naming the recorded ids instead of
// writing an orphan disposition that closes nothing.
import { guardDevOp } from './effects.js';
import type { Op } from '../../kernel/types.js';
import type { DevEffects } from './effects.js';
import { branchFromRevParse, gitOut } from './effects.js';
import {
  DEV_LEDGER_VERSION,
  type DevDispositionRecord,
  objectInputFault,
  repoRootFault,
} from './record.js';

/** Git read wall-clock cap. */
export const GIT_TIMEOUT_MS = 60 * 1000;

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
 * the branch, verify the finding exists, append the disposition under the
 * store mutex.
 */
export function makeDevDisposition(
  effects: DevEffects,
): Op<DevDispositionInput, DevDispositionReport> {
  return guardDevOp('dev.disposition', async (input) => {
    // Library boundary BEFORE any effect: the input itself, then every
    // required field — a schema-bypassing SDK caller gets the `failed`
    // taxonomy for a missing/ill-typed findingId, action or why (never a
    // TypeError at the field read), and an off-verb set action can never
    // reach the store, where it would break every later ledger parse.
    const objectFault = objectInputFault(input);
    if (objectFault !== null) return { status: 'failed', error: `dev.disposition: ${objectFault}` };
    const rootFault = repoRootFault(input.repoRoot);
    if (rootFault !== null) return { status: 'failed', error: `dev.disposition: ${rootFault}` };
    if (typeof input.findingId !== 'string' || input.findingId === '') {
      return {
        status: 'failed',
        error:
          'dev.disposition: findingId must be a non-empty string — the id a dev.review cycle recorded',
      };
    }
    if (input.action !== 'fixed' && input.action !== 'rejected' && input.action !== 'deferred') {
      return {
        status: 'failed',
        error: `dev.disposition: action must be one of 'fixed' | 'rejected' | 'deferred', got '${String(
          input.action,
        )}'`,
      };
    }
    if (typeof input.why !== 'string') {
      return {
        status: 'failed',
        error:
          'dev.disposition: why must be a string — the mandatory reason, fix note, or deferral pointer',
      };
    }
    const why = input.why.trim();
    if (why === '') {
      return {
        status: 'failed',
        error:
          'dev.disposition: the reason is mandatory — name the fix, the concrete false-positive mechanism, or where the deferral is tracked',
      };
    }

    const branch = branchFromRevParse(
      await effects.runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    if (branch === null) {
      return {
        status: 'needs-human',
        reason:
          'dev.disposition records evidence per branch and HEAD is detached — check out a branch and re-run',
      };
    }
    const head = gitOut(
      await effects.runCommand('git', ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }),
    );
    if (head === null) {
      return {
        status: 'needs-human',
        reason: 'git rev-parse HEAD failed — is this a git worktree?',
      };
    }

    let knownFindingIds: string[];
    let store: ReturnType<typeof effects.openLedger>;
    try {
      store = effects.openLedger(branch);
      const ledger = store.load();
      knownFindingIds = ledger.records.flatMap((record) =>
        record.kind === 'cycle' ? record.findings.map((finding) => finding.id) : [],
      );
    } catch (err) {
      return {
        status: 'failed',
        error: `dev.disposition: the branch dev-record could not be read — ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (!knownFindingIds.includes(input.findingId)) {
      return {
        status: 'failed',
        error: `dev.disposition: unknown finding '${input.findingId}' — the branch ledger records ${String(knownFindingIds.length)} finding id(s); a disposition must name one of them`,
      };
    }

    const at = effects.nowIso();
    try {
      return {
        status: 'ok',
        value: await store.mutate((ledger) => {
          const record: DevDispositionRecord = {
            kind: 'disposition',
            findingId: input.findingId,
            action: input.action,
            why,
            head,
            at,
          };
          return {
            ledger: {
              version: DEV_LEDGER_VERSION,
              branch: ledger.branch,
              records: [...ledger.records, record],
            },
            value: record,
          };
        }),
      };
    } catch (err) {
      return {
        status: 'failed',
        error: `dev.disposition: the record could not be persisted — ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  });
}
