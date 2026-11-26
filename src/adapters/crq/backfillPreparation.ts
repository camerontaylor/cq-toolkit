import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { expired, isExecutionOwner, retireSuperseded } from '../../policy/crq/backfillJobs.js';
import {
  capture,
  effectiveLimits,
  replay,
  type BackfillCaptureArtifacts,
} from '../../policy/crq/backfillInventory.js';
import {
  construct,
  type BackfillSubjectRepo,
  type SubjectMember,
} from '../../policy/crq/backfillSubjects.js';
import { findingTriage, summary, type TriageRow } from '../../policy/crq/backfillReport.js';
import {
  fromPlainJson,
  isJsonRecord,
  recordGet,
  withObjectKeys,
} from '../../policy/crq/queueDoc.js';
import type { GitAccountingRepository } from './backfillAccounting.js';
import type { PreparedInventory } from '../../ops/crq/internal/backfillTransaction.js';

/** Inputs acquired after the invocation cache has been reset. */
export interface InventoryInputs {
  readonly target: string;
  readonly ledgerHead: string;
  readonly events: readonly JsonValue[];
  readonly required: unknown;
  readonly tiers: unknown;
  readonly limits: unknown;
  readonly requiredPaths: unknown;
  readonly members: Readonly<Record<string, SubjectMember>>;
  readonly protectedBytes: Uint8Array;
}

export interface InventoryPreparationEffects {
  readonly accounting: GitAccountingRepository;
  readonly subjects: BackfillSubjectRepo;
  readonly artifacts: BackfillCaptureArtifacts & {
    read(reference: unknown): Promise<unknown>;
    verify(reference: unknown): Promise<void>;
  };
  acquire(): Promise<InventoryInputs>;
  now(): string;
  baseline(): Promise<unknown>;
  triage(): Promise<readonly TriageRow[]>;
  enqueue(
    queue: JsonObject,
    partition: Record<string, unknown>,
    at: string,
  ): { queue: JsonObject; item: JsonObject };
}

/**
 * Python's `run_inventory` rules that the operator route does not yet apply.
 * The tick's in-lock inventory opts into both:
 *
 * - `retire`: before capture, pending non-execution-owner jobs at another pin
 *   (or past the 24 h bound) become `skipped` and release their lines;
 * - `enqueueLimit`: stop enqueueing once this many pending jobs sit at the target.
 */
export interface InventoryPreparationOptions {
  readonly retire?: boolean;
  readonly enqueueLimit?: number;
}

const items = (queue: JsonObject): JsonValue[] => {
  const value = queue.get('items') ?? [];
  if (!Array.isArray(value)) throw new Error('inventory queue items must be a list');
  return value;
};

const isPendingBackfillAt = (item: JsonValue, target: string): boolean =>
  item instanceof JsonObject &&
  item.get('kind') === 'backfill' &&
  item.get('state') === 'pending' &&
  item.get('target') === target;

/** Prepare the inventory off lock. Its queue is a private snapshot, not a live write. */
export async function prepareInventory(
  snapshot: JsonObject,
  enqueue: boolean,
  effects: InventoryPreparationEffects,
  options: InventoryPreparationOptions = {},
): Promise<PreparedInventory> {
  effects.accounting.beginInvocation();
  const input = await effects.acquire();
  let queue = snapshot;
  const retired: { id: JsonValue; at: string }[] = [];
  if (enqueue && options.retire === true) {
    // Pending jobs at an older pin own their lines and would hold them out of this ranking.
    const rows = items(queue).map((item) => {
      if (
        !(item instanceof JsonObject) ||
        item.get('kind') !== 'backfill' ||
        item.get('state') !== 'pending' ||
        isExecutionOwner(item)
      )
        return item;
      const at = effects.now();
      if (item.get('target') === input.target && !expired(item, at)) return item;
      retired.push({ id: item.get('id') ?? null, at });
      return retireSuperseded(item, input.target);
    });
    if (retired.length > 0) queue = withObjectKeys(queue, [['items', rows]]);
  }
  const manifest = await capture({
    repo: effects.accounting,
    target: input.target,
    ledgerHead: input.ledgerHead,
    events: input.events,
    artifacts: effects.artifacts,
    queue,
    required: input.required,
    tiers: input.tiers,
    limits: input.limits,
    evaluatedAt: effects.now(),
    requiredPaths: input.requiredPaths,
    protectedBytes: input.protectedBytes,
    members: input.members,
  });
  const ranked = await replay(manifest, effects.artifacts);
  const snapshots = manifest['snapshots'];
  if (!isJsonRecord(snapshots)) throw new Error('inventory snapshots missing');
  const retained = await effects.artifacts.read(recordGet(snapshots, 'queue'));
  if (!isJsonRecord(retained)) throw new Error('inventory queue snapshot missing');
  let prepared = withObjectKeys(queue, [
    [
      'backfill_scope_failures',
      fromPlainJson(recordGet(retained, 'backfill_scope_failures') ?? {}),
    ],
  ]);
  const debt: Record<string, unknown>[] = [];
  const eventItems: JsonValue[] = [];
  if (enqueue) {
    effectiveLimits(input.limits, { requireVerified: true });
    let pending = items(prepared).filter((item) => isPendingBackfillAt(item, input.target)).length;
    for (const candidate of ranked.candidates) {
      if (options.enqueueLimit !== undefined && pending >= options.enqueueLimit) break;
      const members = candidate.prs.flatMap((pr) => {
        const member = input.members[String(pr)];
        return member === undefined ? [] : [member];
      });
      const construction = await construct(effects.subjects, candidate, input.limits, members);
      for (const partition of construction.partitions) {
        const before = items(prepared).length;
        const result = effects.enqueue(
          prepared,
          { ...partition, tier_importance: partition['tier'], subject_kind: partition['kind'] },
          effects.now(),
        );
        prepared = result.queue;
        if (items(prepared).length > before && result.item.get('state') === 'pending') pending += 1;
        const id = result.item.get('id');
        if (id === undefined) throw new Error('inventory item missing id');
        eventItems.push(id);
      }
      debt.push(...construction.debt);
    }
  }
  const triage = findingTriage(await effects.triage());
  prepared = withObjectKeys(prepared, [
    ['backfill_last_manifest', fromPlainJson(manifest)],
    ['backfill_unsupported_construction', fromPlainJson(debt)],
    ['backfill_finding_backlog', fromPlainJson(triage['counts'])],
  ]);
  const report = await summary({
    ranked,
    queue: prepared,
    repo: effects.accounting,
    original: await effects.baseline(),
    triage,
  });
  report['construction_debt'] = debt;
  return {
    queue: prepared,
    ranked,
    report,
    eventItems,
    ...(retired.length > 0 ? { retired } : {}),
  };
}
