// S2b-i: the queue is the only managed CodeRabbit launch route (spec §11).
// The `dev.review` cycle's `coderabbit` path and `review.run`'s CodeRabbit leg
// submit the pinned (base, head) to review-v1 and wait for the queued review
// instead of spawning the CLI. An unsupported server is REPORTED (needs-human),
// never worked around with a direct CLI fallback. Human-run CLI commands are not
// policed by this module.
//
// The submit-wait-fetch leg reuses the S1d-tested ops (submit, status, result)
// over an injected transport — no wire or chunk logic is reimplemented here.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevEffects } from './effects.js';
import { faultText } from './effects.js';
import { CLEAN_TREE, type WorkState } from './internal/workState.js';
import type { DevCycleRecord, DevFinding } from './record.js';
import { evidenceRoot } from '../review/internal/localReview.js';
import type { QueueTransport } from '../review/internal/queueProtocol.js';
import { makeSubmit } from '../review/submit.js';
import { makeStatus } from '../review/status.js';
import { makeResult } from '../review/result.js';

/**
 * The S1d ops enrich the wire response with local fields (exclusions,
 * reviewedHead, message, receipt bindings), so this leg narrows the op
 * values at runtime instead of reusing the wire union.
 */
type QueueValue = Record<string, unknown>;

function queueState(value: QueueValue): string | undefined {
  return typeof value['state'] === 'string' ? (value['state'] as string) : undefined;
}

function queueReason(value: QueueValue): string | undefined {
  return typeof value['reason'] === 'string' ? (value['reason'] as string) : undefined;
}

/** Injected managed-route seam: submit, wait, fetch result. */
export interface ManagedReviewSubmit {
  (input: {
    /** Repository root: the evidence dir and the git identity resolve from it. */
    cwd: string;
    target: string;
    base: string;
    head: string;
    signal?: AbortSignal;
    remainingWallMs?: () => number;
    /**
     * How the runner proves the pinned commits: an absolute scanner
     * executable producing the original-commit snapshot for unpublished
     * work, or a caller-attested reachable-ref proof when the caller knows
     * the runner's clone resolves them. Both absent forwards neither — the
     * submit leg takes its own default (snapshot path: explicit scanner,
     * else CQ_AUTHOR_SNAPSHOT_SCANNER, else an honest configuration
     * refusal). The seam never infers reachability from the local
     * checkout: the local machine having the commits says nothing about
     * the queue host. The server re-derives every hashed fact and refuses
     * a mismatch (plan D2), so this is a transport hint, never authority.
     */
    scanner?: string;
    reachable?: boolean;
  }): Promise<ManagedReviewOutcome>;
}

export type ManagedReviewOutcome =
  | { status: 'completed'; value: ManagedReviewValue }
  | { status: 'unsupported'; reason: string }
  // A refused outcome may carry the #509 network class: the queue leg never
  // saw a definite verdict (delivery unknown), so a re-review may retry it —
  // exactly like a dropped CLI connection. Abort and wall-budget stops never
  // set it (the cancelled class), matching the CLI path's guard.
  | { status: 'refused'; reason: string; transient?: true };

export interface ManagedReviewValue {
  /** The queue receipt id (also the findings' evidence binding). */
  receiptId: string;
  /** Terminal CodeRabbit verdict mapped from the receipt outcome. */
  completion: { kind: 'terminal' } | { kind: 'blocked'; reason: string };
  findings: Omit<DevFinding, 'id'>[];
  advisories: string[];
}

/**
 * Map a queue-returned receipt document to the cycle's finding rows. Rows
 * support the same shapes the CLI stream parser emits: the queue harvest
 * writes CLI `finding`-event objects verbatim (severity, fileName, comment,
 * startLine, rule), so the mapping is identical on purpose. A row without a
 * severity word is dropped from the terminal record exactly like a malformed
 * stream line: it can never pass as a clean cycle with the finding exempt
 * from dispositions. The receipt identity is returned for the evidence
 * binding; the receipt's own digest verification happens in the result op.
 */
