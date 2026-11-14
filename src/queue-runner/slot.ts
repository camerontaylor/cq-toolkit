/**
 * The slot timer's concurrency protocol, separate from the incomplete live
 * admission pass. Callers supply real queue and quota effects only once that
 * pass is ready. Nothing here enables the slot command.
 */

/** A nonblocking lock reports whether it acquired the shared inode. */
export interface SlotEffects<Queue, Observation> {
  disabled(): Promise<boolean>;
  withTickLock<T>(
    work: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  loadQueue(): Promise<Queue>;
  /** Must produce an independent, lossless copy of the loaded queue. */
  copyQueue(queue: Queue): Queue;
  equalQueue(left: Queue, right: Queue): boolean;
  readUsage(queue: Queue): Promise<Observation>;
  admit(queue: Queue, observation: Observation): Promise<string[]>;
}

/**
 * Probe outside tick.lock, then compare the entire queue and admit inside one
 * transaction. Never use a stale quota observation after any queue change.
 */
export async function scheduledSlot<Queue, Observation>(
  effects: SlotEffects<Queue, Observation>,
): Promise<string[]> {
  if (await effects.disabled()) return ['runner disabled for host handover'];
  const loaded = await effects.withTickLock(async () =>
    effects.copyQueue(await effects.loadQueue()),
  );
  if (!loaded.acquired) return [];
  const snapshot = loaded.value;
  const observed = effects.copyQueue(snapshot);
  const usage = await effects.readUsage(observed);
  const committed = await effects.withTickLock(async () => {
    if (!effects.equalQueue(await effects.loadQueue(), snapshot)) {
      return ['queue changed during quota probe; retry next slot tick'];
    }
    if (await effects.disabled()) return ['runner disabled for host handover'];
    return effects.admit(observed, usage);
  });
  return committed.acquired ? committed.value : [];
}

/** Timer fast path. The runner is called only after the preflight lock is released. */
export interface SlotPreflightEffects {
  hintIsFuture(): Promise<boolean>;
  withTickLock<T>(
    work: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  runScheduledSlot(): Promise<string[]>;
}

export async function slotPreflight(effects: SlotPreflightEffects): Promise<string[]> {
  if (await effects.hintIsFuture()) return [];
  const preflight = await effects.withTickLock(() => effects.hintIsFuture());
  if (!preflight.acquired || preflight.value) return [];
  return effects.runScheduledSlot();
}
