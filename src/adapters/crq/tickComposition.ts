/**
 * S6-f: the offline composition of every merged tick adapter into one
 * `TickPhases`, plus the slot's `collectFinished`. Inactive: nothing imports
 * this from a runtime entry point, `crq.ts` routes neither `tick` nor `slot`, and
 * `LIVE_UNIT_COMMANDS` and the capabilities are untouched. `tick.lock` stays
 * caller-owned, as everywhere in the TS tick.
 *
 * `composeTickPhases` (composeTick.ts) takes the sixteen `RemainingPhaseNames`
 * from its caller. This module is that caller. It binds each phase to the
 * adapter that owns it:
 *
 *   backfillPublish / backfillInventoryMode / backfillInventory
 *                                   -> localReviewPublish.ts, tickBackfillInventory.ts
 *   discovery / enrollPrimary / enrollOthers   -> tickDiscoveryBinding.ts
 *   resetFixPrBacklog / refreshFixPrBacklog    -> fixPrBacklogSource.ts
 *   harvestItems / reconcileCompleted / collectFinished -> harvestWiring.ts, with the
 *                                      run artifacts a Python child leaves read by harvestRunReads.ts
 *   repairBackfill / archiveLegacy             -> repairBackfillSource.ts
 *   reconcile                                  -> tickReconcilePhaseSource.ts
 *   writeStatus / publishLocalReviewPr / recordClientHealth -> tickReportingSource.ts
 *
 * Gap staging. A phase whose inputs the caller did not supply is bound to a
 * function that rejects with {@link TickGapError}, never to a no-op: Python
 * abandons the rest of a tick on a phase error and saves nothing, so a silent
 * skip would let later phases run against a tick that did less than Python's.
 * Those are the `unbound` gaps. The `staged` gaps are work no merged adapter does
 * yet, whatever the caller supplies; they are why {@link TickComposition.complete}
 * is `false`, and why nothing may route `tick` or `slot` until each is closed.
 */
import { JsonObject, toPlainJsonRetainingNumbers } from '../../policy/crq/jsonValue.js';
import { ForgeBudget } from '../../policy/crq/forgeBudget.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import {
  backfillRepairPresent,
  FixPrBacklog,
  refreshFixPrBacklog,
} from '../../queue-runner/fixPrBacklog.js';
import { repairArchiveLegacy, repairBackfill } from '../../queue-runner/repairBackfill.js';
import type { Item, Queue } from '../../queue-runner/repairBackfill.js';
import type { HarvestReviewEffects } from '../../queue-runner/harvestReview.js';
import { runReconcilePhase } from '../../queue-runner/tickDiscoveryPhase.js';
import type { PhaseResult, TickPhases } from '../../queue-runner/tickOrchestrator.js';
import { LedgerIntegrityError } from '../../policy/crq/ledger.js';
import type { GhFn } from '../forge-github/gh.js';
import { composeTickPhases, type ComposeInput, type RemainingPhaseNames } from './composeTick.js';
import { fileFixPrBacklogEffects } from './fixPrBacklogSource.js';
import { createHarvestPhases, type LocalReviewJsonSeams } from './harvestWiring.js';
import { fileHarvestRunReads } from './harvestRunReads.js';
import { fileLocalReviewPublishEffects } from './localReviewPublish.js';
import { readBackfillRollout } from './backfillRollout.js';
import type { InventoryPreparationOptions } from './backfillPreparation.js';
import type { PreparedInventory } from '../../ops/crq/internal/backfillTransaction.js';
import { fileRepairBackfillEffects, type FileRepairBackfillInput } from './repairBackfillSource.js';
import type { RunGit } from './ledgerGit.js';
import { tickBackfillInventory } from './tickBackfillInventory.js';
import { tickDiscoveryBinding, type TickDiscoveryBindingOptions } from './tickDiscoveryBinding.js';
import { fileTickSeams } from './tickPhaseSeams.js';
import { fileReconcilePhaseEffects } from './tickReconcilePhaseSource.js';
import { fileReportingPhases, type ReportingInput } from './tickReportingSource.js';

