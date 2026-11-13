/**
 * The real `crq-publisher` run route: `backfill_publisher.run` composed from
 * the existing pure seams plus real adapters.
 *
 * Python's structure, kept exactly:
 *
 * 1. `worker_services`: the publication clone
 *    (`state/backfill/publisher.git`, owned by the publication worker, never
 *    scheduler fetches) is initialised bare and its `origin` is pinned to the
 *    scheduler clone's URL; ledger, outbox, inbox and artifact roots all
 *    derive from the state root.
 * 2. `run`: under `backfill/publisher.lock` (never `tick.lock`), read the
 *    publish-request marker; an absent marker with an empty outbox and no
 *    failure marker is `idle`. A missing marker with pending work persists a
 *    reconciliation request first, so a crash before the merge still
 *    reconciles on the next timer run.
 * 3. `publisher.publish(outbox)` runs the validated attempt loop; a fresh
 *    `fetch` then feeds review records to the finding inbox (`ingest` once
 *    per review, `recover` over all events) before any queue write.
 * 4. Queue reconciliation (`reconcile_publication`) runs under the caller's
 *    `tick.lock` seam: completed non-owner backfill items whose
 *    `publication_event_id` the remote validates flip to done with Python's
 *    sibling-family bookkeeping, `review_ledger_head` advances, the
 *    publication error clears, and a request the lock still owns is removed.
 *    A busy tick lock is `reconciliation-pending`: remote work succeeded and
 *    only local bookkeeping waits, so no failure marker is written.
 * 5. Any other failure atomically persists `backfill/publication-failure.json`
 *    and halts the queue (`backfill_halted`/`backfill_halt_operation`) under
 *    the tick lock; marker-write or queue-lock failures become notes on the
 *    original error, never replacements.
 *
 * Effects are injected through `PublishRunEffects`: filesystem roots, the
 * hardened git runner and the tick-lock/queue seam. The adapter binding in
 * `src/adapters/crq/publishSource.ts` realizes them against the production
 * layout; tests bind memory seams. The notification drain and the coverage
 * refresh remain Python-side in this slice and are reported accordingly.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../adapters/crq/atomic.js';
import { withLock } from '../../adapters/crq/lock.js';
import {
  fileArtifactStore,
  fileFindingInbox,
  type ArtifactStore,
} from '../../adapters/crq/findingStore.js';
import { GitLedger, type RunGit } from '../../adapters/crq/ledgerGit.js';
import { FindingInbox } from '../review/internal/crq/findingInbox.js';
import type { FindingInboxFiles } from '../review/internal/crq/findingInbox.js';
import { Outbox, type OutboxFiles } from '../review/internal/crq/outbox.js';
import { publish as publishOutbox } from '../review/internal/crq/publisher.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerLoads,
  ledgerScope,
  ledgerValidateSequence,
} from '../../policy/crq/ledger.js';
import { removeKeys, setKeys } from './internal/publishJsonEdit.js';

/** The coverage slice stays Python-side; the key is always reported. */
export const PUBLISH_COVERAGE_STUB = 'coverage port pending (Python side owns it)' as const;

/** Truncation bound Python applies to persisted error text. */
const ERROR_CHARS = 300;

/** Backfill job marker (`backfill_jobs.KIND`). */
const JOB_KIND = 'backfill';

export class PublishRunError extends Error {
  override readonly name = 'PublishRunError';
}

function integrity(message: string): LedgerIntegrityError {
  return new LedgerIntegrityError(message);
}

/** Python's `str(exc)[:300]`: a code-point slice, never a byte slice. */
function truncated(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return [...text].slice(0, ERROR_CHARS).join('');
}

/** `backfill_jobs.is_execution_owner`: a live/unknown vendor run owns the item. */
function isExecutionOwner(item: JsonObject): boolean {
  const vendorState = item.get('vendor_state');
  return (
    vendorState === 'live' ||
    vendorState === 'unknown' ||
    item.get('run') !== undefined ||
    item.get('state') === 'reviewing' ||
    item.get('state') === 'launch-unknown'
  );
}

/**
 * The injected effects. Every path is explicit; nothing derives from the
 * environment or the working directory here.
 */
