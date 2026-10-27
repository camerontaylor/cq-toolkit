import type { DriverFactory } from '../../driver/factory.js';
import type { ModelSpec } from '../../driver/types.js';
import { boundedErrorText } from '../../driver/error-text.js';
import { currentJobContext } from '../../kernel/governor.js';
import type { OpResult } from '../../kernel/types.js';
import type { DiffSecretScanner, ScanComponentInput } from '../dev/denylist.js';
import type { Finding } from './findings.js';
import { REVIEW_SESSION_DEFAULTS } from '../analyze/cqConfig.js';
import { createReviewPlan } from './internal/reviewPlan.js';
import {
  isCoverageV2Complete,
  ReviewCoverageV2Schema,
  type ReviewCoverageV2,
} from './internal/reviewCoverageV2.js';
import { runReviewSession, scanReviewUpload, totalUsage } from './internal/reviewSession.js';

export interface AgentReviewerInput {
  repoRoot: string;
  head: string;
  branch: string;
  diff: string;
  components?: readonly ScanComponentInput[];
  base?: string;
  scope?: 'full' | 'uncommitted';
  intent?: string;
  fileList?: string;
  priorFindings?: readonly Finding[];
  session?: { maxInputChars?: number; maxSteps?: number; concurrency?: number };
  size?: {
    small?: { maxChangedLines?: number; maxFiles?: number };
    medium?: { maxChangedLines?: number; maxFiles?: number };
  };
  exclude?: readonly { pattern: string; assuredBy?: string }[];
  searchTools?: boolean;
  scanSecrets: DiffSecretScanner;
  role: ModelSpec;
  maxTokens: number;
  wallMs: number;
  /** cq.json `budgets.step.wallMs`: the per-request step bound, capped at the remaining `wallMs`. */
  stepWallMs?: number;
  signal?: AbortSignal;
  severityMap: { high: string; medium: string; low?: string };
}

export interface AgentReviewReport {
  findings: Finding[];
  usage: number;
  coverage: ReviewCoverageV2;
  advisories: string[];
  limitations: string[];
  /**
   * #509: set on a failed review whose every failed session stopped on the
   * driver's `transient` class (network, timeout, 5xx) — the class a caller
   * may retry. Absent otherwise.
   */
  transient?: boolean;
  /** The engine stopped on its own token or wall budget, with no other session failure. */
  budgetExhausted?: true;
  /** An upstream signal interrupted this engine; the caller owns its attribution. */
  cancelled?: true;
}
export type AgentReviewResult = OpResult<AgentReviewReport> & { report?: AgentReviewReport };

/** Fold engine delivery into component states. Failed sessions never prove completion. */
function updatePieces(coverage: ReviewCoverageV2): void {
  for (const piece of coverage.pieces) {
    if (piece.state === 'excluded') continue;
    const rows = coverage.sessions.flatMap((session) =>
      session.deliveries
        .filter((delivery) => delivery.component === piece.component)
        .map((delivery) => ({ session, delivery })),
    );
    const sessionIds = [...new Set(rows.map(({ session }) => session.id))];
    if (sessionIds.length === 1) piece.sessionId = sessionIds[0]!;
    else delete piece.sessionId;
    piece.state = rows.length ? 'delivered' : 'planned';
    let end = 0;
    let complete = rows.length > 0;
    for (const { session, delivery } of rows.sort((a, b) => a.delivery.start - b.delivery.start)) {
      if (session.status !== 'complete' || delivery.start !== end) complete = false;
      end = delivery.end;
    }
    if (complete && end === piece.chars) piece.state = 'completed';
  }
}

function incompleteReason(coverage: ReviewCoverageV2): string {
  const pieces = coverage.pieces
    .filter((piece) => piece.state !== 'completed' && piece.state !== 'excluded')
    .map((piece) => `${piece.path} (${piece.state})`);
  const sessions = coverage.sessions
    .filter((session) => session.status !== 'complete')
    .map((session) => `${session.id} (${session.status})`);
  return `agent review coverage incomplete: ${[...pieces, ...sessions].join(', ') || 'invalid evidence'}`;
}

