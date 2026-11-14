/**
 * Backfill inventory route: replay a retained capture, rank it, render the
 * report.
 *
 * The Python oracle is `apps/crq-python/backfill.py` (`inventory`) over
 * `backfill_inventory.replay` and `backfill_report.summary`. This route owns the
 * wiring that Python keeps in `backfill_runtime`: reading the rollout
 * configuration, loading the retained manifest and its artifacts, folding the
 * finding backlog and writing the two derived report artifacts.
 *
 * Scope boundary (deliberate, and refused rather than half-done):
 *
 * - capture (Git inventory, blame, lineage, coverage folding, churn) and
 *   subject construction/pinning belong to the accounting adapter. Without
 *   them this route cannot enqueue live work, so `inventory` without
 *   `--report-only` is a refusal, never a silent report;
 * - a pinned T0 baseline needs `lineage`/`proven_deleted`/`carry` over Git, so a
 *   present baseline is refused instead of being reported as unreviewed debt.
 *
 * Everything this route writes is derived: `latest-ranked.json` and
 * `latest-report.json`. It never rewrites `queue.json`, because a replay has no
 * queue delta to apply.
 */
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { ledgerJsonBytes } from '../../policy/crq/pythonJson.js';
import { ledgerLoads } from '../../policy/crq/ledger.js';
import {
  BackfillInventoryError,
  replay,
  type BackfillRanked,
} from '../../policy/crq/backfillInventory.js';
import {
  BackfillReportError,
  findingTriage,
  summary,
  type BackfillReportRepo,
  type TriageRow,
} from '../../policy/crq/backfillReport.js';
import {
  isJsonRecord,
  pyTruthy,
  recordEntries,
  recordGet,
  type JsonRecordLike,
} from '../../policy/crq/queueDoc.js';

/** One retained artifact reference (`review_ledger.ArtifactStore`). */
export interface BackfillArtifactReference {
  readonly sha256: string;
  readonly location: string;
}

/** One triage row file as the adapter read it. */
export interface BackfillTriageFile {
  /** The file name under `backfill/findings/triage`. */
  readonly file: string;
  readonly bytes: Uint8Array;
}

/** The retained artifact store for the rollout's durable volume. */
export interface BackfillArtifactStore {
  /** `review_ledger.ArtifactStore.verify`: containment plus content digest. */
  verify(reference: BackfillArtifactReference): Promise<void>;
  /** The verified artifact, decoded as JSON. */
  read(reference: BackfillArtifactReference): Promise<unknown>;
}

/** Every effect this route may perform. */
export interface BackfillInventoryEffects {
  /** `state/queue.json` text. */
  readQueue(): Promise<string>;
  /** `state/backfill-rollout.json` text, or `null` when the file is absent. */
  readRollout(): Promise<string | null>;
  /** `state/backfill/baseline.json` text, or `null` when absent. */
  readBaseline(): Promise<string | null>;
  /** The remaining triage rows, unread beyond their bytes. */
  readTriage(): Promise<readonly BackfillTriageFile[]>;
  /** The store bound to the rollout's `durable_artifact_root`. */
  artifacts(durableArtifactRoot: string): BackfillArtifactStore;
  /** Write `state/backfill/latest-ranked.json` (canonical JSON bytes). */
  writeRanked(bytes: Uint8Array): Promise<void>;
  /** Write `state/backfill/latest-report.json` (canonical JSON bytes). */
  writeReport(bytes: Uint8Array): Promise<void>;
}

/** A refusal with a stable class for the operator artifact. */
export class BackfillRouteError extends Error {
  override readonly name: string = 'BackfillRouteError';
  readonly kind: 'usage' | 'refused' | 'invalid';

  constructor(kind: 'usage' | 'refused' | 'invalid', message: string) {
    super(message);
    this.kind = kind;
  }
}

export type BackfillRouteResult =
  | { readonly artifact: { readonly status: 'ok'; readonly value: unknown }; readonly exitCode: 0 }
  | {
      readonly artifact: { readonly status: 'failed'; readonly error: string };
      readonly exitCode: 2 | 3;
    };

function usage(message: string): BackfillRouteResult {
  return {
    artifact: { status: 'failed', error: message },
    exitCode: 2,
  };
}

/** Python's `backfill.main` error path: one JSON error and exit 3. */
function refused(message: string): BackfillRouteResult {
  return { artifact: { status: 'failed', error: message }, exitCode: 3 };
}

/**
 * The rollout prerequisite check (`backfill_runtime.settings`).
 *
 * Every prerequisite an enqueue or a replay depends on is validated here, so a
 * half-provisioned rollout refuses rather than reporting over a guessed root.
 */