export interface PublishRunEffects {
  /** Absolute state root (`state/`). */
  readonly stateRoot: string;
  /** Separately provisioned durable artifact volume. */
  readonly durableArtifactRoot: string;
  /** Hardened git runner over the scheduler clone (`crq.git`'s cwd). */
  readonly runSchedulerGit: RunGit;
  /** Hardened git runner over the publication clone (`GitLedger.git`). */
  readonly runPublisherGit: RunGit;
  /**
   * Optional artifact verifier override (defaults to the durable file store).
   * Python's B1 vector oracle accepts two public synthetic references through
   * exactly such a wrapper; tests replay vectors with the same seam.
   */
  readonly verifyArtifact?: ArtifactStore['verify'];
  /**
   * Python's `with_lock(fn, lock_wait=...)` around `tick.lock`: the callback's
   * return value when it ran, null when the lock stayed busy.
   */
  withTickLock<T>(
    fn: () => Promise<T>,
    options?: { readonly lockWait?: number },
  ): Promise<T | null>;
  /** Read `queue.json` bytes (Python `load_queue`'s read). */
  readQueue(): Promise<Uint8Array>;
  /** Atomically persist the queue document (Python `save_queue`). */
  writeQueue(queue: JsonObject): Promise<void>;
}

/** The route's JSON outcome, Python's `run()` keys. */
export interface PublishRunResult {
  readonly ledger_head?: string;
  readonly publication: 'reconciled' | 'reconciliation-pending' | 'idle';
  /** Set by the caller's `main` wrapper, never by `run` itself. */
  readonly notifications?: string;
}

interface Services {
  readonly ledger: GitLedger;
  readonly artifacts: ArtifactStore;
  /** The effects' verifier (override or the durable store binding). */
  readonly verifyArtifact: ArtifactStore['verify'];
  readonly outbox: Outbox;
  readonly inbox: FindingInbox;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    },
  );
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const bytes = await readFile(path).catch((error: unknown): Buffer | null => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  return bytes === null ? null : new Uint8Array(bytes);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * The real `OutboxFiles` binding over the shared `pending/`+`ack/` layout,
 * with Python's `outbox.lock` inode held through the existing flock adapter.
 */
function fileOutboxFiles(root: string): OutboxFiles {
  const pending = join(root, 'pending');
  const ack = join(root, 'ack');
  const lock = join(root, 'outbox.lock');
  const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
  return {
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      await mkdir(root, { recursive: true });
      return withLock(lock, { wait: true }, fn);
    },
    async listPending(): Promise<readonly string[]> {
      const names = await readdir(pending).catch((error: unknown) => {
        if (codeOf(error) === 'ENOENT') return [] as string[];
        throw error;
      });
      // Python globs `pending/*.json` and reads contents directly; the seam
      // contract ids are bare record ids, so strip the suffix exactly once.
      return names
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
    },
    async readPending(id: string): Promise<Uint8Array | null> {
      return readFileBytes(join(pending, `${id}.json`));
    },
    async writePending(id: string, bytes: Uint8Array): Promise<void> {
      await mkdir(pending, { recursive: true });
      await atomicWrite(join(pending, `${id}.json`), bytes);
    },
    async hasAck(id: string): Promise<boolean> {
      return exists(join(ack, `${id}.json`));
    },
    async writeAck(id: string, bytes: Uint8Array): Promise<void> {
      await mkdir(ack, { recursive: true });
      await atomicWrite(join(ack, `${id}.json`), bytes);
    },
  };
}

/** `worker_services`: publisher-owned bare clone plus the injected stores. */
async function workerServices(effects: PublishRunEffects): Promise<Services> {
  const repoRoot = join(effects.stateRoot, 'backfill', 'publisher.git');
  const origin = await effects.runSchedulerGit(['remote', 'get-url', 'origin']);
  if (origin.code !== 0) {
    throw new PublishRunError('scheduler clone origin unavailable');
  }
  const ledger = new GitLedger({ repo: repoRoot, runGit: effects.runPublisherGit });
  await ledger.ensureBareRepo(new TextDecoder().decode(origin.stdout).trim());
  const artifacts = fileArtifactStore(effects.durableArtifactRoot);
  const artifactVerify = effects.verifyArtifact ?? artifacts.verify.bind(artifacts);
  const publicationRoot = join(effects.stateRoot, 'backfill', 'publication');
  const outboxFiles: OutboxFiles = fileOutboxFiles(publicationRoot);
  const inboxFiles: FindingInboxFiles = fileFindingInbox(
    join(effects.stateRoot, 'backfill', 'findings'),
  );
  return {
    ledger,
    artifacts,
    verifyArtifact: artifactVerify,
    outbox: new Outbox(outboxFiles, {
      async verify(reference: JsonValue): Promise<void> {
        const sha256 = reference instanceof JsonObject ? reference.get('sha256') : undefined;
        const location = reference instanceof JsonObject ? reference.get('location') : undefined;
        if (typeof sha256 !== 'string' || typeof location !== 'string') {
          throw integrity('artifact reference is malformed');
        }
        await artifactVerify({ sha256, location });
      },
    }),
    // The same files seam backs the recovery inbox; the inbox binds it.
    inbox: new FindingInbox(inboxFiles),
  };
}

