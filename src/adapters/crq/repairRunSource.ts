/**
 * Inactive binding of `RepairRunOptions` (repairDispatch) to the central op
 * registry. `runRepairDispatch` already runs the existing kernel (`runPlan`) and
 * reads its file-backed journal; the only caller-owned piece is the read-only
 * registry view, built here the way `run-plan` and the review loop adapt it.
 * Nothing imports this from a runtime entry point.
 */
import type { OpRegistryEntry } from '../../kernel/types.js';
import type { OpRegistryView } from '../../kernel/runner.js';
import type { RepairRunOptions } from '../../ops/crq/internal/repairDispatch.js';
import { list } from '../../registry/index.js';

export interface RepairRunSourceOptions {
  readonly resume: boolean;
  /** Test seam: defaults to the central registry's `list()`. */
  readonly entries?: () => Promise<readonly OpRegistryEntry<unknown, unknown>[]>;
}

/** Resolves the registry lazily at run time (resolving an entry never loads an op). */
export async function fileRepairRunOptions(
  options: RepairRunSourceOptions,
): Promise<RepairRunOptions> {
  const entries = await (options.entries ?? list)();
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const registry: OpRegistryView = {
    // Variance adapter: see kernel/runner.ts `OpRegistryView`.
    get: (name) => byName.get(name) as OpRegistryEntry<never, never> | undefined,
  };
  return { resume: options.resume, registry };
}
