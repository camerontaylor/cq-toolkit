/**
 * The selection loop of `crq.start_one`: which pending item a tick tries
 * next and how each refusal is recorded. Inactive: nothing binds it to `tick`,
 * `slot` or a unit.
 *
 * Everything that decides ORDER and ELIGIBILITY lives here: policy sort, the
 * background-turn reordering, the `only` filter, the first-capture gate, the
 * rank-4 coverage/backfill routing, natural-only author starts, the optional
 * cycle wait, linked-receipt parking, `not_before` backoff, dependencies, and
 * the routing of planner outcomes (not ready, nothing to review, any other
 * planning error) into item state, log lines and reservation-aware stops.
 *
 * Everything that TOUCHES the world is injected through {@link StartOneEffects}:
 * the per-kind planners (`plan_open`, `plan_delta`, `plan_merged`,
 * `plan_author`, `prepare_current`, push-current and local-review `prepare`),
 * the PR lookup and quiet gate those planners share, `launch`, `coverage_fallback`
 * and the event journal. The caller owns tick.lock and passes the live queue,
 * whose items are mutated in place exactly as Python mutates its dict.
 */
import {
  additionalCycle,
  AUTHOR_KIND,
  backgroundTurn,
  BACKFILL_KIND,
  depsMet,
  liveItems,
  optionalWait,
  rank,
  REVIEW_RECEIPT_KIND,
  sortItems,
  type ScheduleContext,
} from '../policy/crq/tickSchedule.js';
import { parseIso } from '../policy/crq/utc.js';

/** `crq.NotReady`: the item cannot start yet; the message is its wait reason. */
/** A queue document or item that the pass edits in place, as Python edits its dict. */
export type StartRecord = Record<string, unknown>;

export class StartNotReady extends Error {}
/** `crq.NothingToReview`: the item has no reviewable range and is skipped. */
export class StartNothingToReview extends Error {}
/** `author_quota.AuthorRefused`: the author grant was refused at launch. */
export class StartAuthorRefused extends Error {}

export interface StartPlan {
  readonly label: string;
  readonly base: string;
  readonly head: string;
  readonly target: string;
  readonly notes: readonly string[];
}

/**
 * What a per-kind planner may answer besides throwing. `plan: null` is
 * Python's `None` (no vendor start); `logNoStart` reproduces the
 * "(no vendor start)" line only the receipt and push-current kinds write.
 */
export type PlanOutcome =
  | { readonly outcome: 'plan'; readonly plan: StartPlan }
  | { readonly outcome: 'none'; readonly logNoStart: boolean }
  /** PR no longer open before review. The item is marked skipped unless dry. */
  | {
      readonly outcome: 'skipped';
      readonly state: string;
      readonly lastError: string;
      readonly log: string;
    }
  /** Quiet gate (`quiet_reason`): recorded as the wait reason. */
  | { readonly outcome: 'wait'; readonly waitReason: string };

export interface StartOneEffects {
  readonly context: ScheduleContext;
  /** `len(q.get("starts", []))`, read live. */
  startsCount(): number;
  /** Dispatch on `item.kind` to the matching Python planner. */
  planItem(item: StartRecord): Promise<PlanOutcome>;
  /** `launch(q, item, plan)`: the run id. May throw {@link StartAuthorRefused}. */
  launch(item: StartRecord, plan: StartPlan): Promise<string>;
  /** `coverage_fallback`; `ordinaryEligible` is passed only when Python passes it. */
  coverageFallback(options: {
    ordinaryEligible?: boolean;
  }): Promise<{ started: string | null; hasCoverage: boolean }>;
  event(kind: 'skipped', data: Record<string, string>): Promise<void>;
  /** `crq.iso()` for item notes. */
  nowIso(): string;
}

export interface StartOneInput {
  readonly queue: StartRecord;
  readonly log: string[];
  readonly dry: boolean;
  /** Non-empty selects one item id. */
  readonly only?: string | undefined;
  /** Python default is true. */
  readonly captureCurrent?: boolean;
}

export interface StartOneResult {
  readonly started: string | null;
  readonly hasCoverage: boolean;
}

