/**
 * `coverage_fallback` (crq.py:2986) and the backfill usage context
 * (`backfill_runtime.usage_context` / `usage_age`). Inactive: nothing imports
 * this outside tests.
 *
 * Every effect (backfill selection, git, the coverage ledger, the launcher,
 * the clock) is injected. Items and the queue are plain records edited in
 * place, as Python edits its dicts; the caller owns tick.lock. Python's
 * `except (ValueError, KeyError, TypeError)` around the legacy-origin lookup is
 * modelled by {@link CoverageIdentityError}: a binding maps those three Python
 * exceptions onto it, and any other error propagates exactly as in Python.
 */
export type Item = Record<string, unknown>;
export type Queue = Record<string, unknown> & { items: Item[] };

/** Raised by the legacy-origin seams for Python ValueError / KeyError / TypeError. */
export class CoverageIdentityError extends Error {}

/** Python `s[:n]`: counts code points. */
export function pyPrefix(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('');
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
/** Python truthiness for JSON-shaped values. */
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

// ------------------------------------------------------------- usage context

export const USAGE_REFRESH_AFTER_SECONDS = 60;

export interface UsageContextEffects {
  /** `c.iso()`. */
  iso(): string;
  /** `ledger.timestamp(s)` in epoch milliseconds; throws on an unparsable value. */
  timestampMs(s: string): number;
}

/** Seconds since the observation, or null for a missing/unreadable `observed_at`. */
export function usageAge(observation: unknown, fx: UsageContextEffects): number | null {
  try {
    if (!isObj(observation)) throw new TypeError('observation');
    const observed = observation.observed_at;
    if (typeof observed !== 'string') throw new TypeError('observed_at');
    return (fx.timestampMs(fx.iso()) - fx.timestampMs(observed)) / 1000;
  } catch {
    // Python: except (KeyError, TypeError, ValueError). timestampMs throws on bad input.
    return null;
  }
}

/** Bind a fresh usage read to the existing local holds before selection. */
export function usageContext(
  queue: Queue,
  usage: Record<string, unknown> | null,
  reserved: readonly string[],
  fx: UsageContextEffects,
): void {
  const reflected: unknown[] = usage
    ? [...((usage.reflected_reservations as unknown[] | undefined) ?? [])]
    : [];
  const holds = (queue.backfill_reservations ?? {}) as Record<string, Record<string, unknown>>;
  if (usage !== null) {
    const window = ((usage.rollingWindowMs as number | undefined) || 3600000) as number;
    const observed = fx.timestampMs(fx.iso());
    for (const [key, hold] of Object.entries(holds)) {
      const terminalAt = hold.terminal_at;
      if (terminalAt && observed >= fx.timestampMs(terminalAt as string) + window) {
        hold.quota_state = 'expired';
      } else if (
        terminalAt &&
        hold.quota_state !== 'released' &&
        hold.quota_state !== 'expired' &&
        fx.timestampMs(terminalAt as string) <= observed &&
        !reflected.includes(key)
      ) {
        reflected.push(key);
      }
    }
  }
  // Legacy/non-backfill reservations share the effective quota arithmetic.
  const represented = queue.items.filter(
    (i) =>
      typeof i.attempt_id === 'string' &&
      Object.prototype.hasOwnProperty.call(holds, i.attempt_id) &&
      reserved.includes((i.run as Record<string, string> | null | undefined)?.started_at ?? '\0'),
  ).length;
  let remaining = 0;
  if (truthy(usage)) {
    const r = (usage as Record<string, unknown>).remaining;
    if (typeof r !== 'number') throw new TypeError('usage.remaining missing');
    remaining = r - Math.max(0, reserved.length - represented);
  }
  queue.backfill_usage = {
    successful: usage !== null,
    remaining: Math.max(0, remaining),
    observed_at: fx.iso(),
    reflected_reservations: reflected,
  };
}

// ----------------------------------------------------------- coverage fallback

export interface CoverageEffects {
  /** `backfill_runtime.select(c, q, log, dry, only)`. */
  select(
    q: Queue,
    log: string[],
    dry: boolean,
    only: unknown,
  ): Promise<{ started: string | null; available: boolean }>;
  /** `backfill_runtime.settings(STATE, dispatch=True)` is truthy. */
  backfillDispatchConfigured(): boolean;
  /** `git rev-parse DEFAULT_REF^{commit}`. */
  mergeQueueSha(): Promise<string>;
  /** `live_items(q)`. */
  liveItems(q: Queue): Item[];
  /** `sort_key` as a comparator. */
  compareItems(a: Item, b: Item): number;
  measureMerged(item: Item, sha: string): Promise<Record<string, unknown>>;
  /** `coverage.coverage_candidate(q, q.get("coverage") or new_ledger(), ...CONFIG["coverage"])`. */
  coverageCandidate(q: Queue, mq: string): Item | null;
  /** `now()` in epoch milliseconds. */
  nowMs(): number;
  /** `parse_iso(s)` in epoch milliseconds. */
  parseIsoMs(s: string): number;
  depsMet(q: Queue, item: Item): boolean;
  /** `coverage._legacy_origins`; map ValueError/KeyError/TypeError to CoverageIdentityError. */
  legacyOrigins(q: Queue, item: Item): { source: { pr: unknown }; origins: unknown[] };
  legacyRetryAllowed(q: Queue, pr: unknown, origin: unknown, nowMs: number): boolean;
  buildSynthetic(item: Item, sha: string): Promise<{ base: string; head: string; paths: number }>;
  /** `git diff --name-only base head` stdout. */
  diffNameOnly(base: string, head: string): Promise<string>;
  rank4Gate(q: Queue, item: Item, dry: boolean): Promise<boolean>;
  /** `launch(q, item, plan)`: returns the run id. */
  launch(q: Queue, item: Item, plan: Record<string, unknown>): Promise<string>;
  bindRun(q: Queue, item: Item, runId: string): void;
  cancelBeforeVendor(q: Queue, item: Item): void;
}

export interface CoverageResult {
  started: string | null;
  available: boolean;
}

export async function coverageFallback(
  q: Queue,
  log: string[],
  dry: boolean,
  only: unknown,
  ordinaryEligible: boolean | undefined,
  fx: CoverageEffects,
): Promise<CoverageResult> {
  const previous = q.backfill_ordinary_exhausted ?? false;
  if (ordinaryEligible === false) q.backfill_ordinary_exhausted = true;
  try {
    return await coverageFallbackInner(q, log, dry, only, fx);
  } finally {
    q.backfill_ordinary_exhausted = previous;
  }
}

async function coverageFallbackInner(
  q: Queue,
  log: string[],
  dry: boolean,
  only: unknown,
  fx: CoverageEffects,
): Promise<CoverageResult> {
  const selected = await fx.select(q, log, dry, only);
  if (selected.started || selected.available) return selected;
  if (fx.backfillDispatchConfigured()) return { started: null, available: false };
  if (truthy(only)) return { started: null, available: false };
  const mq = await fx.mergeQueueSha();
  let candidates = fx.liveItems(q).filter((i) => i.kind === 'coverage' && i.state === 'pending');
  for (const i of candidates) {
    // A captured coverage target is immutable across tip moves.
    if (!('coverage_sha' in i)) i.coverage_sha = mq;
  }
  if (candidates.length === 0) {
    if (fx.liveItems(q).some((i) => i.kind === 'coverage' && i.state === 'reviewing'))
      return { started: null, available: false };
    for (const i of fx.liveItems(q)) {
      if (i.kind === 'merged' && i.merge_commit) {
        try {
          i.measure = await fx.measureMerged(i, mq);
        } catch (error) {
          log.push('coverage measurement failed: ' + pyPrefix(message(error), 150));
        }
      }
    }
    const candidate = fx.coverageCandidate(q, mq);
    if (candidate) {
      q.items.push(candidate);
      candidates = [candidate];
    }
  }
  let available = false;
  for (const item of [...candidates].sort(fx.compareItems)) {
    const notBefore = item.not_before;
    if ((notBefore && fx.parseIsoMs(notBefore as string) > fx.nowMs()) || !fx.depsMet(q, item))
      continue;
    try {
      const { source, origins } = fx.legacyOrigins(q, item);
      if (
        origins.length === 0 ||
        origins.some((o) => !fx.legacyRetryAllowed(q, source.pr, o, fx.nowMs()))
      ) {
        item.wait_reason = 'legacy coverage retry history or cooldown unresolved';
        continue;
      }
    } catch (error) {
      if (!(error instanceof CoverageIdentityError)) throw error;
      item.wait_reason = 'legacy coverage retry identity unresolved';
      continue;
    }
    available = true;
    if (dry) {
      log.push('DRY-RUN would cut coverage ' + (item.id as string));
      return { started: null, available: true };
    }
    try {
      const sha = item.coverage_sha as string;
      const { base, head } = await fx.buildSynthetic(item, sha);
      if (!(await fx.diffNameOnly(base, head))) {
        item.state = 'skipped';
        item.last_error = 'empty coverage range';
        continue;
      }
      const plan = {
        base,
        head,
        target: sha,
        cycle: null,
        branch: null,
        notes: [] as string[],
        label: 'lowest-priority coverage review',
      };
      if (!(await fx.rank4Gate(q, item, dry))) continue;
      const runId = await fx.launch(q, item, plan);
      if (item.state === 'reviewing') fx.bindRun(q, item, runId);
      else if (!truthy(item.run)) fx.cancelBeforeVendor(q, item);
      log.push('coverage ' + (item.id as string) + ': ' + String(item.state));
      return { started: item.state === 'reviewing' ? runId : null, available: true };
    } catch (error) {
      item.wait_reason = 'coverage planning failed: ' + pyPrefix(message(error), 200);
    }
  }
  return { started: null, available };
}
