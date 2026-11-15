/**
 * The selection loop of `crq.start_one`: pick the next pending item in policy order, run
 * its per-kind gates and planner, and either log a dry run or launch. Inactive: nothing
 * imports it outside tests, and no tick, slot or unit binds it yet.
 *
 * Every per-kind planner, the forge lookups, the coverage fallback and the launch are
 * injected (`StartOneEffects`), so this module is the control flow only. Python mutates
 * the queue in place; so does this, on the plain-JSON queue the caller hands it, because
 * `optional_wait` and `launch` rely on item identity and on writes made mid-loop. The
 * caller passes a private copy and keeps the original for its own immutable view.
 */
import {
  AUTHOR_KIND,
  BACKFILL_KIND,
  LOCAL_REVIEW_KIND,
  REVIEW_RECEIPT_KIND,
  additionalCycle,
  backgroundTurn,
  depsMet,
  liveItems,
  optionalWait,
  rank,
  sortItems,
  type ScheduleContext,
} from '../policy/crq/tickSchedule.js';
import { parseIso } from '../policy/crq/utc.js';

export const PUSH_CURRENT_KIND = 'push-current';

/** `crq.NotReady`: the item cannot start yet; its wait reason is the message. */
export class NotReady extends Error {
  override readonly name = 'NotReady';
}

/** `crq.NothingToReview`: the item has no reviewable change; it is skipped. */
export class NothingToReview extends Error {
  override readonly name = 'NothingToReview';
}

/** `author_quota.AuthorRefused` as raised from `launch`. */
export class LaunchAuthorRefused extends Error {
  override readonly name = 'LaunchAuthorRefused';
}

/** A mutable queue item; the document is plain JSON mutated in place like Python's dicts. */
export type Item = Record<string, unknown>;
export type Queue = Record<string, unknown>;

export interface Plan {
  readonly notes: readonly string[];
  readonly label: string;
  readonly base: string;
  readonly head: string;
  readonly target: string;
}

export interface Coverage {
  readonly started: string | null;
  readonly hasCoverage: boolean;
}

export interface StartOneEffects {
  readonly context: ScheduleContext;
  /** `iso()`: the stamp prefixed to appended notes. */
  iso(): string;
  /** `_coverage_fallback(q, log, dry, only)`: the unwrapped backfill/coverage selection. */
  coverageSelect(q: Queue, log: string[], dry: boolean, only: string | null): Promise<Coverage>;
  /** `local_review_runtime.prepare`; null means no plan and no log. */
  prepareLocalReview(q: Queue, item: Item, dry: boolean): Promise<Plan | null>;
  planAuthor(item: Item, dry: boolean): Promise<Plan>;
  /** `prepare_current`; null logs "(no vendor start)". */
  prepareCurrent(q: Queue, item: Item, dry: boolean): Promise<Plan | null>;
  /** `push_current.prepare`; null logs "(no vendor start)". */
  preparePush(q: Queue, item: Item, dry: boolean): Promise<Plan | null>;
  planMerged(item: Item, dry: boolean): Promise<Plan>;
  /** `pr_info(item["pr"], item_repo(item))`. */
  prInfo(item: Item): Promise<{ readonly state: string }>;
  /** `quiet_reason`: a wait reason, or null when the PR is quiet. */
  quietReason(item: Item, info: { readonly state: string }, ignoreAge: boolean): string | null;
  planOpen(item: Item, info: { readonly state: string }, dry: boolean, q: Queue): Promise<Plan>;
  planDelta(item: Item, info: { readonly state: string }, dry: boolean, q: Queue): Promise<Plan>;
  /** `launch(q, item, plan)`: returns the run id; may set `item.state = 'blocked'`. */
  launch(q: Queue, item: Item, plan: Plan): Promise<string>;
  event(kind: 'skipped', data: Record<string, string>): Promise<void>;
}

export interface StartOneInput {
  readonly dry: boolean;
  readonly only: string | null;
  readonly ignoreQuiet: boolean;
  readonly captureCurrent: boolean;
}

export interface StartOneResult {
  readonly started: string | null;
  readonly hasCoverage: boolean;
}

const truthy = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false || value === '' || value === 0)
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
};

const startsLength = (q: Queue): number => (Array.isArray(q.starts) ? q.starts.length : 0);
const asItem = (value: unknown): Item => value as Item;

