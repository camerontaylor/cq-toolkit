import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
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
import type { PreparedInventory } from '../../ops/crq/backfillTransaction.js';

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

/** Prepare the inventory off lock. Its queue is a private snapshot, not a live write. */
export async function prepareInventory(
  queue: JsonObject,
  enqueue: boolean,
  effects: InventoryPreparationEffects,
): Promise<PreparedInventory> {
  effects.accounting.beginInvocation();
  const input = await effects.acquire();
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
    for (const candidate of ranked.candidates) {
      const members = candidate.prs.flatMap((pr) => {
        const member = input.members[String(pr)];
        return member === undefined ? [] : [member];
      });
      const construction = await construct(effects.subjects, candidate, input.limits, members);
      for (const partition of construction.partitions) {
        const result = effects.enqueue(
          prepared,
          { ...partition, tier_importance: partition['tier'], subject_kind: partition['kind'] },
          effects.now(),
        );
        prepared = result.queue;
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
  return { queue: prepared, ranked, report, eventItems };
}
