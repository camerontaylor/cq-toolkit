// Metric adapter registry for the ratchet op family — lane H slice 1.
//
// The registry is OPEN for extension: any module (first-party or third-party
// source) can register a MetricAdapter under its own id. The metric RUNNER is
// always INJECTED by the caller via MetricSource (lane C's CheckRunner gets
// wired in later); this module must never import from src/gates or
// src/harness, so baseline capture stays computable without a live toolchain.
//
// Failure direction, named: a null reading is NON-PASSING EVIDENCE (I5) —
// "cannot verify this metric", never "the metric passes". Callers must treat
// null as a hold, not a pass.
//
// Serializable boundary: adapters and sources are RUNTIME-ONLY composition
// wiring (like the kernel's OpRegistryEntry). Op inputs never carry them —
// the kernel's makeManifest structuredClones Job.input, and functions cannot
// survive that clone — so op inputs reference them by id (metric id,
// catalog sourceId) instead.
import type { Direction } from './format.js';

/** One measured value plus optional adapter-defined metadata. */
export interface MetricReading {
  value: number;
  unit?: string;
  detail?: Record<string, unknown>;
}

/**
 * Produces the raw source data for one (target, metric) in a workspace:
 * parsed JSON, plain text, anything the adapter understands — or null when
 * no summary exists (I5: that is non-passing evidence, never a pass).
 */
export type MetricSource = (ws: string) => Promise<unknown | null>;

/** A registered metric: registry id, ratchet direction, and raw-data extraction. */
export interface MetricAdapter {
  /** Registry key, e.g. 'typecheck-count'. */
  id: string;
  direction: Direction;
  /** Read a MetricReading out of a MetricSource's raw data; null when raw is unusable/absent. */
  extract(raw: unknown): MetricReading | null;
}

const adapters = new Map<string, MetricAdapter>();

/** Register an adapter under its id; throws on a duplicate id. */
export function registerAdapter(a: MetricAdapter): void {
  if (adapters.has(a.id)) {
    throw new Error(`ratchet: adapter id '${a.id}' is already registered`);
  }
  adapters.set(a.id, a);
}

/** The adapter registered under `id`, or undefined. */
export function getAdapter(id: string): MetricAdapter | undefined {
  return adapters.get(id);
}

/** Registered adapter ids, sorted. */
export function listAdapters(): string[] {
  return [...adapters.keys()].sort();
}
