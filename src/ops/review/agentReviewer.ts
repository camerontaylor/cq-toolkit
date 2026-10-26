import type { DriverFactory } from '../../driver/factory.js';
import type { ModelSpec, Usage } from '../../driver/types.js';
import { boundedErrorText } from '../../driver/error-text.js';
import { currentJobContext } from '../../kernel/governor.js';
import type { OpResult } from '../../kernel/types.js';
import type { DiffSecretScanner, ScanComponentInput } from '../dev/denylist.js';
import type { Finding } from './findings.js';
import { createReviewPlan } from './internal/reviewPlan.js';
import {
  isCoverageV2Complete,
  ReviewCoverageV2Schema,
  type ReviewCoverageV2,
} from './internal/reviewCoverageV2.js';
import { runReviewSession, scanReviewUpload } from './internal/reviewSession.js';

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
  session?: { maxInputChars?: number; maxSteps?: number };
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
  signal?: AbortSignal;
  severityMap: { high: string; medium: string; low?: string };
}

export interface AgentReviewReport {
  findings: Finding[];
  usage: number;
  coverage: ReviewCoverageV2;
  advisories: string[];
  limitations: string[];
}
export type AgentReviewResult = OpResult<AgentReviewReport> & { report?: AgentReviewReport };

const totalUsage = (usage: Usage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);

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
  const ensureActive = () => {
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('agent review wall budget exhausted');
  };
  let report: AgentReviewReport | undefined;
  let activeSession: ReviewCoverageV2['sessions'][number] | undefined;
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
      for (const session of plan.sessions) {
        ensureActive();
        if (report.usage >= input.maxTokens)
          return { status: 'budget-exhausted', report: snapshot()! };
        activeSession = {
          id: session.id,
          status: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          deliveries: [],
          requests: [],
        };
        report.coverage.sessions.push(activeSession);
        await scanReviewUpload(input.scanSecrets, [
          { component: 'review-prompt', path: 'review-request.txt', text: session.prompt },
        ]);
        ensureActive();
        const result = await runReviewSession(drivers, {
          repoRoot: input.repoRoot,
          role: input.role,
          severityMap: input.severityMap,
          maxTokens: input.maxTokens - report.usage,
          maxSteps: input.session?.maxSteps ?? 15,
          maxPromptChars: Math.max(20_000, input.session?.maxInputChars ?? 60_000),
          signal: controller.signal,
          scanSecrets: input.scanSecrets,
          components,
          plan: session,
          evidence: activeSession,
          onUsage: (usage) => {
            report!.usage += totalUsage(usage);
          },
          searchTools: input.searchTools ?? true,
        });
        ensureActive();
        if (report.usage > input.maxTokens) activeSession.status = 'budget';
        updatePieces(report.coverage);
        activeSession = undefined;
        if (result.status !== 'ok') {
          const reason = incompleteReason(report.coverage);
          if (result.status === 'budget-exhausted')
            return {
              status: 'needs-human',
              reason: `agent review budget exhausted; ${reason}`,
              report: snapshot()!,
            };
          const detail =
            result.status === 'needs-human'
              ? result.reason
              : result.status === 'failed'
                ? result.error
                : result.status;
          return { status: 'needs-human', reason: `${detail}; ${reason}`, report: snapshot()! };
        }
        for (const finding of result.value) {
          if (
            !report.findings.some(
              (other) =>
                other.file === finding.file &&
                other.line === finding.line &&
                other.rule === finding.rule &&
                other.text === finding.text &&
                other.severity === finding.severity,
            )
          )
            report.findings.push(finding);
        }
        if (report.usage > input.maxTokens)
          return {
            status: 'needs-human',
            reason: `agent review budget exhausted; ${incompleteReason(report.coverage)}`,
            report: snapshot()!,
          };
      }
      ReviewCoverageV2Schema.parse(report.coverage);
      if (!isCoverageV2Complete(report.coverage))
        return {
          status: 'needs-human',
          reason: incompleteReason(report.coverage),
          report: snapshot()!,
        };
      return { status: 'ok', value: snapshot()! };
    };
    const stopped = new Promise<never>((_resolve, reject) => {
      cancelled = () => reject(new Error('agent review cancelled or wall budget exhausted'));
      controller.signal.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(
        () => controller.abort(new Error('agent review wall budget exhausted')),
        Math.max(0, input.wallMs),
      );
    });
    return await Promise.race([work(), stopped]);
  } catch (error) {
    if (activeSession !== undefined)
      activeSession.status = controller.signal.aborted ? 'aborted' : 'error';
    const partial = snapshot();
    return {
      status: 'needs-human',
      reason: `agent review did not run: ${boundedErrorText(error instanceof Error ? error.message : String(error))}${partial ? `; ${incompleteReason(partial.coverage)}` : ''}`,
      ...(partial === undefined ? {} : { report: partial }),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener('abort', relay);
    if (cancelled !== undefined) controller.signal.removeEventListener('abort', cancelled);
  }
}
