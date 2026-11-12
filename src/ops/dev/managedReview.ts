// S2b-i: the queue is the only managed CodeRabbit launch route (spec §11).
// The `dev.review` cycle's `coderabbit` path and `review.run`'s CodeRabbit leg
// submit the pinned (base, head) to review-v1 and wait for the queued review
// instead of spawning the CLI. An unsupported server is REPORTED (needs-human),
// never worked around with a direct CLI fallback. Human-run CLI commands are not
// policed by this module.
//
// The submit-wait-fetch leg reuses the S1d-tested ops (submit, status, result)
// over an injected transport — no wire or chunk logic is reimplemented here.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevEffects } from './effects.js';
import { faultText } from './effects.js';
import { captureWorkingTree } from './internal/snapshot.js';
import { CLEAN_TREE, type WorkState } from './internal/workState.js';
import type { DevCycleRecord, DevFinding } from './record.js';
import { evidenceRoot, git } from '../review/internal/localReview.js';
import type { QueueTransport } from '../review/internal/queueProtocol.js';
import { ReceiptSchema } from '../review/internal/reviewOperation.js';
import { makeSubmit } from '../review/submit.js';
import { makeStatus } from '../review/status.js';
import { makeResult } from '../review/result.js';

/** Inert production binding; resolve forge identity in each actual checkout. */
export function makeConfiguredManagedReviewSubmit(): ManagedReviewSubmit {
  return async (input) => {
    const [{ currentCqEnv }, queue, { makeGhRunner }] = await Promise.all([
      import('../../config/run-env.js'),
      import('../review/internal/queueClient.js'),
      import('../../adapters/forge-github/gh.js'),
    ]);
    return makeManagedReviewSubmit(
      () => {
        const alias = currentCqEnv().values['CQ_QUEUE_SSH_ALIAS'];
        if (typeof alias !== 'string' || alias === '')
          throw new queue.QueueConfigurationError('Configure CQ_QUEUE_SSH_ALIAS for review-v1');
        return queue.sshQueueTransport(alias, 'review-v1');
      },
      async () => {
        const result = await makeGhRunner({ cwd: input.cwd, timeoutMs: 30_000 })([
          'repo',
          'view',
          '--json',
          'nameWithOwner',
          '--jq',
          '.nameWithOwner',
        ]);
        const repo = result.stdout.trim();
        if (result.code !== 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
          throw new Error('gh repo view could not resolve a valid owner/repository identity');
        return repo;
      },
    )(input);
  };
}

async function advertisedHead(cwd: string, head: string): Promise<boolean> {
  try {
    for (const line of (await git(cwd, 'ls-remote', '--heads', 'origin')).split('\n')) {
      const oid = line.split(/\s+/)[0];
      if (!oid || !/^[0-9a-f]{40}$/.test(oid)) continue;
      try {
        if ((await git(cwd, 'merge-base', head, oid)) === head) return true;
      } catch {
        /* Remote-only objects cannot prove local ancestry. */
      }
    }
  } catch {
    /* Offline is not proof of publication. */
  }
  return false;
}

/**
 * The S1d ops enrich the wire response with local fields (exclusions,
 * reviewedHead, message, receipt bindings), so this leg narrows the op
 * values at runtime instead of reusing the wire union.
 */
type QueueValue = Record<string, unknown>;

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

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
    /** Final disk capture; base is the review comparison, head remains the author's HEAD. */
    workingTree?: 'full' | 'uncommitted';
    /** Recheck the scanned workstate immediately before queue admission. */
    beforeSubmit?: () => Promise<void>;
    signal?: AbortSignal;
    remainingWallMs?: () => number;
    /**
     * How the runner proves the pinned commits: an absolute scanner
     * executable producing the original-commit snapshot for unpublished
     * work, or an explicit reachable-ref proof. When both are absent, the
     * seam checks origin's advertised heads for ancestry; unpublished or
     * offline work uses CQ_AUTHOR_SNAPSHOT_SCANNER. Local tracking refs
     * alone do not prove reachability. The server verifies every fact and refuses
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
 * The request id hashes the repository, target and full base/head identities: a re-run after a lost
 * response or a crash rejoins the same queue item instead of spending a
 * second review (the submit op persists the request; the server dedups).
 */
export function makeManagedReviewSubmit(
  getTransport: () => QueueTransport,
  resolveRepo: () => Promise<string>,
): ManagedReviewSubmit {
  return async (input) => {
    if (input.signal?.aborted || (input.remainingWallMs?.() ?? Infinity) <= 0)
      return { status: 'refused', reason: 'the review wall budget expired before submission' };
    let transport: QueueTransport;
    try {
      const send = getTransport();
      let capabilities: Promise<string> | undefined;
      transport = (request, options) => {
        const wire = JSON.parse(request) as { op?: string };
        if (wire.op === 'capabilities') return (capabilities ??= send(request, options));
        return send(request, options);
      };
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
    let reviewedHead = input.head;
    let capturedIndexTree: string | undefined;
    const projection =
      input.workingTree === undefined
        ? 'full-diff'
        : input.workingTree === 'full'
          ? 'working-tree-full-v1'
          : 'working-tree-uncommitted-v1';
    if (input.workingTree !== undefined) {
      try {
        const captured = await captureWorkingTree(input.cwd, input.head);
        // A staged reversal can be dirty while its final disk tree has no diff.
        // It has been scanned by the caller, but earns no vendor coverage.
        if (captured.tree === (await git(input.cwd, 'rev-parse', input.base + '^{tree}')))
          return {
            status: 'refused',
            reason:
              'no reviewable final working-tree diff — no vendor review or coverage was produced',
          };
        reviewedHead = captured.head;
        capturedIndexTree = captured.stagedTree;
      } catch (error) {
        return {
          status: 'refused',
          reason: `working-tree snapshot capture refused — ${faultText(error)}`,
        };
      }
    }
    const requestId = `dev-${createHash('sha256')
      .update(
        JSON.stringify(
          input.workingTree === undefined
            ? [repo, input.target, input.base, input.head]
            : [repo, input.target, input.base, reviewedHead, projection],
        ),
      )
      .digest('hex')}`;
    // Check the actual forge remote rather than trusting stale tracking refs.
    // The server still resolves and verifies every claimed object.
    let reachable = input.workingTree === undefined ? input.reachable : false;
    if (input.workingTree === 'uncommitted' && !(await advertisedHead(input.cwd, input.head)))
      return {
        status: 'refused',
        reason:
          'uncommitted scope requires HEAD published on origin and fetched by the runner — publish HEAD and wait for the runner fetch, or use full scope',
      };
    if (reachable === undefined && input.scanner === undefined)
      reachable = await advertisedHead(input.cwd, input.head);
    const submitted = await makeSubmit(transport, async () => {
      input.signal?.throwIfAborted();
      if ((input.remainingWallMs?.() ?? Infinity) <= 0)
        throw new Error('review wall budget exhausted before admission');
      await input.beforeSubmit?.();
      if (input.workingTree !== undefined) {
        const current = await captureWorkingTree(input.cwd, input.head);
        if (current.head !== reviewedHead || current.stagedTree !== capturedIndexTree)
          throw new Error(
            'working-tree contents changed during snapshot capture or scan — re-run on a stable tree',
          );
      }
      if ((await git(input.cwd, 'rev-parse', 'HEAD')) !== input.head)
        throw new Error('HEAD changed during snapshot capture or scan');
      if (input.signal?.aborted || (input.remainingWallMs?.() ?? Infinity) <= 0)
        throw new Error('review cancelled or wall budget exhausted before admission');
    })({
      cwd: input.cwd,
      repo,
      target: input.target,
      base: input.base,
      head: reviewedHead,
      projection,
      requestId,
      // Advertised remote ancestry selects reachable proof; unpublished work
      // requires the original-commit snapshot scanner. Server facts are authoritative.
      ...(input.scanner !== undefined ? { scanner: input.scanner } : {}),
      ...(reachable !== undefined ? { reachable } : {}),
    });
    if (submitted.status !== 'ok') {
      const refusal = opRefused('submit', submitted);
      if (
        input.workingTree === 'uncommitted' &&
        refusal.status === 'refused' &&
        refusal.reason.includes('snapshot Git operation refused')
      )
        return {
          ...refusal,
          reason: `${refusal.reason} — confirm the runner has fetched published HEAD ${input.head}; wait for its next fetch or use full scope`,
        };
      return refusal;
    }
    if (typeof submitted.value !== 'object' || submitted.value === null)
      return { status: 'refused', reason: 'queue admission returned no state' };
    const admission: QueueValue = submitted.value as QueueValue;
    if (admission['action'] === 'no-changes')
      return { status: 'refused', reason: 'the queue saw no committed changes to review' };
    const admissionState = queueState(admission);
    if (admissionState === undefined) {
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
      admission['reviewedHead'] !== reviewedHead
    )
      return {
        status: 'refused',
        reason: `the queue admitted a different head than pinned (admitted ${String(admission['reviewedHead'])}, pinned ${reviewedHead}) — re-run on a stable tree`,
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
        })()} — retry explicitly with cq review.submit --repo=${shellArgument(repo)} --target=${shellArgument(input.target)} --base=${input.base} --head=${reviewedHead}${input.workingTree === undefined ? '' : ` --projection=${projection}`}${reachable === true ? ' --reachable' : ''}${input.scanner === undefined ? '' : ` --scanner=${shellArgument(input.scanner)}`} --repeat --requestId=${randomUUID()}`,
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
    if (typeof value['reviewedHead'] !== 'string' || value['reviewedHead'] !== reviewedHead)
      return {
        status: 'refused',
        reason: `the queued receipt covers a different head than pinned (receipt ${String(value['reviewedHead'])}, pinned ${reviewedHead})`,
      };
    if (value['scopeAdequate'] === false)
      return {
        status: 'refused',
        reason: `the queued review completed with inadequate scope (receipt ${value['receipt_id'] as string})`,
      };
    let document: ReturnType<typeof ReceiptSchema.parse>;
    try {
      const root = await evidenceRoot(input.cwd);
      document = ReceiptSchema.parse(
        JSON.parse(
          await readFile(
            join(root, '.cq/queue-evidence/results', value['receipt_id'] as string, 'receipt.json'),
            'utf8',
          ),
        ),
      );
    } catch (error) {
      return {
        status: 'refused',
        reason: `the queued receipt could not be read back — ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (
      document.identity_inputs.repo !== repo ||
      document.identity_inputs.base_commit !== input.base ||
      document.identity_inputs.head_commit !== reviewedHead ||
      document.identity_inputs.projection !== projection
    )
      return {
        status: 'refused',
        reason: 'the queued receipt covers different review inputs than submitted',
      };
    const { findings } = mapReceiptFindings(document);
    return {
      status: 'completed',
      value: {
        receiptId: value['receipt_id'] as string,
        completion: mapReceiptOutcome(value['reviewOutcome']),
        findings,
        advisories: [
          ...new Set(
            [admission, terminal.value, value].flatMap((row) => {
              const notices = Array.isArray(row['advisories'])
                ? row['advisories'].filter((notice): notice is string => typeof notice === 'string')
                : [];
              const notify = row['notify'];
              if (
                typeof notify === 'object' &&
                notify !== null &&
                'state' in notify &&
                notify.state === 'error'
              )
                notices.push(
                  `queue completion notification failed${'reason' in notify && typeof notify.reason === 'string' ? ` — ${notify.reason}` : ''}`,
                );
              return notices;
            }),
          ),
        ],
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
  let outcome: ManagedReviewOutcome;
  try {
    signal?.throwIfAborted();
    await refuseDrift('before the managed review submission');
    outcome = await submit({
      cwd,
      target,
      base: scope === 'uncommitted' ? state.head : state.base,
      head: state.head,
      beforeSubmit: () => refuseDrift('during working-tree snapshot capture'),
      ...(state.dirtySha256 !== CLEAN_TREE || scope === 'uncommitted'
        ? { workingTree: scope }
        : {}),
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
  // This is receipt retention after paid work, not dispatch. Do not cancel
  // lock acquisition: a late parent abort must not discard the settled result.
  let span: ManagedSpan | undefined;
  let budgetStopped = false;
  try {
    await effects.withHostLock(async () => {
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
        completion:
          budgetStopped || (signal?.aborted && value.completion.kind === 'terminal')
            ? {
                kind: 'blocked',
                reason: `review cancelled or wall budget exhausted before the managed receipt could be recorded — ${value.receiptId}`,
              }
            : value.completion,
        findings: value.findings,
        ...(value.advisories.length > 0 ? { advisories: value.advisories } : {}),
        logPath,
        ...(logSha256 === undefined ? {} : { logSha256 }),
        untracked: state.untracked,
        at,
      };
    });
  } catch (error) {
    return { ok: false, reason: `the managed review cycle could not run — ${faultText(error)}` };
  }
  if (span === undefined)
    return { ok: false, reason: 'the managed review cycle produced no record' };
  return budgetStopped ? { ok: true, span, budgetStopped: true as const } : { ok: true, span };
}