/** One review budget/deadline covers the session or every fallback partition and repair. */
export async function runAgentReviewer(
  drivers: DriverFactory,
  input: AgentReviewerInput,
): Promise<AgentReviewResult> {
  const signals = [input.signal, currentJobContext()?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.some((signal) => signal.aborted))
    return { status: 'needs-human', reason: 'agent review cancelled before dispatch' };
  const controller = new AbortController();
  const parent = AbortSignal.any(signals);
  const relay = () => controller.abort(parent.reason);
  parent.addEventListener('abort', relay, { once: true });
  const deadline = Date.now() + input.wallMs;
  const wallBudgetError = new Error('agent review wall budget exhausted');
  const cancellationError = new Error('agent review cancelled or wall budget exhausted');
  let nonBudgetFailure = false;
  const ensureActive = () => {
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline) throw wallBudgetError;
  };
  let report: AgentReviewReport | undefined;
  const active = new Set<ReviewCoverageV2['sessions'][number]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled: (() => void) | undefined;
  const snapshot = (): AgentReviewReport | undefined => {
    if (report === undefined) return undefined;
    updatePieces(report.coverage);
    return structuredClone(report);
  };
  try {
    const work = async (): Promise<AgentReviewResult> => {
      ensureActive();
      if (
        !Number.isFinite(input.maxTokens) ||
        input.maxTokens <= 0 ||
        !Number.isFinite(input.wallMs) ||
        input.wallMs <= 0
      )
        return { status: 'budget-exhausted' };
      const originals = input.components ?? [
        { component: 'diff', path: 'review.diff', text: input.diff },
      ];
      const components = (
        originals.length
          ? originals
          : [{ component: 'empty-comparison', path: 'review.diff', text: '' }]
      ).map((component) => Object.freeze({ ...component }));
      if (new Set(components.map((component) => component.component)).size !== components.length)
        throw new Error('agent review component identities must be unique');
      const plan = createReviewPlan({
        head: input.head,
        base: input.base ?? input.head,
        scope: input.scope ?? 'full',
        branch: input.branch,
        components,
        ...(input.intent === undefined ? {} : { intent: input.intent }),
        ...(input.fileList === undefined ? {} : { fileList: input.fileList }),
        ...(input.priorFindings === undefined ? {} : { priorFindings: input.priorFindings }),
        ...(input.session === undefined ? {} : { session: input.session }),
        ...(input.size === undefined ? {} : { size: input.size }),
        ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
      });
      report = {
        findings: [],
        usage: 0,
        coverage: plan.coverage,
        advisories: plan.advisories,
        limitations: plan.limitations,
      };
      // Excluded bytes are retained in local coverage but are never uploaded.
      await scanReviewUpload(
        input.scanSecrets,
        components.filter((component) =>
          plan.coverage.pieces.some(
            (piece) => piece.component === component.component && piece.state !== 'excluded',
          ),
        ),
      );
      ensureActive();
      // Partition sessions are independent, so up to `concurrency` run at once.
      // Results are merged by plan index (deterministic coverage and finding
      // order). Each session reserves a share of the unreserved token allowance
      // until it settles, so replacements cannot reuse promised budget.
      const sessions = plan.sessions;
      const concurrency = Math.max(
        1,
        Math.min(
          input.session?.concurrency ?? REVIEW_SESSION_DEFAULTS.concurrency,
          sessions.length,
        ),
      );
      const outcomes: (Finding[] | undefined)[] = sessions.map(() => undefined);
      let firstFailure: string | undefined;
      let consecutiveFailures = 0;
      // #509: every failed session was the driver's transient class.
      let allFailuresTransient = true;
      let nextIndex = 0;
      let halted = false;
      let budgetStop: 'before' | 'during' | undefined;
      let inFlight = 0;
      let reserved = 0;
      // Findings are rebuilt from the per-session outcomes in plan order every
      // time a session lands, so a later throw or abort still reports them.
      const rebuildFindings = (): void => {
        const merged: Finding[] = [];
        for (const finding of outcomes.flatMap((found) => found ?? [])) {
          if (
            !merged.some(
              (other) =>
                other.file === finding.file &&
                other.line === finding.line &&
                other.rule === finding.rule &&
                other.text === finding.text &&
                other.severity === finding.severity,
            )
          )
            merged.push(finding);
        }
        report!.findings = merged;
      };
      const runOne = async (index: number): Promise<void> => {
        const session = sessions[index]!;
        ensureActive();
        if (report!.usage >= input.maxTokens) {
          budgetStop ??= 'before';
          halted = true;
          return;
        }
        // Reserve this session's allowance out of what no in-flight sibling has
        // already been promised; it is released when the session settles.
        const freeSlots = Math.max(1, concurrency - inFlight);
        const allowance = Math.max(
          1,
          Math.floor((input.maxTokens - report!.usage - reserved) / freeSlots),
        );
        inFlight += 1;
        reserved += allowance;
        const evidence: ReviewCoverageV2['sessions'][number] = {
          id: session.id,
          status: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          deliveries: [],
          requests: [],
        };
        active.add(evidence);
        report!.coverage.sessions.push(evidence);
        let result: Awaited<ReturnType<typeof runReviewSession>>;
        try {
          await scanReviewUpload(input.scanSecrets, [
            { component: 'review-prompt', path: 'review-request.txt', text: session.prompt },
          ]);
          ensureActive();
          result = await runReviewSession(drivers, {
            repoRoot: input.repoRoot,
            role: input.role,
            severityMap: input.severityMap,
            maxTokens: allowance,
            maxSteps: input.session?.maxSteps ?? REVIEW_SESSION_DEFAULTS.maxSteps,
            maxPromptChars: Math.max(
              20_000,
              input.session?.maxInputChars ?? REVIEW_SESSION_DEFAULTS.maxInputChars,
            ),
            signal: controller.signal,
            scanSecrets: input.scanSecrets,
            components,
            plan: session,
            evidence,
            onUsage: (usage) => {
              report!.usage += totalUsage(usage);
            },
            onAdvisories: (advisories) => {
              report!.advisories = [...new Set([...report!.advisories, ...advisories])];
            },
            searchTools: input.searchTools ?? true,
            ...(input.stepWallMs === undefined
              ? {}
              : {
                  stepTimeoutMs: Math.max(
                    1,
                    Math.floor(Math.min(input.stepWallMs, deadline - Date.now())),
                  ),
                }),
          });
        } finally {
          inFlight -= 1;
          reserved -= allowance;
        }
        if (result.status !== 'ok' && result.status !== 'budget-exhausted') nonBudgetFailure = true;
        ensureActive();
        if (report!.usage > input.maxTokens) evidence.status = 'budget';
        updatePieces(report!.coverage);
        active.delete(evidence);
        if (result.status === 'budget-exhausted') {
          budgetStop ??= 'during';
          halted = true;
          return;
        }
        if (result.status !== 'ok') {
          const detail =
            result.status === 'needs-human'
              ? result.reason
              : result.status === 'failed'
                ? result.error
                : result.status;
          // One failed session must not leave the rest unattempted, but two
          // failures in a row (completion order, no success between) mean the
          // provider itself is unhealthy: dispatch nothing further. In-flight
          // sessions finish and keep their evidence.
          firstFailure ??= detail;
          if (!(result.status === 'needs-human' && result.errorClass === 'transient'))
            allFailuresTransient = false;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 2) halted = true;
          return;
        }
        consecutiveFailures = 0;
        outcomes[index] = result.value;
        rebuildFindings();
        if (report!.usage > input.maxTokens) {
          budgetStop ??= 'during';
          halted = true;
        }
      };
      const worker = async (): Promise<void> => {
        while (!halted) {
          const index = nextIndex++;
          if (index >= sessions.length) return;
          try {
            await runOne(index);
          } catch (error) {
            // A hard error (scanner fault, abort) must not let sibling workers
            // keep uploading and spending.
            if (
              error !== wallBudgetError &&
              error !== cancellationError &&
              !(parent.aborted && error === parent.reason)
            )
              nonBudgetFailure = true;
            halted = true;
            throw error;
          }
        }
      };
      // Settle every worker before reading state: an abort rejects them all,
      // and none may mutate the report after the outer snapshot.
      const settled = await Promise.allSettled(Array.from({ length: concurrency }, worker));
      const rejected = settled.find((entry) => entry.status === 'rejected');
      if (rejected !== undefined) throw (rejected as PromiseRejectedResult).reason;
      rebuildFindings();
      updatePieces(report.coverage);
      if (budgetStop === 'before' && firstFailure === undefined)
        return { status: 'budget-exhausted', report: snapshot()! };
      if (budgetStop === 'during' && firstFailure === undefined)
        return {
          status: 'needs-human',
          reason: `agent review budget exhausted; ${incompleteReason(report.coverage)}`,
          report: { ...snapshot()!, budgetExhausted: true },
        };
      ReviewCoverageV2Schema.parse(report.coverage);
      if (firstFailure !== undefined)
        return {
          status: 'needs-human',
          reason: `${firstFailure}; ${incompleteReason(report.coverage)}`,
          report: { ...snapshot()!, ...(allFailuresTransient ? { transient: true } : {}) },
        };
      if (!isCoverageV2Complete(report.coverage))
        return {
          status: 'needs-human',
          reason: incompleteReason(report.coverage),
          report: snapshot()!,
        };
      return { status: 'ok', value: snapshot()! };
    };
    const stopped = new Promise<never>((_resolve, reject) => {
      cancelled = () => reject(cancellationError);
      controller.signal.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => controller.abort(wallBudgetError), Math.max(0, input.wallMs));
    });
    return await Promise.race([work(), stopped]);
  } catch (error) {
    for (const evidence of active)
      evidence.status = controller.signal.aborted ? 'aborted' : 'error';
    const partial = snapshot();
    // A coincident deadline cannot reclassify a scanner/provider exception.
    const interrupted =
      error === cancellationError ||
      error === wallBudgetError ||
      (parent.aborted && error === parent.reason);
    const budgetExhausted =
      !parent.aborted &&
      !nonBudgetFailure &&
      interrupted &&
      (error === wallBudgetError || controller.signal.reason === wallBudgetError);
    return {
      status: 'needs-human',
      reason: `agent review did not run: ${boundedErrorText(error instanceof Error ? error.message : String(error))}${partial ? `; ${incompleteReason(partial.coverage)}` : ''}`,
      ...(partial === undefined
        ? {}
        : {
            report: {
              ...partial,
              ...(budgetExhausted ? { budgetExhausted: true as const } : {}),
              ...(parent.aborted && interrupted && !nonBudgetFailure
                ? { cancelled: true as const }
                : {}),
            },
          }),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener('abort', relay);
    if (cancelled !== undefined) controller.signal.removeEventListener('abort', cancelled);
  }
}
