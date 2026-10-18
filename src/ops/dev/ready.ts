// Dev lane — `dev.ready`: assemble the author-tier readiness record from
// dev.check's latest run plus the review ledger (strategy §3, dev.ready
// row). The requirements are the assembly core's (record.ts
// assembleReadiness): one terminal full-scope CodeRabbit cycle at the
// current identity (D-J), zero open blocking findings, a green latest check
// at the current identity, no untracked files.
//
// NOT-READY IS EXIT 3: the gaps are listed in the needs-human reason —
// never a silent pass, never a partial record. Ready returns the record
// whose `evidenceClass: 'author'` and verbatim caveat mark its tier
// (strategy §2.4): the implementor's CLAIM a PR is opened from, not
// verification.
import type { Op, OpResult } from '../../kernel/types.js';
import type { DevEffects } from './effects.js';
import { guardDevOp } from './effects.js';
import type { DevLedgerFile, DevReadinessRecord } from './record.js';
import { DEFAULT_DEV_TARGET, assembleReadiness } from './record.js';
import { DevReadyInputSchema } from './registry.js';
import { readWorkState, type WorkState } from './internal/workState.js';

/** Input of the `dev.ready` op (plain JSON; the registry schema mirrors it). */
export interface DevReadyInput {
  /** Repository the branch ledger lives in. */
  repoRoot: string;
  /** The intended PR target branch (default: the documented queue target). */
  target?: string;
}

/** A ready read: the record and what it was assembled from. */
export interface ReadinessRead {
  state: WorkState;
  ledger: DevLedgerFile;
  record: DevReadinessRecord;
}

/**
 * Read the CURRENT state, load the branch ledger, and assemble readiness —
 * the shared core of dev.ready and pr.open. Not ready (or unreadable) is a
 * needs-human result naming every gap.
 */
export async function readReadiness(
  effects: DevEffects,
  name: string,
  target: string,
): Promise<{ ok: true; read: ReadinessRead } | { ok: false; result: OpResult<never> }> {
  const read = await readWorkState(effects, { target });
  if (!read.ok)
    return { ok: false, result: { status: 'needs-human', reason: `${name}: ${read.reason}` } };
  const { state } = read;
  // A malformed ledger throws; the op boundary names it.
  const ledger = effects.openLedger(state.branch).load();
  const assembled = assembleReadiness({
    branch: state.branch,
    target,
    identity: { base: state.base, head: state.head, dirtySha256: state.dirtySha256 },
    ledger,
    untracked: state.untracked,
    nowIso: effects.nowIso(),
  });
  if (!assembled.ready) {
    return {
      ok: false,
      result: {
        status: 'needs-human',
        reason: `${name}: NOT READY — ${String(assembled.gaps.length)} gap(s): ${assembled.gaps
          .map((gap) => `${gap.field}: ${gap.detail}`)
          .join(' | ')}`,
      },
    };
  }
  return { ok: true, read: { state, ledger, record: assembled.record } };
}

/** Build the `dev.ready` op over injected effects. */
export function makeDevReady(effects: DevEffects): Op<DevReadyInput, DevReadinessRecord> {
  return guardDevOp('dev.ready', DevReadyInputSchema, async (input) => {
    const ready = await readReadiness(effects, 'dev.ready', input.target ?? DEFAULT_DEV_TARGET);
    return ready.ok ? { status: 'ok', value: ready.read.record } : ready.result;
  });
}