/**
 * `backfill-rollout.json` settings, reduced to what the publish path reads.
 * An absent file disables publication; present-but-incomplete prerequisites
 * are Python's integrity refusal. The dispatch-side validations (reviewer
 * limits, spool alias shape) belong to the dispatch slice.
 */
async function readRollout(effects: PublishRunEffects): Promise<JsonObject> {
  const filename = join(effects.stateRoot, 'backfill-rollout.json');
  const bytes = await readFileBytes(filename);
  if (bytes === null) throw new PublishRolloutDisabled();
  const value = ledgerLoads(bytes);
  if (!(value instanceof JsonObject)) {
    throw integrity('backfill rollout prerequisites incomplete');
  }
  const required = [
    'operational_ruling',
    'no_live_run_verification',
    'owner_branch_ruleset_evidence',
    'durable_artifact_root',
    'runner_identity',
    'publisher_spool',
  ];
  for (const key of required) {
    const entry = value.get(key);
    if (entry === undefined || entry === null || entry === false || entry === '') {
      throw integrity('backfill rollout prerequisites incomplete');
    }
  }
  if (value.get('runner_identity') !== 'crq-runner-app') {
    throw integrity('backfill rollout prerequisites incomplete');
  }
  return value;
}

/** The rollout file is absent: Python returns `{"publication": "disabled"}`. */
export class PublishRolloutDisabled extends Error {
  override readonly name = 'PublishRolloutDisabled';
}

/**
 * `backfill_publisher.run` over injected effects. Throws after persisting
 * the failure marker and (best effort) halting the queue, exactly Python.
 * `PublishRolloutDisabled` is reported as `disabled`, not a failure.
 */
export async function runPublish(effects: PublishRunEffects): Promise<PublishRunResult> {
  const config = await readRollout(effects);
  await mkdir(join(effects.stateRoot, 'backfill'), { recursive: true });
  const requestPath = join(effects.stateRoot, 'backfill', 'publish-request.json');
  const failurePath = join(effects.stateRoot, 'backfill', 'publication-failure.json');
  const lockPath = join(effects.stateRoot, 'backfill', 'publisher.lock');
  try {
    return await withLock(lockPath, { wait: true }, async () => {
      const services = await workerServices(effects);
      let requested = await readFileBytes(requestPath);
      if (
        requested === null &&
        (await services.outbox.pending()).length === 0 &&
        !(await exists(failurePath))
      ) {
        return { publication: 'idle' };
      }
      if (requested === null) {
        // Persist reconciliation intent even when only the periodic pending
        // scan woke us: remote acknowledgements can precede a crash.
        requested = ledgerCanonicalBytes(
          new JsonObject([['request', randomUUID().replace(/-/g, '')]]),
        );
        await atomicWrite(requestPath, requested);
      }
      await publishOutbox(
        {
          fetch: () => services.ledger.fetch(),
          publish: (batch, baseHead) => services.ledger.publishBatch(batch, baseHead),
        },
        services.outbox,
        {
          verifyArtifact: (reference) => {
            const parsed = ledgerLoads(ledgerCanonicalBytes(reference));
            return services.verifyArtifact({
              sha256: stringField(parsed, 'sha256'),
              location: stringField(parsed, 'location'),
            });
          },
          verifyCreditableReview: () => Promise.resolve(),
          withPublisherLock: (fn) =>
            withLock(
              join(effects.stateRoot, 'backfill', 'review-ledger-publisher.lock'),
              { wait: true },
              fn,
            ),
        },
      );
      // Only a fresh validated fetch is acknowledgement authority.
      const { head, values } = await services.ledger.fetch();
      const ids = ledgerValidateSequence(values);
      for (const value of values) {
        if (value instanceof JsonObject && value.get('event_type') === 'review') {
          await services.inbox.ingest(value);
        }
      }
      await services.inbox.recover(values);

      // Queue reconciliation under the caller's tick lock. A busy lock is
      // routine (spools happen under it): never a failure marker.
      const merged = await effects.withTickLock(
        () => reconcileQueue(effects, config, head, ids, requestPath, failurePath, requested),
        { lockWait: 30 },
      );
      if (merged !== true) {
        return { ledger_head: head, publication: 'reconciliation-pending' };
      }
      return { ledger_head: head, publication: 'reconciled' };
    });
  } catch (error) {
    await recordFailure(effects, error, failurePath);
    throw error;
  }
}

