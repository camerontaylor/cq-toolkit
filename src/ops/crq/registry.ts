// CRQ family registry (A1 read-only slice + C1 internal repair-prepare helper).
//
// The A1 route in './readOnlyStatus.js' is family surface, not a
// JSON-dispatchable op yet: its effects (queue/config/events/receipt reads and
// one clock reading) are injected by the adapter in
// `src/adapters/crq/statusSource.ts`, which owns stdio and the runner/state
// roots. The watchdog and fleet-reader entry points land as op-shaped entries
// with the rest of A1; until then the family declares an EMPTY registry so the
// central scan does not treat the new family directory as a skipped family
// (the closure asserted by test/cli/registry.subcommand-surface.test.ts).
//
// The C1 repair-prepare slice lands `internal/repairPrepare.ts` as an offline
// library helper, not an op: it registers no name, defines no input schema and
// has no importer. It stays under `internal/`, so the family scan has no
// direct-module surface to declare here.
//
// The type-only reference below is the family-surface declaration the registry
// scan checks (test/cli/registry.family-scan.test.ts, the `./<base>` rule):
// readOnlyStatus.ts is deliberately surface, not an orphan op module.
import type { OpRegistryEntry } from '../../kernel/types.js';
import type { runQueueCapability } from './queueCapability.js';
import type { CommandResult, ReadOnlyStatusEffects } from './readOnlyStatus.js';

/** The A1 read-only route's callable surface, bound to effects by its adapter. */
export type CrqReadOnlyRoute = (
  argv: readonly string[],
  effects: ReadOnlyStatusEffects,
) => Promise<CommandResult>;

/**
 * The queue-v1 capability's callable surface. It registers no dispatch name: it
 * is served as the SSH forced command (`crq queue-capability`), with policy and
 * principal from the environment and the request frame on stdin, so
 * `src/adapters/crq/queueCapabilityMain.ts` binds its effects instead of the
 * central dispatcher calling it by name.
 */
export type CrqQueueCapability = typeof runQueueCapability;

/** No dispatchable ops yet: A1 ships the route plus its file adapter. */
export const registry: OpRegistryEntry[] = [];