export function rolloutSettings(value: unknown): {
  readonly durableArtifactRoot: string;
  readonly enabled: boolean;
} {
  if (!isJsonRecord(value))
    throw new BackfillRouteError('invalid', 'backfill rollout prerequisites incomplete');
  for (const key of [
    'operational_ruling',
    'no_live_run_verification',
    'owner_branch_ruleset_evidence',
    'durable_artifact_root',
    'runner_identity',
    'publisher_spool',
  ]) {
    if (!pyTruthy(recordGet(value, key))) {
      throw new BackfillRouteError('invalid', 'backfill rollout prerequisites incomplete');
    }
  }
  if (recordGet(value, 'runner_identity') !== 'crq-runner-app') {
    throw new BackfillRouteError('invalid', 'backfill rollout prerequisites incomplete');
  }
  const spool = recordGet(value, 'publisher_spool');
  const invalid = (): never => {
    throw new BackfillRouteError(
      'invalid',
      'backfill rollout publisher_spool incomplete or invalid',
    );
  };
  if (!isJsonRecord(spool)) invalid();
  // Bound once so the narrowing survives the `never`-returning check above.
  const spoolRecord = spool as JsonRecordLike;
  for (const [key] of recordEntries(spoolRecord)) {
    if (key !== 'ssh_alias' && key !== 'ssh_key' && key !== 'key') invalid();
  }
  const alias = recordGet(spoolRecord, 'ssh_alias');
  const key = pyTruthy(recordGet(spoolRecord, 'ssh_key'))
    ? recordGet(spoolRecord, 'ssh_key')
    : recordGet(spoolRecord, 'key');
  if (
    typeof alias !== 'string' ||
    !/^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(alias)
  ) {
    invalid();
  }
  if (typeof key !== 'string' || key.trim() === '' || /[\n\r\0]/.test(key)) invalid();
  return {
    durableArtifactRoot: recordGet(value, 'durable_artifact_root') as string,
    enabled: recordGet(value, 'enabled') === true,
  };
}

/** A repo seam that only ever refuses: the report needs it for a pinned baseline. */
const ACCOUNTING_SEAM_REPO: BackfillReportRepo = {
  tree: () => Promise.reject(accountingSeam()),
  lineage: () => Promise.reject(accountingSeam()),
  provenDeleted: () => Promise.reject(accountingSeam()),
  carry: () => Promise.reject(accountingSeam()),
};

function accountingSeam(): BackfillRouteError {
  return new BackfillRouteError(
    'refused',
    'baseline accounting requires the git lineage/carry seam, which this runtime does not implement',
  );
}

function artifactReference(value: unknown): BackfillArtifactReference {
  if (!isJsonRecord(value)) {
    throw new BackfillRouteError('invalid', 'artifact reference is malformed');
  }
  const sha256 = recordGet(value, 'sha256');
  const location = recordGet(value, 'location');
  if (typeof sha256 !== 'string' || typeof location !== 'string') {
    throw new BackfillRouteError('invalid', 'artifact reference is malformed');
  }
  return { sha256, location };
}

/** Decode a canonical JSON document; a malformed file is a refusal, not a guess. */
function parseCanonical(text: string, what: string): unknown {
  try {
    return parseJsonValue(text);
  } catch (error) {
    throw new BackfillRouteError(
      'invalid',
      `${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `crq backfill inventory [--report-only]`.
 *
 * Only the replay/report mode exists in this runtime; the enqueue mode would
 * need capture and subject construction, so it is refused with `--report-only`
 * named as the implemented form.
 */
export async function runBackfillInventory(
  argv: readonly string[],
  effects: BackfillInventoryEffects,
): Promise<BackfillRouteResult> {
  let reportOnly = false;
  for (const arg of argv) {
    if (arg === '--report-only') {
      if (reportOnly) return usage('duplicate --report-only');
      reportOnly = true;
      continue;
    }
    return usage(`unknown argument: ${arg}`);
  }
  try {
    const rolloutText = await effects.readRollout();
    if (rolloutText === null) {
      return refused('owner-provisioned rollout configuration is absent');
    }
    const config = rolloutSettings(parseCanonical(rolloutText, 'backfill-rollout.json'));
    if (!reportOnly) {
      // The oracle's own gate first: a disabled rollout is the operator's answer,
      // and it is more precise than naming this runtime's capture gap.
      if (!config.enabled)
        return refused('operator rollout must be enabled before inventory enqueue');
      return refused(
        'inventory enqueue requires capture and subject construction, which this runtime does not implement; pass --report-only to replay the retained manifest',
      );
    }
    const queueValue = parseCanonical(await effects.readQueue(), 'queue.json');
    if (!(queueValue instanceof JsonObject)) {
      return refused('queue.json is not an object');
    }
    const manifest = recordGet(queueValue, 'backfill_last_manifest');
    if (manifest === undefined || manifest === null) {
      return refused('no retained inventory manifest; inventory capture has not run');
    }
    const baseline = await effects.readBaseline();
    if (baseline !== null) {
      return refused(accountingSeam().message);
    }
    const store = effects.artifacts(config.durableArtifactRoot);
    const artifacts = {
      verify: (reference: unknown) => store.verify(artifactReference(reference)),
      read: (reference: unknown) => store.read(artifactReference(reference)),
    };
    const ranked: BackfillRanked = await replay(manifest, artifacts);
    const triageRows: TriageRow[] = [];
    for (const row of await effects.readTriage()) {
      triageRows.push({ file: row.file, value: ledgerLoads(row.bytes) });
    }
    const report = await summary({
      ranked,
      queue: queueValue,
      repo: ACCOUNTING_SEAM_REPO,
      // Python's `run_inventory` always passes the findings root, so the report
      // always carries a triage section (empty counts included), never the
      // queue's stale backlog copy.
      triage: findingTriage(triageRows),
    });
    // Python's report-only path constructs nothing, so its construction debt is
    // empty rather than absent.
    report['construction_debt'] = [];
    await effects.writeRanked(ledgerJsonBytes(ranked));
    await effects.writeReport(ledgerJsonBytes(report));
    return { artifact: { status: 'ok', value: report }, exitCode: 0 };
  } catch (error) {
    if (error instanceof BackfillRouteError) {
      return refused(error.message);
    }
    if (error instanceof BackfillInventoryError || error instanceof BackfillReportError) {
      return refused(error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return refused(message);
  }
}