function itemsOf(queue: JsonObject): readonly JsonValue[] {
  const items = queue.get('items');
  return Array.isArray(items) ? items : [];
}

/** A required string field on a parsed artifact reference. */
function stringField(value: JsonValue, key: string): string {
  const field = value instanceof JsonObject ? value.get(key) : undefined;
  if (typeof field !== 'string') throw integrity(`artifact reference ${key} is not a string`);
  return field;
}

/**
 * `reconcile_publication` plus the request bookkeeping Python keeps inside
 * the same `merge()` closure. Returns true when the lock ran the whole
 * merge; the caller distinguishes a busy lock.
 */
async function reconcileQueue(
  effects: PublishRunEffects,
  config: JsonObject,
  head: string,
  ids: ReadonlyMap<string, JsonValue>,
  requestPath: string,
  failurePath: string,
  requested: Uint8Array | null,
): Promise<true> {
  let queue = ledgerLoads(await effects.readQueue());
  if (!(queue instanceof JsonObject)) throw integrity('queue must be an object');
  for (const candidate of itemsOf(queue)) {
    if (!(candidate instanceof JsonObject)) continue;
    const ident = candidate.get('publication_event_id');
    if (
      candidate.get('kind') === JOB_KIND &&
      candidate.get('state') === 'publication-pending' &&
      !isExecutionOwner(candidate) &&
      typeof ident === 'string' &&
      ids.has(ident)
    ) {
      const value = ids.get(ident);
      if (!(value instanceof JsonObject) || value.get('event_type') !== 'review') {
        throw integrity('publication acknowledgement is not a review');
      }
      const updated = publishedTransition(candidate, value, queue);
      const replaced = itemsOf(queue).map((item): JsonValue =>
        item === candidate ? updated : item,
      );
      queue = setKeys(queue, [['items', replaced]]);
    }
  }
  queue = setKeys(queue, [['review_ledger_head', head]]);
  queue = removeKeys(queue, ['backfill_publication_error']);
  queue = clearOperationHalt(queue, 'publication');
  await effects.writeQueue(queue);
  // A concurrent tick request must survive. Pending records are also scanned
  // by every timer invocation, including post-merge events. The failure
  // marker clears inside the same merge, exactly Python.
  if (await exists(failurePath)) {
    await unlink(failurePath);
  }
  if (requested !== null) {
    const current = await readFileBytes(requestPath);
    if (current !== null && bytesEqual(current, requested)) {
      await unlink(requestPath);
    }
  }
  void config;
  return true;
}