export interface TickGap {
  /** Stable key, also the inventory row in docs/crq/tick-slot-missing-effects.md. */
  readonly id: string;
  /** The `TickPhases` members (or effect names) that fail while the gap is open. */
  readonly phases: readonly string[];
  /** The Python behavior the gap stands for. */
  readonly python: string;
  /** What is not ported or not bound. */
  readonly missing: string;
}

/** A phase ran whose effects are not bound yet. Never swallow it: the tick must stop. */
export class TickGapError extends Error {
  override readonly name = 'TickGapError';
  readonly gap: TickGap;

  constructor(gap: TickGap) {
    super(`tick gap ${gap.id}: ${gap.missing} (${gap.python})`);
    this.gap = gap;
  }
}

/** Gaps a caller closes by supplying the matching input to {@link composeFullTick}. */
export const INPUT_GAPS = {
  startOne: {
    id: 'startOne',
    phases: ['admit.startOne'],
    python: 'start_one (crq.py:3198)',
    missing: 'no per-kind StartOneEffects were supplied',
  },
  discovery: {
    id: 'discovery',
    phases: ['discovery', 'enrollPrimary', 'enrollOthers'],
    python: 'crq.tick discovery and enroll (crq.py:3058)',
    missing: 'push and enroll effects were not supplied',
  },
  fixPrBacklog: {
    id: 'fixPrBacklog',
    phases: ['resetFixPrBacklog', 'refreshFixPrBacklog'],
    python: 'repair_tick.refresh_fix_pr_backlog (repair_tick.py:603)',
    missing: 'the open-PR listing (gh pr list) was not supplied',
  },
  repairBackfill: {
    id: 'repairBackfill',
    phases: ['repairBackfill', 'archiveLegacy'],
    python: 'repair_tick.backfill / archive_legacy (repair_tick.py:848/:879)',
    missing: 'git, finding and ledger inputs were not supplied',
  },
  harvest: {
    id: 'harvest',
    phases: ['harvestItems', 'reconcileCompleted', 'collectFinished'],
    python: 'harvest_review, local_review_runtime.reconcile_completed, collect_finished',
    missing: 'local-review seams, harvest_review effects and repair harvest were not supplied',
  },
  reporting: {
    id: 'reporting',
    phases: ['writeStatus', 'publishLocalReviewPr', 'recordClientHealth'],
    python: 'write_status, local_review_pr.publish, client_health.record',
    missing: 'the status and summary roots were not supplied',
  },
} as const satisfies Record<string, TickGap>;

/**
 * Work no merged adapter does, so supplying every input still leaves these open.
 * The list only ever shrinks, one PR per row; `complete` stays false until it is empty.
 */
export const STAGED_GAPS: readonly TickGap[] = [
  {
    id: 'harvest-review-effects',
    phases: ['harvestItems', 'collectFinished'],
    python: 'harvest_review (crq.py:2619)',
    missing:
      'no file-backed HarvestReviewEffects beyond the run-artifact reads: findings.md for non-local kinds, ' +
      'removeWorktree, writeReceipt, repairEnqueue, backfillHarvest, requestPrReview and the coverage seam',
  },
  {
    id: 'repair-harvest-effects',
    phases: ['harvestItems'],
    python: 'repair_tick.harvest (repair_tick.py:422)',
    missing:
      'only the job/result reads are file-backed; worktree, verify, mechanical, markFindingOutcome, ' +
      'cleanupHarvested and publish have no binding',
  },
  {
    id: 'start-one-effects',
    phases: ['admit.startOne'],
    python: 'start_one, launch (crq.py:3198/:2004)',
    missing:
      'per-kind LaunchEffects and CoverageEffects (measureMerged, buildSynthetic, legacyOrigins) have no implementation',
  },
  {
    id: 'usage-context',
    phases: ['admit'],
    python: 'backfill_runtime.usage_context in admit_available',
    missing: 'bindAdmit never calls usageContext',
  },
  {
    id: 'review-child',
    phases: ['admit.startOne'],
    python: 'cmd_review_child, python3 crq.py _review <run_id> (crq.py:2202/:2150)',
    missing:
      '`_review` is not routed in the TS runner; runReviewChild lacks --foreground, the tick kick and backfill proof',
  },
  {
    id: 'repair-parity',
    phases: ['repairBackfill', 'archiveLegacy', 'harvestItems'],
    python: 'repair_tick differential',
    missing: 'repair-side tick passes have no seeded differential against Python (separate S6 row)',
  },
  {
    id: 'shadow-d2',
    phases: ['tick', 'slot'],
    python: 'whole-tick shadow comparison',
    missing: 'the D2 shadow compares the plan only; the composed phases are not shadowed',
  },
];