export function mapReceiptFindings(document: unknown): {
  findings: Omit<DevFinding, 'id'>[];
  receiptId: string;
} {
  const record =
    typeof document === 'object' && document !== null
      ? (document as { identity?: unknown; findings?: unknown })
      : {};
  const receiptId = typeof record.identity === 'string' ? record.identity : '';
  const raw = Array.isArray(record.findings) ? record.findings : [];
  const findings: Omit<DevFinding, 'id'>[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const event = row as Record<string, unknown>;
    const severity = typeof event['severity'] === 'string' ? event['severity'] : undefined;
    if (severity === undefined || severity === '') continue;
    const finding: Omit<DevFinding, 'id'> = { severity };
    if (typeof event['fileName'] === 'string') finding.fileName = event['fileName'];
    const comment = typeof event['comment'] === 'string' ? event['comment'] : undefined;
    const suggestion =
      Array.isArray(event['suggestions']) && typeof event['suggestions'][0] === 'string'
        ? (event['suggestions'][0] as string)
        : undefined;
    const codegen =
      typeof event['codegenInstructions'] === 'string' ? event['codegenInstructions'] : undefined;
    const excerpt = comment ?? suggestion ?? codegen;
    if (excerpt !== undefined) finding.excerpt = excerpt;
    if (
      typeof event['startLine'] === 'number' &&
      Number.isSafeInteger(event['startLine']) &&
      (event['startLine'] as number) > 0
    )
      finding.line = event['startLine'] as number;
    if (typeof event['rule'] === 'string') finding.rule = event['rule'];
    // Bind every finding to the receipt it came from (the vendor-receipt
    // evidence slot), so a later projection can prove provenance.
    if (receiptId !== '') finding.evidence = receiptId;
    findings.push(finding);
  }
  return { findings, receiptId };
}

/** Map the receipt outcome word to the cycle completion. */
export function mapReceiptOutcome(outcome: unknown): ManagedReviewValue['completion'] {
  if (outcome === 'clean' || outcome === 'findings') return { kind: 'terminal' };
  if (outcome === 'no-verdict' || outcome === 'unknown')
    return {
      kind: 'blocked',
      reason: `the queued review ended without a countable verdict (outcome '${String(outcome)}')`,
    };
  return {
    kind: 'blocked',
    reason: `the queued review returned an unrecognized outcome '${String(outcome)}'`,
  };
}

/**
 * One refusal for every non-ok op outcome (failed, needs-human,
 * indeterminate). An indeterminate outcome is delivery-unknown — the queue
 * may or may not have applied the request — so it carries the #509 network
 * class and a re-review may retry it via the deterministic request id.
 */
function opRefused(
  op: string,
  result: { status: string } & Record<string, unknown>,
): Extract<ManagedReviewOutcome, { status: 'refused' }> {
  if (result.status === 'indeterminate' && typeof result['detail'] === 'string')
    return { status: 'refused', reason: `${op} — ${result['detail'] as string}`, transient: true };
  if (result.status === 'failed' && typeof result['error'] === 'string')
    return { status: 'refused', reason: `${op} — ${result['error'] as string}` };
  if (result.status === 'needs-human' && typeof result['reason'] === 'string')
    return { status: 'refused', reason: `${op} — ${result['reason'] as string}` };
  return { status: 'refused', reason: `${op} — unexpected ${result.status} outcome` };
}

/**
 * Default submit-wait-fetch leg over an injected review-v1 transport. The
 * `repo` (owner/name) comes from the caller, resolved once from the forge;
 * the server re-derives every hashed fact and refuses a mismatch (plan D2),
 * so this value is a routing hint, never authority.
 *
 * The request id is deterministic in (base, head): a re-run after a lost
 * response or a crash rejoins the same queue item instead of spending a
 * second review (the submit op persists the request; the server dedups).
 */
