import type { Usage } from '../../driver/types.js';

/** One driver invocation, including a failed or cancelled invocation that returned usage. */
export interface UsageObservation {
  /** Absent when the provider supplied no measurement; an explicit zero is measured. */
  usage?: Usage;
  /** Derived price, when the served model had a known rate. Never vendor-reported USD. */
  costUSD?: number;
}

export interface KnownUsageSummary {
  /** Sum of measured invocations only; absent when none supplied usage. */
  usage?: Usage;
  /** Sum of priced invocations only; absent when none could be priced. */
  costUSD?: number;
  knownCount: number;
  unknownCount: number;
  unpricedCount: number;
}

/** Fold engine summaries without treating each aggregate as one driver call. */
export function foldKnownUsageSummaries(
  summaries: readonly KnownUsageSummary[],
): KnownUsageSummary {
  const folded: KnownUsageSummary = { knownCount: 0, unknownCount: 0, unpricedCount: 0 };
  for (const summary of summaries) {
    folded.knownCount += summary.knownCount;
    folded.unknownCount += summary.unknownCount;
    folded.unpricedCount += summary.unpricedCount;
    if (summary.usage !== undefined) {
      if (folded.usage === undefined) folded.usage = { ...summary.usage };
      else {
        folded.usage.input += summary.usage.input;
        folded.usage.output += summary.usage.output;
        folded.usage.cacheRead += summary.usage.cacheRead;
        folded.usage.cacheWrite += summary.usage.cacheWrite;
        if (summary.usage.reasoning !== undefined)
          folded.usage.reasoning = (folded.usage.reasoning ?? 0) + summary.usage.reasoning;
      }
    }
    if (summary.costUSD !== undefined) folded.costUSD = (folded.costUSD ?? 0) + summary.costUSD;
  }
  return folded;
}

function validTokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validUsage(usage: unknown): usage is Usage {
  if (typeof usage !== 'object' || usage === null) return false;
  const fields = usage as Record<string, unknown>;
  return (
    [fields.input, fields.output, fields.cacheRead, fields.cacheWrite].every(validTokens) &&
    (fields.reasoning === undefined || validTokens(fields.reasoning))
  );
}

/** Discard malformed provider telemetry without losing independently valid fields. */
export function normalizeUsageObservation(observation: UsageObservation): UsageObservation {
  return {
    ...(validUsage(observation.usage) ? { usage: observation.usage } : {}),
    ...(observation.costUSD !== undefined &&
    Number.isFinite(observation.costUSD) &&
    observation.costUSD >= 0
      ? { costUSD: observation.costUSD }
      : {}),
  };
}

function sameObservation(a: UsageObservation, b: UsageObservation): boolean {
  return (
    a.costUSD === b.costUSD &&
    a.usage?.input === b.usage?.input &&
    a.usage?.output === b.usage?.output &&
    a.usage?.cacheRead === b.usage?.cacheRead &&
    a.usage?.cacheWrite === b.usage?.cacheWrite &&
    a.usage?.reasoning === b.usage?.reasoning
  );
}

/**
 * Fold each driver dispatch once. Retried dispatches need distinct IDs; replaying
 * the same dispatch ID is idempotent. Call record as soon as the driver settles,
 * then snapshot even if a later step or publication throws.
 */
export function createKnownUsageLedger() {
  const observations = new Map<string, UsageObservation>();
  return {
    record(id: string, observation: UsageObservation): void {
      if (id.length === 0) throw new Error('usage dispatch ID must be nonempty');
      if (observation.usage !== undefined && !validUsage(observation.usage))
        throw new Error(`invalid usage for dispatch ${id}`);
      if (
        observation.costUSD !== undefined &&
        (!Number.isFinite(observation.costUSD) || observation.costUSD < 0)
      )
        throw new Error(`invalid cost for dispatch ${id}`);
      const previous = observations.get(id);
      if (previous !== undefined) {
        if (!sameObservation(previous, observation))
          throw new Error(`conflicting usage for dispatch ${id}`);
        return;
      }
      observations.set(id, {
        ...(observation.usage === undefined ? {} : { usage: { ...observation.usage } }),
        ...(observation.costUSD === undefined ? {} : { costUSD: observation.costUSD }),
      });
    },
    snapshot(): KnownUsageSummary {
      let usage: Usage | undefined;
      let costUSD: number | undefined;
      let knownCount = 0;
      let unknownCount = 0;
      let unpricedCount = 0;
      for (const observation of observations.values()) {
        if (observation.usage === undefined) unknownCount++;
        else {
          knownCount++;
          const measured = observation.usage;
          if (usage === undefined) usage = { ...measured };
          else {
            usage.input += measured.input;
            usage.output += measured.output;
            usage.cacheRead += measured.cacheRead;
            usage.cacheWrite += measured.cacheWrite;
            if (measured.reasoning !== undefined)
              usage.reasoning = (usage.reasoning ?? 0) + measured.reasoning;
          }
        }
        if (observation.costUSD === undefined) unpricedCount++;
        else costUSD = (costUSD ?? 0) + observation.costUSD;
      }
      return {
        ...(usage === undefined ? {} : { usage }),
        ...(costUSD === undefined ? {} : { costUSD }),
        knownCount,
        unknownCount,
        unpricedCount,
      };
    },
  };
}