export interface TickCompositionInput {
  readonly stateRoot: string;
  readonly config: JsonObject;
  /** `crq.CLONE`. */
  readonly clone: string;
  readonly watchdogHome: string;
  /** The heartbeat's `root` field. */
  readonly root: string;
  /** `RUNNER_ROOT`: the checkout whose HEAD `client_health.sha` records. */
  readonly runnerRoot: string;
  /** `crq.REPO`. */
  readonly repo: string;
  readonly now?: () => number;
  readonly usageProbes?: ComposeInput['usageProbes'];
  readonly delivery: ComposeInput['delivery'];
  /** Admission effects; `startOne` absent leaves the `startOne` gap open. */
  readonly admit: Omit<ComposeInput['admit'], 'startOne'> & {
    readonly startOne?: ComposeInput['admit']['startOne'];
  };
  /** One forge runner for discovery, enrollment and reconcile (default: the real `gh`). */
  readonly gh?: GhFn;
  readonly runGit?: RunGit;
  /** Test seam for the in-tick inventory preparation (default: file-backed over `clone`). */
  readonly prepareInventory?: (
    queue: JsonObject,
    enqueue: boolean,
    options: InventoryPreparationOptions,
  ) => Promise<PreparedInventory>;
  readonly discovery?: Pick<TickDiscoveryBindingOptions, 'push' | 'enroll'>;
  readonly fixPrBacklog?: { readonly listOpenPrs: () => Promise<unknown> };
  readonly repairBackfill?: Omit<
    FileRepairBackfillInput,
    'stateRoot' | 'primaryRepo' | 'iso' | 'runsRoot'
  >;
  readonly harvest?: {
    readonly local: LocalReviewJsonSeams;
    readonly reviewReceiptKind: string;
    /** Every `harvest_review` effect except the run-artifact reads this module binds. */
    readonly review: Omit<HarvestReviewEffects, keyof ReturnType<typeof fileHarvestRunReads>>;
    readonly repairHarvest: (q: Queue, item: Item) => Promise<string[]>;
  };
  readonly reporting?: Pick<ReportingInput, 'roots'>;
}

export interface TickComposition {
  readonly phases: TickPhases;
  /** The slot's `collect_finished`; rejects with a {@link TickGapError} while `harvest` is open. */
  collectFinished(queue: JsonObject): Promise<PhaseResult>;
  /** `TICK_BACKLOG`: shared with whatever publishes a fix PR. */
  readonly backlog: FixPrBacklog;
  /** Gaps the caller left open: those phases fail loudly. */
  readonly unbound: readonly TickGap[];
  /** Gaps no input closes. */
  readonly staged: readonly TickGap[];
  /** True only when `unbound` and `staged` are both empty. Never true today. */
  readonly complete: boolean;
}

const gapRejection = (gap: TickGap) => async (): Promise<never> => {
  throw new TickGapError(gap);
};

const toPlain = (queue: JsonObject): Queue => toPlainJsonRetainingNumbers(queue) as Queue;

/** Run a plain-queue (in place) pass over an immutable queue, as the Python tick mutates `q`. */
async function viaPlain(
  queue: JsonObject,
  work: (plain: Queue) => Promise<void>,
): Promise<JsonObject> {
  const plain = toPlain(queue);
  await work(plain);
  return fromPlainJson(plain) as JsonObject;
}

const isoSeconds = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

function durableRoot(rollout: JsonObject): string {
  const root = rollout.get('durable_artifact_root');
  if (typeof root !== 'string' || root === '')
    throw new LedgerIntegrityError('backfill rollout durable_artifact_root missing');
  return root;
}

