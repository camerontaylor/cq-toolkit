/**
 * The tick's view of open backfill fix PRs (repair_tick.py:46-53, 580-644).
 * Inactive: nothing imports this outside tests. Python keeps it in the
 * module-global `TICK_BACKLOG`; here it is an object the caller owns, so one
 * tick cannot leak its cap view into the next.
 *
 * Semantics kept: a `null` count means "unread" and creation holds; a failed
 * refresh leaves it unread (never zero, which would lift the cap) and the
 * previous `state/repair/fix-pr-backlog.json` stays on disk for the drain.
 */
import { JsonObject, parseJsonValue, type JsonValue } from '../policy/crq/jsonValue.js';
import { parseUtcUnchecked } from '../policy/crq/utc.js';

export const BACKFILL_ITEM = 'backfill-finding-';
export const BACKFILL_BRANCH = 'crq/fix-backfill-';
export const BACKLOG_WINDOW_HOURS = 72;
export const BACKLOG_HOURS_OF_CAPACITY = 4;

type Item = Record<string, unknown>;

export interface FixPrBacklogDoc {
  readonly at: string;
  readonly open: number;
  readonly limit: number;
}

export interface FixPrBacklogEffects {
  /**
   * `gh pr list --repo REPO --state open --limit 1000 --json headRefName`,
   * parsed. Any throw is a failed read.
   */
  listOpenPrs(): Promise<unknown>;
  /** `EVENTS.read_text()`; `null` is an `OSError` (no events, limit 0). */
  readEvents(): Promise<string | null>;
  /** `atomic(STATE/repair/fix-pr-backlog.json, doc)`. */
  writeBacklog(doc: FixPrBacklogDoc): Promise<void>;
  nowMs(): number;
}

/** `TICK_BACKLOG`. */
export class FixPrBacklog {
  open: number | null = null;
  limit: number | null = null;

  /** `reset_fix_pr_backlog`: creation holds until this tick's refresh reads it. */
  reset(): void {
    this.open = null;
    this.limit = null;
  }

  /** `backfill_slot_free`: a backfill fix PR may be created only while open < limit. */
  slotFree(item: Item): boolean {
    if (!pyStr(item.id).startsWith(BACKFILL_ITEM)) return true;
    return this.open !== null && this.limit !== null && this.open < this.limit;
  }

  /** `finalize_publication` reserves the slot before `gh pr create`. */
  reserve(): void {
    if (this.open !== null) this.open += 1;
  }

  /** ...and releases it when gh reports failure. */
  release(): void {
    if (this.open !== null) this.open -= 1;
  }
}

function pyStr(value: unknown): string {
  if (value === undefined || value === null) return value === null ? 'None' : '';
  return typeof value === 'string' ? value : String(value);
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * `backfill_repair_present`: true when a backfill item carries repair runs;
 * only then can this tick publish a backfill fix PR or budget a backfill group.
 */
export function backfillRepairPresent(q: { items?: readonly Item[] }): boolean {
  return (q.items ?? []).some(
    (item) =>
      (item.id === undefined ? '' : pyStr(item.id)).startsWith(BACKFILL_ITEM) &&
      truthy(item.repair_runs),
  );
}

/** Python `str.splitlines()` boundaries, without a trailing empty line. */
const LINE_BREAKS = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);
export function pySplitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!LINE_BREAKS.has(text.charCodeAt(i))) continue;
    lines.push(text.slice(start, i));
    if (text.charCodeAt(i) === 0x0d && text.charCodeAt(i + 1) === 0x0a) i += 1;
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Time-part offset (`+HH`, `-HH:MM`, ...) after the `T`/`t`/space separator. */
const TIME_OFFSET = /[Tt ][^+-]*[+-]\d{2}/;

/**
 * `review_start_limit`: `review_started` events in the trailing 72 h, times
 * four hours of capacity, floored. A timestamp without an offset is naive in
 * Python and never counts.
 */
export async function reviewStartLimit(
  effects: Pick<FixPrBacklogEffects, 'readEvents' | 'nowMs'>,
): Promise<number> {
  const nowMicros = BigInt(effects.nowMs()) * 1000n;
  const cutoff = nowMicros - BigInt(BACKLOG_WINDOW_HOURS) * 3_600_000_000n;
  const text = await effects.readEvents();
  if (text === null) return 0;
  let started = 0;
  for (const line of pySplitLines(text)) {
    if (!line.includes('"review_started"')) continue;
    let row: JsonValue;
    try {
      row = parseJsonValue(line);
    } catch {
      continue;
    }
    if (!(row instanceof JsonObject)) continue;
    const at = row.get('at');
    if (typeof at !== 'string') continue;
    const instant = parseUtcUnchecked(at);
    if (instant === null) continue;
    if (!TIME_OFFSET.test(at.replaceAll('Z', '+00:00'))) continue;
    if (row.get('event') === 'review_started' && cutoff <= instant && instant <= nowMicros) {
      started += 1;
    }
  }
  return Math.floor((started * BACKLOG_HOURS_OF_CAPACITY) / BACKLOG_WINDOW_HOURS);
}

const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * `refresh_fix_pr_backlog`: count open fix PRs on GitHub (never the queue,
 * whose cached state lags), write the file once per tick before any publish,
 * then publish the view. Any failure returns null and leaves the view unread.
 */
export async function refreshFixPrBacklog(
  backlog: FixPrBacklog,
  effects: FixPrBacklogEffects,
): Promise<FixPrBacklog | null> {
  backlog.reset();
  let open: number;
  let limit: number;
  try {
    const prs = await effects.listOpenPrs();
    if (!Array.isArray(prs)) throw new TypeError('gh pr list must return an array');
    open = 0;
    for (const pr of prs) {
      if (typeof pr !== 'object' || pr === null || Array.isArray(pr)) {
        throw new TypeError('gh pr list entry must be an object');
      }
      const head = (pr as Record<string, unknown>).headRefName;
      if ((head === undefined ? '' : pyStr(head)).startsWith(BACKFILL_BRANCH)) open += 1;
    }
    limit = await reviewStartLimit(effects);
    await effects.writeBacklog({ at: isoSeconds(effects.nowMs()), open, limit });
  } catch {
    return null;
  }
  backlog.open = open;
  backlog.limit = limit;
  return backlog;
}
