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
// The type-only references below are the family-surface declarations the
// registry scan checks (test/cli/registry.family-scan.test.ts, the
// `./<base>` rule): readOnlyStatus.ts and statusWriter.ts are deliberately
// surface, not orphan op modules.
import type { OpRegistryEntry } from '../../kernel/types.js';
import type { runAuthorCapability } from './authorCapability.js';
import type { BackfillInventoryEffects, BackfillRouteResult } from './backfillInventory.js';
import type { runQueueCapability } from './queueCapability.js';
import type { CommandResult, ReadOnlyStatusEffects } from './readOnlyStatus.js';
import type { PublishRunResult } from './publishRun.js';
import type { runReviewCapability } from './reviewCapability.js';
import type { CrqDocuments, StatusWriterEffects } from './statusWriter.js';

/** The A1 read-only route's callable surface, bound to effects by its adapter. */
export type CrqReadOnlyRoute = (
  argv: readonly string[],
  effects: ReadOnlyStatusEffects,
) => Promise<CommandResult>;

/** The A1 write route's callable surface, bound to effects by its adapter. */
export type CrqStatusWriterRoute = (
  effects: StatusWriterEffects,
  documents: CrqDocuments,
) => Promise<{
  readonly markdown: string;
  readonly status: Record<string, unknown>;
  readonly summary: Record<string, unknown> | null;
  readonly publishFailure?: { readonly event: 'summary_failed'; readonly error: string };
}>;

/**
 * The queue-v1 capability's callable surface. It registers no dispatch name: it
 * is served as the SSH forced command (`crq queue-capability`), with policy and
 * principal from the environment and the request frame on stdin, so
 * `src/adapters/crq/queueCapabilityMain.ts` binds its effects instead of the
 * central dispatcher calling it by name.
 */
export type CrqQueueCapability = typeof runQueueCapability;

/**
 * The review-v1 capability's callable surface. It too is served as an SSH
 * forced command (`crq review-v1`), never dispatched by name: the adapter
 * `src/adapters/crq/reviewCapabilityMain.ts` binds its effects.
 */
export type CrqReviewCapability = typeof runReviewCapability;

/**
 * The author-v1 capability's callable surface, served as `crq author-v1` by
 * `src/adapters/crq/authorCapabilityMain.ts`. No dispatcher name is declared.
 */
export type CrqAuthorCapability = typeof runAuthorCapability;

/** No dispatchable ops yet: A1 ships the route plus its file adapter. */
export const registry: OpRegistryEntry[] = [];

/**
 * The S3 publish route (`./publishRun.js`) is family surface wired by the
 * live runner (queue-runner LIVE_UNIT_COMMANDS -> crq.ts -> publishSource),
 * not a JSON-dispatchable op: the type-only import above declares it so the
 * family scan does not classify it as an orphan module.
 */
export type { PublishRunResult };

/**
 * The S4 backfill inventory route (`./backfillInventory.js`) is family surface
 * wired by the live runner (`queue-runner` operator-live `backfill` ->
 * `crq.ts` -> `adapters/crq/backfillSource`), not a JSON-dispatchable op: the
 * type-only import above declares it so the family scan does not classify it as
 * an orphan module.
 */
export type { BackfillInventoryEffects, BackfillRouteResult };