/** `coverage_fallback`: `ordinary_eligible=False` temporarily marks ordinary work exhausted. */
async function coverageFallback(
  q: Queue,
  log: string[],
  input: StartOneInput,
  effects: StartOneEffects,
  ordinaryEligible?: boolean,
): Promise<Coverage> {
  const previous = q.backfill_ordinary_exhausted ?? false;
  if (ordinaryEligible === false) q.backfill_ordinary_exhausted = true;
  try {
    return await effects.coverageSelect(q, log, input.dry, input.only);
  } finally {
    q.backfill_ordinary_exhausted = previous;
  }
}

/** `start_one`. The queue is mutated; the log gains this pass's lines. */
export async function startOne(
  q: Queue,
  log: string[],
  input: StartOneInput,
  effects: StartOneEffects,
): Promise<StartOneResult> {
  const { dry, only } = input;
  const { context } = effects;
  let started: string | null = null;
  let hasCoverage = false;
  const reservationsBefore = startsLength(q);
  q.backfill_ordinary_exhausted = false;
  let selection = sortItems(liveItems(q), context) as Item[];
  let turn =
    !only &&
    backgroundTurn(q) &&
    selection.some((i) => i.state === 'pending' && rank(i, context) < 2);
  if (turn) {
    // Try rank 2-3 plans in order; their ordinary gates establish eligibility.
    const key = (i: Item): [number, number] => [
      truthy(i.operator_priority) ? 0 : 1,
      rank(i, context) >= 2 && rank(i, context) <= 3 ? 0 : 1,
    ];
    selection = selection
      .map((item, index) => ({ item, index, key: key(item) }))
      .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
      .map((entry) => entry.item);
  }

  const fallback = (ordinaryEligible?: boolean): Promise<Coverage> =>
    coverageFallback(q, log, input, effects, ordinaryEligible);
  const adopt = (result: Coverage): boolean => {
    started = result.started;
    hasCoverage = result.hasCoverage;
    return truthy(result.started) || (dry && result.hasCoverage);
  };
  const nowMicros = effects.context.nowMicros;

  let broke = false;
  for (const item of selection) {
    const id = item.id as string;
    const kind = item.kind;
    if (turn && !truthy(item.operator_priority) && !(rank(item, context) >= 2 && rank(item, context) <= 3)) {
      turn = false;
      if (adopt(await fallback(false))) {
        broke = true;
        break;
      }
    }
    if (only && id !== only) continue;
    if (item.state !== 'pending') continue;
    if (kind === REVIEW_RECEIPT_KIND && !input.captureCurrent && !truthy(item.capture)) {
      item.wait_reason = 'first current capture waits for fetching maintenance tick';
      continue;
    }
    if (kind === 'coverage' || kind === BACKFILL_KIND) {
      if (truthy(item.operator_priority) && adopt(await fallback())) {
        broke = true;
        break;
      }
      continue;
    }
    if (only && (kind === AUTHOR_KIND || kind === REVIEW_RECEIPT_KIND) && !dry) {
      // Author enrollment is pending natural-only by design: a selective start would
      // dispatch it while a pending ordinary item is skipped, bypassing priority order.
      log.push(
        `${id}: selective start refused — author items start only from the natural tick (pending natural-only)`,
      );
      broke = true;
      break;
    }
    if (optionalWait(q, item, context)) {
      item.wait_reason = 'optional cycle waits until no rank <=3 work is pending';
      continue;
    }
    if (additionalCycle(item) && adopt(await fallback())) {
      // Coverage gets first refusal even though it uses a fallback.
      broke = true;
      break;
    }
    if (
      kind === 'merged' &&
      liveItems(q).some(
        (i) => i.kind === REVIEW_RECEIPT_KIND && (i.pr ?? null) === (item.pr ?? null),
      )
    ) {
      item.wait_reason =
        'linked merged-current intent owns current-scope recovery; legacy evidence retained';
      continue;
    }
    if (truthy(item.not_before)) {
      const due = parseIso(item.not_before);
      if (due === null) throw new Error('not_before is not a timestamp');
      if (due.epochMicros > nowMicros) {
        const reason = typeof item.wait_reason === 'string' ? item.wait_reason : '';
        if (!reason.startsWith('completed-evidence-unavailable:'))
          item.wait_reason = `backoff until ${String(item.not_before)}`;
        continue;
      }
    }
    if (!depsMet(q, item)) {
      item.wait_reason = `waiting for ${String(item.depends_on)}`;
      continue;
    }

    let plan: Plan | null;
    try {
      if (kind === LOCAL_REVIEW_KIND) {
        plan = await effects.prepareLocalReview(q, item, dry);
        if (plan === null) continue;
      } else if (kind === AUTHOR_KIND) {
        // Author items bind their own base/head/target: no PR, no quiet gate.
        plan = await effects.planAuthor(item, dry);
      } else if (kind === REVIEW_RECEIPT_KIND) {
        plan = await effects.prepareCurrent(q, item, dry);
        if (plan === null) {
          log.push(`${id}: ${String(item.state)} (no vendor start)`);
          continue;
        }
      } else if (kind === PUSH_CURRENT_KIND) {
        plan = await effects.preparePush(q, item, dry);
        if (plan === null) {
          log.push(`${id}: ${String(item.state)} (no vendor start)`);
          continue;
        }
      } else if (kind === 'merged') {
        plan = await effects.planMerged(item, dry);
      } else {
        const info = await effects.prInfo(item);
        const postMerge = kind === 'delta' && info.state === 'MERGED';
        if (info.state !== 'OPEN' && !postMerge) {
          if (!dry) {
            item.state = 'skipped';
            item.last_error = `PR ${info.state.toLowerCase()} before review`;
          }
          log.push(`${id}: PR ${info.state} → skipped`);
          continue;
        }
        // Merged heads are immutable and get no addressing agent: no busy/quiet gate.
        const quiet = postMerge ? null : effects.quietReason(item, info, input.ignoreQuiet);
        if (truthy(quiet)) {
          item.wait_reason = quiet;
          continue;
        }
        plan =
          kind === 'open'
            ? await effects.planOpen(item, info, dry, q)
            : await effects.planDelta(item, info, dry, q);
      }
    } catch (error) {
      if (error instanceof NotReady) {
        item.wait_reason = error.message;
        if (startsLength(q) > reservationsBefore) {
          broke = true;
          break; // unknown delivery still owns its journaled admission
        }
        continue;
      }
      if (error instanceof NothingToReview) {
        if (!dry) {
          item.state = 'skipped';
          item.last_error = `nothing to review: ${error.message}`;
          await effects.event('skipped', { item: id, reason: item.last_error });
        }
        log.push(`${id}: nothing to review (${error.message}) → skipped`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      item.wait_reason = `planning error: ${message}`.slice(0, 300);
      log.push(`${id}: planning error ${message}`.slice(0, 300));
      if (startsLength(q) > reservationsBefore) {
        broke = true;
        break;
      }
      continue;
    }

    for (const note of plan.notes) {
      log.push(`${id}: ${note}`);
      if (!dry) {
        const notes = Array.isArray(item.notes) ? (item.notes as unknown[]) : [];
        item.notes = notes;
        notes.push(`${effects.iso()} ${note}`);
      }
    }
    if (dry) {
      log.push(
        `DRY-RUN would start ${id} [${plan.label}] base ${plan.base.slice(0, 12)} head ${plan.head.slice(0, 12)} target ${plan.target}`,
      );
    } else {
      try {
        started = await effects.launch(q, item, plan);
      } catch (error) {
        if (error instanceof LaunchAuthorRefused) {
          item.wait_reason = error.message;
          log.push(`${id}: author launch refused: ${error.message}`);
          continue;
        }
        throw error;
      }
      if (item.state === 'blocked') {
        log.push(`${id}: blocked before vendor start`);
        continue;
      }
      log.push(`started ${id} [${plan.label}] run ${started}`);
    }
    broke = true;
    break;
  }
  if (!broke) {
    q.backfill_ordinary_exhausted = !only;
    const result = await fallback();
    started = result.started;
    hasCoverage = result.hasCoverage;
    if (!truthy(started)) log.push('no eligible item this tick');
  }
  if (dry) {
    for (const i of sortItems(liveItems(q), context)) {
      if (i.state === 'pending' && truthy(i.wait_reason))
        log.push(`  waiting ${String(asItem(i).id)}: ${String(i.wait_reason)}`);
    }
  }
  return { started, hasCoverage };
}