/** Python's `str[:n]` counts code points, not UTF-16 units. */
function clip(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join('');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPending(item: StartRecord): boolean {
  return item.state === 'pending';
}

export async function startOne(
  input: StartOneInput,
  effects: StartOneEffects,
): Promise<StartOneResult> {
  const { queue, log, dry } = input;
  const only = input.only !== undefined && input.only !== '' ? input.only : null;
  const captureCurrent = input.captureCurrent ?? true;
  const { context } = effects;
  let started: string | null = null;
  let hasCoverage = false;
  const reservationsBefore = effects.startsCount();
  queue.backfill_ordinary_exhausted = false;
  const selection = sortItems(liveItems(queue), context) as StartRecord[];
  let turn =
    only === null &&
    backgroundTurn(queue) &&
    selection.some((item) => isPending(item) && rank(item, context) < 2);
  if (turn) {
    // Rank 2-3 plans first; their ordinary gates establish eligibility.
    const lane = (item: StartRecord): number => {
      const r = rank(item, context);
      return r >= 2 && r <= 3 ? 0 : 1;
    };
    const keyed = selection.map((item, index) => ({ item, index }));
    keyed.sort(
      (a, b) =>
        Number(a.item.operator_priority !== true) - Number(b.item.operator_priority !== true) ||
        lane(a.item) - lane(b.item) ||
        a.index - b.index,
    );
    selection.splice(0, selection.length, ...keyed.map((entry) => entry.item));
  }

  const stopOnCoverage = (result: { started: string | null; hasCoverage: boolean }): boolean => {
    started = result.started;
    hasCoverage = result.hasCoverage;
    return started !== null || (dry && hasCoverage);
  };

  let broke = false;
  for (const item of selection) {
    if (
      turn &&
      item.operator_priority !== true &&
      !(rank(item, context) >= 2 && rank(item, context) <= 3)
    ) {
      turn = false;
      if (stopOnCoverage(await effects.coverageFallback({ ordinaryEligible: false }))) {
        broke = true;
        break;
      }
    }
    if (only !== null && item.id !== only) continue;
    if (!isPending(item)) continue;
    if (item.kind === REVIEW_RECEIPT_KIND && !captureCurrent && !item.capture) {
      item.wait_reason = 'first current capture waits for fetching maintenance tick';
      continue;
    }
    if (item.kind === 'coverage' || item.kind === BACKFILL_KIND) {
      if (item.operator_priority === true) {
        if (stopOnCoverage(await effects.coverageFallback({}))) {
          broke = true;
          break;
        }
      }
      continue;
    }
    if (only !== null && (item.kind === AUTHOR_KIND || item.kind === REVIEW_RECEIPT_KIND) && !dry) {
      // Author enrollment is natural-tick only: a selective start would bypass
      // the priority order while the `only` filter skips the pending ordinary item.
      log.push(
        `${String(item.id)}: selective start refused — author items start only ` +
          'from the natural tick (pending natural-only)',
      );
      broke = true;
      break;
    }
    if (optionalWait(queue, item, context)) {
      item.wait_reason = 'optional cycle waits until no rank <=3 work is pending';
      continue;
    }
    if (additionalCycle(item)) {
      // Coverage gets first refusal even though it uses a fallback.
      if (stopOnCoverage(await effects.coverageFallback({}))) {
        broke = true;
        break;
      }
    }
    if (
      item.kind === 'merged' &&
      (liveItems(queue) as StartRecord[]).some(
        (other) => other.kind === REVIEW_RECEIPT_KIND && other.pr === item.pr,
      )
    ) {
      item.wait_reason =
        'linked merged-current intent owns current-scope recovery; legacy evidence retained';
      continue;
    }
    if (typeof item.not_before === 'string' && item.not_before !== '') {
      const notBefore = parseIso(item.not_before);
      if (notBefore !== null && notBefore.epochMicros > context.nowMicros) {
        const waiting = typeof item.wait_reason === 'string' ? item.wait_reason : '';
        if (!waiting.startsWith('completed-evidence-unavailable:')) {
          item.wait_reason = `backoff until ${item.not_before}`;
        }
        continue;
      }
    }
    if (!depsMet(queue, item)) {
      item.wait_reason = `waiting for ${String(item.depends_on)}`;
      continue;
    }

    let planned: PlanOutcome;
    try {
      planned = await effects.planItem(item);
    } catch (error) {
      const reservedSince = effects.startsCount() > reservationsBefore;
      if (error instanceof StartNothingToReview) {
        if (!dry) {
          item.state = 'skipped';
          const reason = `nothing to review: ${error.message}`;
          item.last_error = reason;
          await effects.event('skipped', { item: String(item.id), reason });
        }
        log.push(`${String(item.id)}: nothing to review (${error.message}) → skipped`);
        continue;
      }
      if (error instanceof StartNotReady) {
        item.wait_reason = error.message;
      } else {
        item.wait_reason = clip(`planning error: ${messageOf(error)}`, 300);
        log.push(clip(`${String(item.id)}: planning error ${messageOf(error)}`, 300));
      }
      // Unknown delivery still owns its journaled admission.
      if (reservedSince) {
        broke = true;
        break;
      }
      continue;
    }
    if (planned.outcome === 'none') {
      if (planned.logNoStart)
        log.push(`${String(item.id)}: ${String(item.state)} (no vendor start)`);
      continue;
    }
    if (planned.outcome === 'skipped') {
      if (!dry) {
        item.state = planned.state;
        item.last_error = planned.lastError;
      }
      log.push(`${String(item.id)}: ${planned.log}`);
      continue;
    }
    if (planned.outcome === 'wait') {
      item.wait_reason = planned.waitReason;
      continue;
    }
    const { plan } = planned;
    for (const note of plan.notes) {
      log.push(`${String(item.id)}: ${note}`);
      if (!dry) {
        const notes: unknown[] = Array.isArray(item.notes) ? item.notes : [];
        item.notes = [...notes, `${effects.nowIso()} ${note}`];
      }
    }
    if (dry) {
      log.push(
        `DRY-RUN would start ${String(item.id)} [${plan.label}] base ${plan.base.slice(0, 12)} ` +
          `head ${plan.head.slice(0, 12)} target ${plan.target}`,
      );
    } else {
      try {
        started = await effects.launch(item, plan);
      } catch (error) {
        if (!(error instanceof StartAuthorRefused)) throw error;
        item.wait_reason = error.message;
        log.push(`${String(item.id)}: author launch refused: ${error.message}`);
        continue;
      }
      if (item.state === 'blocked') {
        log.push(`${String(item.id)}: blocked before vendor start`);
        continue;
      }
      log.push(`started ${String(item.id)} [${plan.label}] run ${started}`);
    }
    broke = true;
    break;
  }
  if (!broke) {
    queue.backfill_ordinary_exhausted = only === null;
    const result = await effects.coverageFallback({});
    started = result.started;
    hasCoverage = result.hasCoverage;
    if (started === null) log.push('no eligible item this tick');
  }
  if (dry) {
    for (const item of sortItems(liveItems(queue), context) as StartRecord[]) {
      if (isPending(item) && typeof item.wait_reason === 'string' && item.wait_reason !== '') {
        log.push(`  waiting ${String(item.id)}: ${item.wait_reason}`);
      }
    }
  }
  return { started, hasCoverage };
}