export function makeManagedReviewSubmit(
  getTransport: () => QueueTransport,
  resolveRepo: () => Promise<string>,
): ManagedReviewSubmit {
  return async (input) => {
    let transport: QueueTransport;
    try {
      transport = getTransport();
    } catch (error) {
      return { status: 'unsupported', reason: faultText(error) };
    }
    let repo: string;
    try {
      repo = await resolveRepo();
    } catch (error) {
      return {
        status: 'refused',
        reason: `cannot resolve the forge repository identity — ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const requestId = `dev-${input.base.slice(0, 8)}-${input.head.slice(0, 8)}`;
    const submitted = await makeSubmit(transport)({
      cwd: input.cwd,
      repo,
      target: input.target,
      base: input.base,
      requestId,
      // The submitter declares how the runner proves the pinned commits:
      // a snapshot scanner for unpublished work, or a caller-attested
      // reachable-ref proof when the caller knows the runner's clone
      // resolves them. Both absent forwards neither — the submit leg takes
      // its own default (snapshot path, else an honest configuration
      // refusal). The seam never infers reachability: the local machine
      // having the commits says nothing about the queue host. The server
      // re-derives every hashed fact and refuses a mismatch (plan D2).
      ...(input.scanner !== undefined ? { scanner: input.scanner } : {}),
      ...(input.reachable !== undefined ? { reachable: input.reachable } : {}),
    });
    if (submitted.status !== 'ok') return opRefused('submit', submitted);
    if (typeof submitted.value !== 'object' || submitted.value === null)
      return { status: 'refused', reason: 'queue admission returned no state' };
    const admission: QueueValue = submitted.value as QueueValue;
    const admissionState = queueState(admission);
    if (admissionState === undefined) {
      if ((admission as { action?: unknown }).action === 'no-changes')
        return { status: 'refused', reason: 'the queue saw no committed changes to review' };
      return { status: 'refused', reason: 'queue admission returned no state' };
    }
    if (admissionState === 'unsupported')
      return {
        status: 'unsupported',
        reason: queueReason(admission) ?? 'the queue does not serve this repository',
      };
    if (
      'reviewedHead' in admission &&
      admission['reviewedHead'] !== undefined &&
      admission['reviewedHead'] !== input.head
    )
      return {
        status: 'refused',
        reason: `the queue admitted a different head than pinned (admitted ${String(admission['reviewedHead'])}, pinned ${input.head}) — re-run on a stable tree`,
      };
    // D11 wait: 15 s polls plus or minus 20 % jitter, abortable, against the
    // caller's remaining wall budget (never a second budget).
    const deadline = Date.now() + (input.remainingWallMs?.() ?? 25 * 60 * 1000);
    const terminal = await waitManagedTerminal({
      transport,
      requestId,
      cwd: input.cwd,
      ...(input.signal ? { signal: input.signal } : {}),
      deadline,
      initial: admission,
    });
    if (terminal.status === 'wait-refused')
      return terminal.transient === true
        ? { status: 'refused', reason: terminal.reason, transient: true as const }
        : { status: 'refused', reason: terminal.reason };
    if (terminal.status === 'wait-unsupported')
      return { status: 'unsupported', reason: terminal.reason };
    const finalState = queueState(terminal.value);
    if (finalState === 'failed' || finalState === 'cancelled')
      return {
        status: 'refused',
        reason: `the queued review ended '${finalState}'${(() => {
          const reason = queueReason(terminal.value);
          return reason === undefined ? '' : ` — ${reason}`;
        })()}`,
      };
    const fetched = await makeResult(transport)({ requestId, cwd: input.cwd });
    if (fetched.status !== 'ok') return opRefused('result', fetched);
    if (typeof fetched.value !== 'object' || fetched.value === null)
      return { status: 'refused', reason: 'the queued review has no fetchable receipt' };
    const value: QueueValue = fetched.value as QueueValue;
    const fetchState = queueState(value);
    if (typeof value['receipt_id'] !== 'string')
      return {
        status: 'refused',
        reason: `the queued review has no fetchable receipt (state '${fetchState ?? 'unknown'}')`,
      };
    if (typeof value['reviewedHead'] !== 'string' || value['reviewedHead'] !== input.head)
      return {
        status: 'refused',
        reason: `the queued receipt covers a different head than pinned (receipt ${String(value['reviewedHead'])}, pinned ${input.head})`,
      };
    if (value['scopeAdequate'] === false)
      return {
        status: 'refused',
        reason: `the queued review completed with inadequate scope (receipt ${value['receipt_id'] as string})`,
      };
    let document: unknown;
    try {
      const root = await evidenceRoot(input.cwd);
      document = JSON.parse(
        await readFile(
          join(root, '.cq/queue-evidence/results', value['receipt_id'] as string, 'receipt.json'),
          'utf8',
        ),
      );
    } catch (error) {
      return {
        status: 'refused',
        reason: `the queued receipt could not be read back — ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const { findings } = mapReceiptFindings(document);
    return {
      status: 'completed',
      value: {
        receiptId: value['receipt_id'] as string,
        completion: mapReceiptOutcome(value['reviewOutcome']),
        findings,
        advisories: [],
      },
    };
  };
}

/** A recorded managed span: the cycle record minus its minted cycle id. */
export type ManagedSpan = Omit<DevCycleRecord, 'cycleId' | 'findings'> & {
  findings: Omit<DevFinding, 'id'>[];
};

type WaitTerminal =
  | { status: 'wait-terminal'; value: QueueValue }
  | { status: 'wait-refused'; reason: string; transient?: true }
  | { status: 'wait-unsupported'; reason: string };

/**
 * Poll status until the admission leaves queued/running. The initial
 * admission may already be terminal (reused/joined-completed). Every exit
 * carries the last known state or the reason the wait stopped.
 */
async function waitManagedTerminal(options: {
  transport: QueueTransport;
  requestId: string;
  cwd: string;
  signal?: AbortSignal;
  deadline: number;
  initial: QueueValue;
}): Promise<WaitTerminal> {
  const { transport, requestId, cwd, signal, deadline, initial } = options;
  const opened = queueState(initial);
  if (opened !== 'queued' && opened !== 'running')
    return { status: 'wait-terminal', value: initial };
  let state = opened;
  for (;;) {
    if (signal?.aborted)
      return {
        status: 'wait-refused',
        reason: 'review cancelled or wall budget exhausted while waiting for the queued review',
      };
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return {
        status: 'wait-refused',
        reason: `the queued review did not complete within the wall budget (still '${state}') — re-run review.submit with requestId=${requestId} to rejoin it`,
      };
    await new Promise<void>((resolve) => {
      const waitMs = Math.min(remaining, 15000 * (0.8 + Math.random() * 0.4));
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, waitMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    if (signal?.aborted)
      return {
        status: 'wait-refused',
        reason: 'review cancelled or wall budget exhausted while waiting for the queued review',
      };
    if (Date.now() >= deadline)
      return {
        status: 'wait-refused',
        reason: `the queued review did not complete within the wall budget (still '${state}') — re-run review.submit with requestId=${requestId} to rejoin it`,
      };
    const probed = await makeStatus(transport)({ requestId, cwd });
    if (probed.status !== 'ok') {
      const refused = opRefused('status', probed);
      return refused.transient === true
        ? { status: 'wait-refused', reason: refused.reason, transient: true as const }
        : { status: 'wait-refused', reason: refused.reason };
    }
    if (typeof probed.value !== 'object' || probed.value === null)
      return { status: 'wait-refused', reason: 'queue status returned no state' };
    const current: QueueValue = probed.value as QueueValue;
    const currentState = queueState(current);
    if (currentState === undefined)
      return { status: 'wait-refused', reason: 'queue status returned no state' };
    if (currentState === 'unsupported')
      return {
        status: 'wait-unsupported',
        reason: queueReason(current) ?? 'the queue does not serve this repository',
      };
    state = currentState;
    if (state !== 'queued' && state !== 'running')
      return { status: 'wait-terminal', value: current };
  }
}

/**
 * The S2b-i managed CodeRabbit span: submit the pinned (base, head) to the
 * queue and record the queued review's receipt as the cycle record. The
 * secret scan, reuse check and drift guards belong to the caller and run
 * before this span exactly as they did for the CLI path.
 */
export async function runManagedReviewSpan(options: {
  effects: DevEffects;
  state: WorkState;
  target: string;
  scope: 'full' | 'uncommitted';
  reviewer: string;
  at: string;
  cwd: string;
  submit: ManagedReviewSubmit;
  signal?: AbortSignal;
  remainingWallMs?: () => number;
  /**
   * Snapshot proof for unpublished commits, forwarded to the submit leg:
   * an absolute scanner executable, or a caller-attested reachable-ref
   * proof. Both absent forwards neither — the submit leg takes its own
   * snapshot default (else an honest configuration refusal). The span
   * never infers reachability. The server re-derives every hashed fact
   * and refuses a mismatch (plan D2), so this is a transport hint, never
   * authority.
   */
  scanner?: string;
  reachable?: boolean;
  refuseDrift: (when: string) => Promise<void>;
}): Promise<
  | { ok: true; span: ManagedSpan; budgetStopped?: true }
  | { ok: false; reason: string; transient?: true }
> {
  const {
    effects,
    state,
    target,
    scope,
    reviewer,
    at,
    cwd,
    submit,
    signal,
    remainingWallMs,
    scanner,
    reachable,
    refuseDrift,
  } = options;
  // The queue review attests committed objects only (base..head trees). The
  // CLI path reviewed the same committed range; a dirty tree at submit is a
  // refusal, never an over-claim, so the recorded identity stays clean.
  if (state.dirtySha256 !== CLEAN_TREE)
    return {
      ok: false,
      reason:
        'the working tree has uncommitted changes — commit or stash them before the managed review (the queue attests committed objects only)',
    };
  let outcome: ManagedReviewOutcome;
  try {
    signal?.throwIfAborted();
    await refuseDrift('before the managed review submission');
    outcome = await submit({
      cwd,
      target,
      base: state.base,
      head: state.head,
      ...(signal ? { signal } : {}),
      ...(remainingWallMs ? { remainingWallMs } : {}),
      // Snapshot proof for unpublished work rides through; both absent
      // forwards neither, so the submit leg takes its honest snapshot
      // default instead of a silent reachable inference.
      ...(scanner !== undefined ? { scanner } : {}),
      ...(reachable !== undefined ? { reachable } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `the managed review submission could not run — ${faultText(error)}`,
    };
  }
  if (outcome.status === 'unsupported')
    return {
      ok: false,
      reason: `the queue does not serve managed reviews (${outcome.reason}) — configure CQ_QUEUE_SSH_ALIAS for a review-v1 runner; no direct CLI fallback`,
    };
  if (outcome.status === 'refused')
    return outcome.transient === true
      ? { ok: false, reason: outcome.reason, transient: true as const }
      : { ok: false, reason: outcome.reason };
  const value = outcome.value;
  // Record under the host lock like the CLI span, with the same drift guard,
  // so the cycle describes the tree the submission pinned. The budget class
  // rides OUT of band (never inside the persisted span): the caller attaches
  // the envelope to its report exactly like the CLI path's span does.
  let span: ManagedSpan | undefined;
  let budgetStopped = false;
  try {
    await effects.withHostLock(async () => {
      signal?.throwIfAborted();
      await refuseDrift('during the managed review run');
      // #532/#534: a completed TERMINAL receipt after the caller's wall expired is
      // a budget stop, not a reviewer verdict — mirroring the CLI path's
      // single-shared-wall-sample rule. An explicit blocked verdict survives
      // budget attribution like a CLI stream refusal: it is the queue's own
      // verdict, not a deadline kill. One live-budget decision covers the
      // completion, read after the log write like the CLI path.
      const wallRemainingMs = remainingWallMs?.() ?? Infinity;
      budgetStopped =
        !signal?.aborted && wallRemainingMs <= 0 && value.completion.kind === 'terminal';
      const logPath = await effects.writeReviewLog(
        state.branch,
        `${Date.now()}`,
        [
          '# dev.review managed cycle log',
          `reviewer: ${reviewer}`,
          'route: queue review-v1 (no direct CLI fallback)',
          `base: ${state.base}`,
          `head: ${state.head}`,
          `dirtySha256: ${state.dirtySha256}`,
          `scope: ${scope}`,
          `receipt: ${value.receiptId}`,
          `completion: ${value.completion.kind}`,
          ...(value.completion.kind === 'blocked' ? [`reason: ${value.completion.reason}`] : []),
          `findings: ${String(value.findings.length)}`,
          `at: ${at}`,
          '',
        ].join('\n'),
      );
      let logSha256: string | undefined;
      try {
        logSha256 = await effects.reviewLogSha256?.(logPath);
      } catch {
        // The retained artifact is re-checked before any later reuse.
      }
      span = {
        kind: 'cycle',
        reviewer,
        scope,
        target,
        base: state.base,
        head: state.head,
        dirtySha256: state.dirtySha256,
        completion: budgetStopped
          ? {
              kind: 'blocked',
              reason: `review wall budget exhausted before the managed receipt could be recorded — ${value.receiptId}`,
            }
          : value.completion,
        findings: value.findings,
        ...(value.advisories.length > 0 ? { advisories: value.advisories } : {}),
        logPath,
        ...(logSha256 === undefined ? {} : { logSha256 }),
        untracked: state.untracked,
        at,
      };
    }, signal);
  } catch (error) {
    return { ok: false, reason: `the managed review cycle could not run — ${faultText(error)}` };
  }
  if (span === undefined)
    return { ok: false, reason: 'the managed review cycle produced no record' };
  return budgetStopped ? { ok: true, span, budgetStopped: true as const } : { ok: true, span };
}
