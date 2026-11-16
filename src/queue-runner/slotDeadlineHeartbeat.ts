/**
 * `refresh_slot_deadline` (crq.py:2214) and `write_heartbeat` (crq.py:3666).
 * Inactive: nothing imports this outside tests. Every effect (clock, ISO
 * parsing, the slot calculator, the hint file, the heartbeat file, events) is
 * injected. Times are epoch milliseconds; items are plain records.
 */
import { pythonJsonText } from '../policy/crq/pythonJson.js';

export type Item = Record<string, unknown>;
export type Queue = Record<string, unknown> & { items: Item[] };

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
  return Boolean(v);
}
const MINUTE_MS = 60_000;

/** Raised by the heartbeat file seams for a Python OSError; anything else escapes. */
export class HeartbeatIoError extends Error {}

// ------------------------------------------------------ refresh_slot_deadline

export interface SlotDeadlineEffects {
  nowMs(): number;
  /** `live_items(q)`. */
  liveItems(q: Queue): Item[];
  /** `parse_iso(s)`; throws on an invalid string, null for a missing one. */
  parseIsoMs(s: unknown): number | null;
  /** `usage_slots.next_slot(starts, at, usage)`; throws like Python on a bad start. */
  nextSlot(
    starts: readonly (number | null)[],
    atMs: number,
    usage: Record<string, unknown> | null,
  ): number | null;
  /** `usage_slots.write_next(STATE / "next-review-at", hint)`. */
  writeNext(hintMs: number): Promise<void>;
}

function itemState(item: Item): unknown {
  if (!('state' in item)) throw new TypeError('item.state missing');
  return item.state;
}
/** Python `any(...)`: short-circuits, so only items up to the first hit are inspected. */
function anyItem(items: Item[], test: (i: Item) => boolean): boolean {
  for (const item of items) if (test(item)) return true;
  return false;
}

/** Returns the admission deadline; the written hint may be an earlier collection wake. */
export async function refreshSlotDeadline(
  q: Queue,
  usage: Record<string, unknown> | null,
  remaining: number,
  gate: string | null,
  atMs: number | undefined,
  fx: SlotDeadlineEffects,
): Promise<number> {
  const at = atMs === undefined ? fx.nowMs() : atMs;
  const live = fx.liveItems(q);
  let deadline: number;
  if (
    truthy(q.paused) ||
    gate === 'inflight' ||
    !anyItem(live, (i) => itemState(i) === 'pending')
  ) {
    deadline = at + 12 * MINUTE_MS;
  } else if (
    truthy(q.cooldown_until) &&
    (() => {
      const cooldown = fx.parseIsoMs(q.cooldown_until);
      if (cooldown === null) throw new TypeError('cooldown_until unparsable');
      return cooldown > at;
    })()
  ) {
    deadline = fx.parseIsoMs(q.cooldown_until) as number;
  } else if (remaining <= 0) {
    const starts = ((q.starts as unknown[] | undefined) ?? []).map((s) => fx.parseIsoMs(s));
    deadline = fx.nextSlot(starts, at, usage) ?? at + 60_000;
  } else {
    deadline = at + 12 * MINUTE_MS; // available slots, no eligible item
  }
  let hint = deadline;
  if (anyItem(live, (i) => itemState(i) === 'reviewing' && truthy(i.run))) {
    // Detached reviews need minute collection; signer holds await full ticks.
    hint = Math.min(hint, Math.floor(at / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  }
  await fx.writeNext(hint);
  return deadline;
}

// --------------------------------------------------------------- heartbeat

export interface HeartbeatEffects {
  /** `WATCHDOG_HOME.mkdir(parents=True, exist_ok=True)`. */
  mkdirHome(): Promise<void>;
  /** `.heartbeat.json.tmp` write. */
  writeTemp(text: string): Promise<void>;
  /** `tmp.replace(heartbeat.json)`. */
  commit(): Promise<void>;
  event(kind: string, data: Record<string, unknown>): Promise<void>;
  readonly config: Record<string, unknown>;
  readonly root: string;
}

/** For the agent-free watchdog. An OSError is logged as `heartbeat_failed`, never raised. */
export async function writeHeartbeat(q: Queue, fx: HeartbeatEffects): Promise<void> {
  try {
    await fx.mkdirHome();
    if (!('last_tick' in q)) throw new TypeError('q.last_tick missing');
    const alerts = (fx.config.alerts ?? {}) as Record<string, unknown>;
    const text =
      pythonJsonText(
        {
          last_tick: q.last_tick,
          stale_alarm_min: 'stale_alarm_min' in fx.config ? fx.config.stale_alarm_min : 36,
          schedule_id: fx.config.schedule_id ?? null,
          root: fx.root,
          alert_agent_id: alerts.alert_agent_id ?? null,
          alert_agent_host: alerts.alert_agent_host ?? null,
        },
        { asciiOnly: true, sortKeys: false, keyOrder: 'insertion', spacedSeparators: true },
      ) + '\n';
    await fx.writeTemp(text);
    await fx.commit();
  } catch (error) {
    if (!(error instanceof HeartbeatIoError)) throw error;
    await fx.event('heartbeat_failed', { error: Array.from(error.message).slice(0, 200).join('') });
  }
}