/** `backfill_jobs.published`: scope-satisfied completion flips the item. */
function publishedTransition(item: JsonObject, review: JsonObject, queue: JsonObject): JsonObject {
  const payload = review.get('payload');
  if (!(payload instanceof JsonObject)) throw integrity('publication payload missing');
  const reviewedScope = payload.get('reviewed_scope');
  const itemScope = item.get('scope');
  if (reviewedScope === undefined || itemScope === undefined) {
    throw integrity('missing acknowledged completion');
  }
  const remoteId = review.get('id');
  if (item.get('state') !== 'publication-pending' || remoteId === undefined || remoteId === null) {
    throw integrity('missing acknowledged completion');
  }
  const creditedScope = ledgerScope(reviewedScope);
  const requested = ledgerScope(itemScope);
  const pathLineages = item.get('path_lineages');
  const completedUnits: string[] = [];
  for (const [path, byBlob] of requested) {
    for (const [blob, lines] of byBlob) {
      const credited = creditedScope.get(path)?.get(blob);
      if (credited !== undefined && isSubset(lines, credited)) {
        const lineage = pathLineages instanceof JsonObject ? pathLineages.get(path) : undefined;
        completedUnits.push(typeof lineage === 'string' ? lineage : path);
      }
    }
  }
  let updated = item;
  const scopeFailures = queue.get('backfill_scope_failures');
  if (scopeFailures instanceof JsonObject && completedUnits.length > 0) {
    const kept = scopeFailures.entries.filter(
      ([unit]: readonly [string, JsonValue]) => !completedUnits.includes(unit),
    );
    queue = setKeys(queue, [['backfill_scope_failures', new JsonObject(kept)]]);
  }
  let allCovered = true;
  for (const [path, byBlob] of requested) {
    for (const [blob, lines] of byBlob) {
      const credited = creditedScope.get(path)?.get(blob);
      if (credited === undefined || !isSubset(lines, credited)) allCovered = false;
    }
  }
  if (allCovered) {
    const family = item.get('family');
    const families = queue.get('backfill_families');
    if (typeof family === 'string' && families instanceof JsonObject) {
      // Python keeps the family while any non-terminal sibling remains.
      const hasSibling = itemsOf(queue).some(
        (candidate) =>
          candidate instanceof JsonObject &&
          candidate !== item &&
          candidate.get('family') === family &&
          candidate.get('state') !== 'done' &&
          candidate.get('state') !== 'skipped',
      );
      if (!hasSibling) {
        queue = setKeys(queue, [['backfill_families', removeKeys(families, [family])]]);
      }
    }
    updated = setKeys(updated, [['state', 'done']]);
  } else {
    updated = setKeys(updated, [['state', 'partial']]);
  }
  updated = setKeys(updated, [['published_event_id', remoteId]]);
  return updated;
}

function isSubset(subset: ReadonlySet<number>, superset: ReadonlySet<number>): boolean {
  for (const line of subset) if (!superset.has(line)) return false;
  return true;
}

/** `runtime.clear_operation_halt`: only the owning operation clears its halt. */
function clearOperationHalt(queue: JsonObject, operation: string): JsonObject {
  if (queue.get('backfill_halt_operation') === operation) {
    return removeKeys(queue, ['backfill_halted', 'backfill_halt_operation']);
  }
  return queue;
}

/**
 * Python's except block: persist the failure marker and halt the queue,
 * demoting any secondary failure to a note on the original error.
 */
async function recordFailure(
  effects: PublishRunEffects,
  error: unknown,
  failurePath: string,
): Promise<void> {
  let markerError: unknown;
  try {
    await atomicWrite(
      failurePath,
      ledgerCanonicalBytes(new JsonObject([['error', truncated(error)]])),
    );
  } catch (caught) {
    markerError = caught;
  }
  try {
    const halted = await effects.withTickLock(
      async () => {
        const parsed = ledgerLoads(await effects.readQueue());
        if (!(parsed instanceof JsonObject)) throw integrity('queue must be an object');
        const text = truncated(error);
        let queue = setKeys(parsed, [['backfill_publication_error', text]]);
        const previous = queue.get('backfill_halted');
        const previousOperation = queue.get('backfill_halt_operation');
        if (
          previous === undefined ||
          previous === null ||
          previous === false ||
          previous === '' ||
          previousOperation === 'publication'
        ) {
          queue = setKeys(queue, [
            ['backfill_halted', text],
            ['backfill_halt_operation', 'publication'],
          ]);
        }
        await effects.writeQueue(queue);
        return true;
      },
      { lockWait: 30 },
    );
    if (halted !== true && error instanceof Error) {
      note(error, 'publication queue halt remains pending: queue lock unavailable');
    }
  } catch (queueError) {
    if (error instanceof Error) {
      note(error, `publication queue halt could not be persisted: ${truncated(queueError)}`);
    }
  }
  if (markerError !== undefined && error instanceof Error) {
    note(error, `publication failure marker could not be persisted: ${truncated(markerError)}`);
  }
}

/** Python's `exc.add_note`. */
function note(error: Error, text: string): void {
  const holder = error as Error & { notes?: string[] };
  holder.notes ??= [];
  holder.notes.push(text);
}