export function composeFullTick(input: TickCompositionInput): TickComposition {
  const now = input.now ?? Date.now;
  const seams = fileTickSeams({
    stateRoot: input.stateRoot,
    config: input.config,
    ...(input.now ? { now: input.now } : {}),
  });
  const unbound: TickGap[] = [];
  const open = (gap: TickGap): (() => Promise<never>) => {
    unbound.push(gap);
    return gapRejection(gap);
  };

  // --- backfill: fully file-backed from state and clone, so never a gap.
  const inventory = tickBackfillInventory({
    stateRoot: input.stateRoot,
    cloneRoot: input.clone,
    ...(input.prepareInventory ? { prepare: input.prepareInventory } : {}),
  });
  const publish = fileLocalReviewPublishEffects({
    stateRoot: input.stateRoot,
    async rollout() {
      const rollout = await readBackfillRollout(input.stateRoot);
      return rollout === null ? null : { durableArtifactRoot: durableRoot(rollout) };
    },
    saveQueue: (queue) => seams.saveQueue(queue),
  });

  // --- discovery and enrollment.
  const rejectDiscovery = input.discovery ? null : open(INPUT_GAPS.discovery);
  const discovery = input.discovery
    ? tickDiscoveryBinding({
        config: input.config,
        repo: input.repo,
        stateRoot: input.stateRoot,
        ...(input.gh ? { gh: input.gh } : {}),
        ...(input.now ? { now: () => new Date(input.now?.() ?? Date.now()) } : {}),
        push: input.discovery.push,
        // The composed tick runs its `fetch` phase before enrollment (`crq.py:3550`).
        enroll: { ...input.discovery.enroll, primaryFetched: true },
      })
    : null;

  // --- fix-PR backlog: one TICK_BACKLOG shared with the publisher.
  const backlog = new FixPrBacklog();
  const rejectBacklog = input.fixPrBacklog ? null : open(INPUT_GAPS.fixPrBacklog);
  const backlogEffects = input.fixPrBacklog
    ? fileFixPrBacklogEffects({
        stateRoot: input.stateRoot,
        listOpenPrs: input.fixPrBacklog.listOpenPrs,
        nowMs: now,
      })
    : null;

  // --- repair backfill and legacy archive.
  const rejectRepair = input.repairBackfill ? null : open(INPUT_GAPS.repairBackfill);
  const repairEffects = input.repairBackfill
    ? fileRepairBackfillEffects({
        ...input.repairBackfill,
        stateRoot: input.stateRoot,
        runsRoot: `${input.stateRoot}/runs`,
        primaryRepo: input.repo,
        iso: () => isoSeconds(now()),
      })
    : null;

  // --- harvest: the run artifacts are read here; everything else is the caller's effect.
  const rejectHarvest = input.harvest ? null : open(INPUT_GAPS.harvest);
  const harvest = input.harvest
    ? createHarvestPhases({
        local: input.harvest.local,
        reviewReceiptKind: input.harvest.reviewReceiptKind,
        review: {
          ...fileHarvestRunReads({ stateRoot: input.stateRoot, nowMs: now }),
          ...input.harvest.review,
        } as HarvestReviewEffects,
        repairHarvest: input.harvest.repairHarvest,
      })
    : null;

  // --- reconcile: always bound; the reconciled queue comes back through `onSaved`.
  let reconciled: JsonObject | null = null;
  const reconcileEffects = fileReconcilePhaseEffects({
    stateRoot: input.stateRoot,
    clone: input.clone,
    repo: input.repo,
    ...(input.gh ? { gh: input.gh } : {}),
    ...(input.runGit ? { runGit: input.runGit } : {}),
    ...(input.now ? { now: () => new Date(now()) } : {}),
    event: (kind, data) => seams.event(kind, data),
    onSaved: (queue) => {
      reconciled = queue;
    },
  });

  // --- reporting.
  const rejectReporting = input.reporting ? null : open(INPUT_GAPS.reporting);
  const reporting = input.reporting
    ? fileReportingPhases({
        roots: input.reporting.roots,
        config: input.config,
        primaryRepo: input.repo,
        clone: input.clone,
        runnerRoot: input.runnerRoot,
        gh: input.delivery.gh,
        ...(input.now ? { now: input.now } : {}),
      })
    : null;

  const startOneGap = input.admit.startOne ? null : open(INPUT_GAPS.startOne);

  const remaining: Pick<TickPhases, RemainingPhaseNames> = {
    backfillPublish: (queue) => publish.requestPublish(queue),
    backfillInventoryMode: () => inventory.inventoryMode(),
    backfillInventory: (queue) => inventory.inventory(queue),
    discovery: discovery
      ? (q) => discovery.discovery(q)
      : (rejectDiscovery as () => Promise<never>),
    enrollPrimary: discovery
      ? (q, dry) => discovery.enrollPrimary(q, dry)
      : (rejectDiscovery as () => Promise<never>),
    enrollOthers: discovery
      ? (q, dry) => discovery.enrollOthers(q, dry)
      : (rejectDiscovery as () => Promise<never>),
    async resetFixPrBacklog() {
      if (rejectBacklog) return rejectBacklog();
      backlog.reset();
    },
    async refreshFixPrBacklog(queue) {
      if (rejectBacklog || backlogEffects === null)
        return (rejectBacklog as () => Promise<never>)();
      // `if not dry and backfill_repair_present(q)`: a tick with no backfill repair work makes no call.
      if (!backfillRepairPresent(toPlain(queue))) return;
      // `forge_window(ForgeBudget(requests=1, seconds=30))`; a spent budget is a failed read.
      const budget = new ForgeBudget({ requests: 1, seconds: 30 });
      await refreshFixPrBacklog(backlog, {
        ...backlogEffects,
        listOpenPrs: () => {
          budget.take();
          return backlogEffects.listOpenPrs();
        },
      });
    },
    harvestItems: harvest
      ? (q, dry) => harvest.harvestItems(q, dry)
      : (rejectHarvest as () => Promise<never>),
    reconcileCompleted: harvest
      ? (q) => harvest.reconcileCompleted(q)
      : (rejectHarvest as () => Promise<never>),
    repairBackfill: async (queue) =>
      repairEffects === null
        ? (rejectRepair as () => Promise<never>)()
        : viaPlain(queue, (plain) => repairBackfill(plain, repairEffects)),
    archiveLegacy: async (queue) =>
      repairEffects === null
        ? (rejectRepair as () => Promise<never>)()
        : viaPlain(queue, (plain) => repairArchiveLegacy(plain, repairEffects)),
    async reconcile(queue) {
      reconciled = null;
      const log = await runReconcilePhase(queue, reconcileEffects, () => performance.now() / 1000);
      // `reconciled` is set only if an item was installed (and so saved); otherwise q is unchanged.
      return { queue: reconciled ?? queue, log };
    },
    writeStatus: reporting
      ? (q) => reporting.writeStatus(q)
      : (rejectReporting as () => Promise<never>),
    publishLocalReviewPr: reporting
      ? (q) => reporting.publishLocalReviewPr(q)
      : (rejectReporting as () => Promise<never>),
    recordClientHealth: reporting
      ? (q, enabled) => reporting.recordClientHealth(q, enabled)
      : (rejectReporting as () => Promise<never>),
  };

  const admit: ComposeInput['admit'] = {
    ...input.admit,
    startOne: input.admit.startOne ?? (startOneGap as () => Promise<never>),
  };

  const phases = composeTickPhases({
    stateRoot: input.stateRoot,
    config: input.config,
    clone: input.clone,
    watchdogHome: input.watchdogHome,
    root: input.root,
    ...(input.now ? { now: input.now } : {}),
    ...(input.usageProbes ? { usageProbes: input.usageProbes } : {}),
    delivery: input.delivery,
    admit,
    remaining,
  });

  return {
    phases,
    collectFinished: harvest
      ? (q) => harvest.collectFinished(q)
      : (rejectHarvest as () => Promise<never>),
    backlog,
    unbound,
    staged: STAGED_GAPS,
    complete: unbound.length === 0 && STAGED_GAPS.length === 0,
  };
}
