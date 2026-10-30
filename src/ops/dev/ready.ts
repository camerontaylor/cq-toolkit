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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults } from '../analyze/cqConfigDefaults.js';
import type { DevEffects } from './effects.js';
import { guardDevOp } from './effects.js';
import type { DevLedgerFile, DevReadinessRecord, ReadinessGap } from './record.js';
import { DEFAULT_DEV_TARGET, assembleReadiness } from './record.js';
import { DevReadyInputSchema } from './registry.js';
import { readWorkState, type WorkState } from './internal/workState.js';
import { loadCurrentDeferredVendorDebt } from './internal/deferredLedger.js';
import type { DeferredQueueClient } from '../review/internal/queueProtocol.js';

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
export type { ReadinessGap } from './record.js';

/**
 * Read the CURRENT state, load the branch ledger, and assemble readiness —
 * the shared core of dev.ready and pr.open. Not ready (or unreadable) is a
 * needs-human result naming every gap.
 */
export async function readReadiness(
  effects: DevEffects,
  name: string,
  target: string,
  policy?: { reviewers: readonly string[]; blockingSeverities: readonly string[] },
): Promise<{ ok: true; read: ReadinessRead } | { ok: false; result: OpResult<never> }> {
  const read = await readReadinessWithGaps(effects, name, target, policy);
  if (!read.ok) return { ok: false, result: { status: 'needs-human', reason: read.reason } };
  return read;
}

/**
 * The same assembly with the gaps RECOVERABLE: a not-ready branch resolves
 * with its gap list verbatim instead of a flattened string, so a composition
 * can render the gaps as a draft PR's honest state (dev.cycle) without
 * re-parsing the needs-human reason. `read.ok` is true only when ready.
 */
export async function readReadinessWithGaps(
  effects: DevEffects,
  name: string,
  target: string,
  policy?: { reviewers: readonly string[]; blockingSeverities: readonly string[] },
  queueClient?: DeferredQueueClient,
): Promise<
  | { ok: true; read: ReadinessRead }
  | {
      ok: false;
      reason: string;
      /** Present only when the gaps are a readiness verdict (a readable state). */
      gaps?: readonly ReadinessGap[];
      /** The state the gaps were assembled from (set whenever `gaps` is). */
      state?: WorkState;
      /** The branch ledger the gaps were assembled from (set whenever `gaps` is). */
      ledger?: DevLedgerFile;
    }
> {
  const read = await readWorkState(effects, { target });
  if (!read.ok) return { ok: false, reason: `${name}: ${read.reason}` };
  const { state } = read;
  // A malformed ledger throws; the op boundary names it.
  let ledger = effects.openLedger(state.branch).load();
  const debt = (policy?.reviewers ?? ['coderabbit', 'agent']).includes('coderabbit')
    ? await loadCurrentDeferredVendorDebt(effects, target, state, ledger, queueClient)
    : undefined;
  if (debt !== undefined) ledger = effects.openLedger(state.branch).load();
  const assembled = assembleReadiness({
    branch: state.branch,
    target,
    identity: { base: state.base, head: state.head, dirtySha256: state.dirtySha256 },
    ledger,
    untracked: state.untracked,
    ...(debt === undefined ? {} : { deferredVendorDebt: debt }),
    ...(policy === undefined
      ? {}
      : { configuredReviewers: policy.reviewers, blockingSeverities: policy.blockingSeverities }),
    nowIso: effects.nowIso(),
  });
  if (!assembled.ready) {
    return {
      ok: false,
      reason: `${name}: NOT READY — ${String(assembled.gaps.length)} gap(s): ${assembled.gaps
        .map((gap) => `${gap.field}: ${gap.detail}`)
        .join(' | ')}`,
      gaps: assembled.gaps,
      state,
      ledger,
    };
  }
  return { ok: true, read: { state, ledger, record: assembled.record } };
}

/** Build the `dev.ready` op over injected effects. */
export function makeDevReady(effects: DevEffects): Op<DevReadyInput, DevReadinessRecord> {
  return guardDevOp('dev.ready', DevReadyInputSchema, async (input) => {
    const configText = await readFile(join(input.repoRoot, 'cq.json'), 'utf8').catch(() => null);
    let policy: { reviewers: readonly string[]; blockingSeverities: readonly string[] } | undefined;
    if (configText !== null) {
      const parsed = parseCqConfig(configText, input.repoRoot);
      if (!parsed.ok)
        return { status: 'needs-human', reason: `dev.ready: cq.json — ${parsed.reason}` };
      const packageText = await readFile(join(input.repoRoot, 'package.json'), 'utf8').catch(
        () => '{}',
      );
      let packageName = 'repository';
      try {
        const value: unknown = JSON.parse(packageText);
        if (
          typeof value === 'object' &&
          value !== null &&
          'name' in value &&
          typeof value.name === 'string'
        )
          packageName = value.name;
      } catch {
        /* descriptive fallback only */
      }
      const configured = resolveCqConfigDefaults(parsed.config, { packageName });
      policy = {
        reviewers: configured.review.reviewers,
        blockingSeverities: configured.review.blockingSeverities,
      };
    }
    const ready = await readReadiness(
      effects,
      'dev.ready',
      input.target ?? DEFAULT_DEV_TARGET,
      policy,
    );
    return ready.ok ? { status: 'ok', value: ready.read.record } : ready.result;
  });
}
