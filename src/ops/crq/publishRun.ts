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
 * 3. `publisher.publish(outbox)` runs the validated attempt loop under
 *    Python's publisher lock (inside the publication clone, exactly Python's
 *    inode); a fresh `fetch` then feeds review records to the finding inbox
 *    (`ingest` once per review, `recover` over all events) before any queue
 *    write. Creditable reviews are verified against repository evidence
 *    (`restore` + `verify_review`) before their batch pushes, and pushes run
 *    through the rollout's dedicated `publisher_spool` signer transport.
 * 4. Queue reconciliation (`reconcile_publication`) runs under the caller's
 *    `tick.lock` seam after reloading the rollout (a concurrent configuration
 *    change refuses with Python's retry text and keeps the request marker):
 *    completed non-owner backfill items whose
 *    `publication_event_id` the remote validates flip to done with Python's
 *    sibling-family bookkeeping (including the superseded-sibling exclusion),
 *    `review_ledger_head` advances, the publication error clears, and a
 *    request the lock still owns is removed.
 *    A busy tick lock is `reconciliation-pending`: remote work succeeded and
 *    only local bookkeeping waits, so no failure marker is written.
 * 5. Any other failure atomically persists `backfill/publication-failure.json`
 *    and halts the queue (`backfill_halted`/`backfill_halt_operation`) under
 *    the tick lock; marker-write or queue-lock failures become notes on the
 *    original error, never replacements. A disabled rollout (absent file) is
 *    the `disabled` outcome, not a failure.
 *
 * Effects are injected through `PublishRunEffects`: filesystem roots, the
 * hardened git runner and the tick-lock/queue seam. The adapter binding in
 * `src/adapters/crq/publishSource.ts` realizes them against the production
 * layout; tests bind memory seams. This module is the publication body only:
 * the two daemon phases around it (the notification drain and the off-lock
 * coverage refresh) live in `./notifyDrain.ts` and `./coverageRefresh.ts` and
 * are composed by `./publishUnit.ts`, exactly Python's
 * `backfill_publisher.main`.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicWrite } from '../../adapters/crq/atomic.js';
import { withLock } from '../../adapters/crq/lock.js';
import {
  fileArtifactStore,
  fileFindingInbox,
  type ArtifactStore,
} from '../../adapters/crq/findingStore.js';
import {
  GitLedger,
  LedgerTransportError,
  type PushCommit,
  type RunGit,
} from '../../adapters/crq/ledgerGit.js';
import {
  parsePublisherSpool,
  publisherSpoolPushCommit,
  SpoolConfigError,
} from '../../adapters/crq/publisherSpool.js';
import { FindingInbox } from '../review/internal/crq/findingInbox.js';
import type { FindingInboxFiles } from '../review/internal/crq/findingInbox.js';
import { Outbox, type OutboxFiles } from '../review/internal/crq/outbox.js';
import {
  publish as publishOutbox,
  PublicationPushError,
} from '../review/internal/crq/publisher.js';
import { verifyReview } from '../../adapters/crq/reviewVerify.js';
import {
  JsonObject,
  JsonNumber,
  parseJsonValue,
  pythonNumbersEqual,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerDigestOf,
  ledgerEvent,
  ledgerLoads,
  ledgerScope,
  ledgerValidateSequence,
} from '../../policy/crq/ledger.js';
import { removeKeys, setKeys } from './internal/publishJsonEdit.js';

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

/** Python `bool(value)` over the JSON domain: 0, "", empty containers are false. */
function truthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (value instanceof JsonNumber) {
    if (value.integer !== null) return value.integer !== 0n;
    return value.float !== 0;
  }
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof JsonObject) return value.entries.length > 0;
  return false;
}

/** `backfill_jobs.is_execution_owner`: a live/unknown vendor run owns the item. */
function isExecutionOwner(item: JsonObject): boolean {
  const vendorState = item.get('vendor_state');
  return (
    vendorState === 'live' ||
    vendorState === 'unknown' ||
    truthy(item.get('run')) ||
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
   * Optional publication transport override. Production (the adapter in
   * `publishSource.ts`) leaves this unset so `worker_services` binds the
   * rollout's dedicated `publisher_spool` signer — the only transport, never
   * a direct-push fallback. Vector replay binds a fake, as Python's B1
   * emitter binds a fake Spool.
   */
  readonly pushCommit?: PushCommit;
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
  readonly publication: 'reconciled' | 'reconciliation-pending' | 'idle' | 'disabled';
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

/**
 * Python's `worker_services`' ledger half: the publisher-owned bare clone
 * (initialised bare, `origin` pinned to the scheduler clone's URL) with the
 * rollout's dedicated `publisher_spool` signer as the only transport. The
 * coverage refresher fetches through exactly this clone, so it never moves the
 * scheduler checkpoint.
 */
export async function publisherLedger(
  effects: PublishRunEffects,
  config: JsonObject,
): Promise<GitLedger> {
  const repoRoot = join(effects.stateRoot, 'backfill', 'publisher.git');
  const origin = await effects.runSchedulerGit(['remote', 'get-url', 'origin']);
  if (origin.code !== 0) {
    throw new PublishRunError('scheduler clone origin unavailable');
  }
  // Python's services(): Spool(config['publisher_spool']).publish_ledger is
  // the only transport; a signer-key deployment never falls back to push.
  // Tests bind the fake through the effects seam, like the B1 emitter does.
  const spool = parsePublisherSpool(config.get('publisher_spool'));
  const ledger = new GitLedger({
    repo: repoRoot,
    runGit: effects.runPublisherGit,
    pushCommit: effects.pushCommit ?? publisherSpoolPushCommit(spool),
  });
  await ledger.ensureBareRepo(new TextDecoder().decode(origin.stdout).trim());
  return ledger;
}

/** `worker_services`: publisher-owned bare clone plus the injected stores. */
async function workerServices(effects: PublishRunEffects, config: JsonObject): Promise<Services> {
  const ledger = await publisherLedger(effects, config);
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
 * The queue is a Python-domain document, not a ledger-domain one: Python's
 * `load_queue` accepts finite floats (a `diagnostic: 1.5` queue field is
 * exercised in `test_backfill.py`) and the plain `json.loads` constants
 * `NaN`/`Infinity`/`-Infinity`, while refusing duplicate keys
 * (`unique_pairs`). The rollout reads stay on `ledgerLoads` (its canonical
 * integer domain).
 */
export function parseQueueBytes(bytes: Uint8Array): JsonValue {
  return parseJsonValue(new TextDecoder().decode(bytes), {
    objectPairs: (pairs) => {
      const seen = new Set<string>();
      for (const [key] of pairs) {
        if (seen.has(key)) throw integrity('duplicate JSON key');
        seen.add(key);
      }
      return new JsonObject(pairs);
    },
    parseConstant: (raw) => {
      // Python json.loads: NaN, Infinity, -Infinity.
      if (raw === 'NaN') return JsonNumber.float(Number.NaN, 'NaN');
      if (raw === 'Infinity') return JsonNumber.float(Number.POSITIVE_INFINITY, 'Infinity');
      return JsonNumber.float(Number.NEGATIVE_INFINITY, '-Infinity');
    },
  });
}

/**
 * `backfill-rollout.json` settings, reduced to what the publish path reads.
 * An absent file disables publication; present-but-incomplete prerequisites
 * are Python's integrity refusal, including the dispatch-side `publisher_spool`
 * shape check Python's `settings()` runs on every read.
 *
 * Exported so the coverage refresher reads exactly the same rollout document
 * (`runtime.settings(c.STATE)`), and reports an absent one as `disabled`.
 */
export async function readRollout(effects: PublishRunEffects): Promise<JsonObject> {
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
    // Python: any(not value.get(k) for k in required) raises. bool() over the
    // JSON domain, so {}, [], 0 and "" are all refusals (shared truthy helper).
    if (!truthy(value.get(key))) {
      throw integrity('backfill rollout prerequisites incomplete');
    }
  }
  if (value.get('runner_identity') !== 'crq-runner-app') {
    throw integrity('backfill rollout prerequisites incomplete');
  }
  parsePublisherSpool(value.get('publisher_spool'));
  return value;
}

/** The rollout file is absent: Python returns `{"publication": "disabled"}`. */
export class PublishRolloutDisabled extends Error {
  override readonly name = 'PublishRolloutDisabled';
}

/**
 * `backfill_publisher.run` over injected effects. Throws after persisting
 * the failure marker and (best effort) halting the queue, exactly Python.
 * An absent rollout throws `PublishRolloutDisabled`, the signal the unit
 * (`./publishUnit.ts`) reports as `disabled`.
 */
export async function runPublish(effects: PublishRunEffects): Promise<PublishRunResult> {
  const config = await readRollout(effects);
  await mkdir(join(effects.stateRoot, 'backfill'), { recursive: true });
  const requestPath = join(effects.stateRoot, 'backfill', 'publish-request.json');
  const failurePath = join(effects.stateRoot, 'backfill', 'publication-failure.json');
  const lockPath = join(effects.stateRoot, 'backfill', 'publisher.lock');
  try {
    return await withLock(lockPath, { wait: true }, async () => {
      try {
        return await publishUnderLock(effects, config, requestPath, failurePath);
      } catch (error) {
        // Python keeps the publisher lock held across failure persistence
        // (backfill_publisher.run: the except block runs inside
        // `with ledger.locked(publisher.lock)`), so a second overlapping
        // invocation cannot publish-and-reconcile between this invocation's
        // marker write and its queue halt and leave a stale halt behind.
        await recordFailure(effects, error, failurePath);
        failurePersisted.add(error instanceof Error ? error : {});
        throw error;
      }
    });
  } catch (error) {
    const key = error instanceof Error ? error : undefined;
    if (key === undefined || !failurePersisted.has(key)) {
      await recordFailure(effects, error, failurePath);
    }
    throw error;
  }
}

/** Errors whose failure marker was already persisted under the publisher lock. */
const failurePersisted = new WeakSet<object>();

/**
 * The publish body Python runs inside `with ledger.locked(publisher.lock)`.
 * Failures are persisted by the caller while the lock is still held.
 */
async function publishUnderLock(
  effects: PublishRunEffects,
  config: JsonObject,
  requestPath: string,
  failurePath: string,
): Promise<PublishRunResult> {
  {
    const services = await workerServices(effects, config);
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
        publish: async (batch, baseHead) => {
          try {
            return await services.ledger.publishBatch(batch, baseHead);
          } catch (error) {
            // Python retries only the push; a local failure (index, commit,
            // bundle staging) must surface immediately as an integrity
            // failure, not spin through three attempts as "pending".
            if (
              error instanceof LedgerTransportError &&
              (error.operation === '' || error.operation === 'push')
            ) {
              throw new PublicationPushError(error.message, { cause: error });
            }
            throw error;
          }
        },
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
        // Python's publish loop: repository.restore + Repository.verify_review
        // over the publisher-owned clone (`accounting.Repository(self.repo)`,
        // the publication worker's bare repository) for every creditable
        // record, before the push. Bounding verification to the publisher
        // clone keeps the scheduler clone scheduler-only and refuses commits
        // no retained evidence bundle backs.
        verifyCreditableReview: (value) => {
          if (!(value instanceof JsonObject)) {
            return Promise.reject(integrity('creditable record is not an object'));
          }
          return verifyReview(effects.runPublisherGit, value, (reference) =>
            services.verifyArtifact(reference),
          ).then(() => undefined);
        },
        withPublisherLock: (fn) =>
          publisherLockPath(effects).then((lockPath) => withLock(lockPath, { wait: true }, fn)),
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
      () =>
        reconcileQueue(effects, services, config, head, ids, requestPath, failurePath, requested),
      { lockWait: 30 },
    );
    if (merged !== true) {
      return { ledger_head: head, publication: 'reconciliation-pending' };
    }
    return { ledger_head: head, publication: 'reconciled' };
  }
}

function itemsOf(queue: JsonObject): readonly JsonValue[] {
  const items = queue.get('items');
  return Array.isArray(items) ? items : [];
}

/**
 * `runtime.state_event(..., "remote publication acknowledged")`: spool one
 * durable `job-state` record for the acknowledged transition and record its
 * id under `backfill_state_events`, keyed by the payload digest so a replay
 * (same item seen again after a partial merge) never spools twice. A record
 * already retained in the outbox with the same source key is reused verbatim.
 */
async function spoolAcknowledgedEvent(
  effects: PublishRunEffects,
  services: Services,
  queue: JsonObject,
  item: JsonObject,
  review: JsonObject,
): Promise<JsonObject> {
  if (item.get('kind') !== JOB_KIND) return queue;
  const family = item.get('family');
  const subjectId = item.get('subject_id');
  const jobId = item.get('job_id');
  if (typeof family !== 'string' || typeof subjectId !== 'string' || typeof jobId !== 'string') {
    return queue;
  }
  const occurredAt = review.get('occurred_at');
  if (typeof occurredAt !== 'string') return queue;
  const payload = new JsonObject([
    ['family', family],
    ['subject_id', subjectId],
    ['job_id', jobId],
    ['generation', item.get('generation') ?? JsonNumber.int(0)],
    ['attempt', item.get('attempt') ?? JsonNumber.int(0)],
    ['state', item.get('state') ?? ''],
    ['failures', item.get('family_failures') ?? JsonNumber.int(0)],
    ['next_eligible_at', item.get('not_before') ?? null],
    ['reason', 'remote publication acknowledged'],
  ]);
  const events = queue.get('backfill_state_events');
  const byKey = events instanceof JsonObject ? events : new JsonObject([]);
  const sourceKey = `job:${jobId}:${digestJson(payload)}`;
  const saved = byKey.get(sourceKey);
  if (saved !== undefined && saved !== null && saved !== false && saved !== '') return queue;
  // Reuse an already-retained record with the same source key; otherwise mint
  // the canonical event (validate + derive id like Python's ledger.event).
  let value: JsonObject | undefined;
  for (const retained of await services.outbox.retained()) {
    if (retained instanceof JsonObject && retained.get('source_key') === sourceKey) {
      value = retained;
      break;
    }
  }
  if (value === undefined) {
    value = ledgerEvent('job-state', sourceKey, occurredAt, payload);
    await services.outbox.spool(value);
  }
  const kept = byKey.entries.filter(([key]) => key !== sourceKey);
  kept.push([sourceKey, value.get('id') ?? '']);
  return setKeys(queue, [['backfill_state_events', new JsonObject(kept)]]);
}

/** A required string field on a parsed artifact reference. */
function stringField(value: JsonValue, key: string): string {
  const field = value instanceof JsonObject ? value.get(key) : undefined;
  if (typeof field !== 'string') throw integrity(`artifact reference ${key} is not a string`);
  return field;
}

/**
 * Python's publisher lock: `(GitLedger.repo / git-common-dir).resolve() /
 * review-ledger-publisher.lock` (review_ledger.py:574-577). For the bare
 * publisher clone that resolves inside `state/backfill/publisher.git`, so a
 * Python and a TypeScript publisher on one state root share the inode.
 *
 * Exported for the coverage refresher, which fetches the ledger under this
 * same lock (`backfill_coverage.run`'s `ledger.locked(publisher.lock)`).
 */
export async function publisherLockPath(effects: PublishRunEffects): Promise<string> {
  const repoRoot = join(effects.stateRoot, 'backfill', 'publisher.git');
  const probe = await effects.runPublisherGit(['rev-parse', '--git-common-dir']);
  if (probe.code !== 0) {
    throw new PublishRunError('publisher clone common directory unavailable');
  }
  const common = new TextDecoder().decode(probe.stdout).trim();
  const base = isAbsolute(common) ? common : join(repoRoot, common);
  return join(resolve(base), 'review-ledger-publisher.lock');
}

/**
 * `reconcile_publication` plus the request bookkeeping Python keeps inside
 * the same `merge()` closure. Returns true when the lock ran the whole
 * merge; the caller distinguishes a busy lock.
 */
async function reconcileQueue(
  effects: PublishRunEffects,
  services: Services,
  config: JsonObject,
  head: string,
  ids: ReadonlyMap<string, JsonValue>,
  requestPath: string,
  failurePath: string,
  requested: Uint8Array | null,
): Promise<true> {
  // Python's merge closure reloads settings under tick.lock and refuses a
  // concurrent rollout change before touching the queue; the request marker
  // survives for a retry against the current configuration.
  let current: JsonObject;
  try {
    current = await readRollout(effects);
  } catch (error) {
    if (
      error instanceof PublishRolloutDisabled ||
      error instanceof SpoolConfigError ||
      (error instanceof LedgerIntegrityError && /publisher_spool/.test(error.message))
    ) {
      throw integrity('publication configuration changed; retry reconciliation');
    }
    throw error;
  }
  if (!jsonEqual(current, config)) {
    throw integrity('publication configuration changed; retry reconciliation');
  }
  let queue = parseQueueBytes(await effects.readQueue());
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
      const replaced = itemsOf(updated.queue).map((item): JsonValue =>
        item === candidate ? updated.item : item,
      );
      queue = setKeys(updated.queue, [['items', replaced]]);
      // Python's state_event: spool the durable "remote publication
      // acknowledged" job-state transition and record its id at queue level,
      // keyed so a replay never spools twice.
      queue = await spoolAcknowledgedEvent(effects, services, queue, updated.item, value);
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
    const latest = await readFileBytes(requestPath);
    if (latest !== null && bytesEqual(latest, requested)) {
      await unlink(requestPath);
    }
  }
  return true;
}

/**
 * `backfill_jobs.published` result: the updated item plus the updated queue
 * document (scope-failure removal and family release live at queue level).
 */
interface PublishedTransition {
  readonly item: JsonObject;
  readonly queue: JsonObject;
}

/** `backfill_jobs.published`: scope-satisfied completion flips the item. */
function publishedTransition(
  item: JsonObject,
  review: JsonObject,
  queueInput: JsonObject,
): PublishedTransition {
  let queue = queueInput;
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
      // Python keeps the family while any non-terminal, non-superseded
      // sibling remains: a superseded sibling (blocked/failed, not an
      // execution owner, same scope_digest, lower generation) never retains
      // the family's failure history against a successful replan.
      const itemGeneration = numericOr(item.get('generation'), 0);
      const itemDigest = item.get('scope_digest');
      const hasSibling = itemsOf(queue).some((candidate) => {
        if (!(candidate instanceof JsonObject) || candidate === item) return false;
        if (candidate.get('family') !== family) return false;
        const state = candidate.get('state');
        if (state === 'done' || state === 'skipped') return false;
        if (
          (state === 'blocked' || state === 'failed') &&
          !isExecutionOwner(candidate) &&
          candidate.get('scope_digest') === itemDigest &&
          numericOr(candidate.get('generation'), 0) < itemGeneration
        ) {
          return false;
        }
        return true;
      });
      if (!hasSibling) {
        queue = setKeys(queue, [['backfill_families', removeKeys(families, [family])]]);
      }
    }
    updated = setKeys(updated, [['state', 'done']]);
  } else {
    updated = setKeys(updated, [['state', 'partial']]);
  }
  updated = setKeys(updated, [['published_event_id', remoteId]]);
  return { item: updated, queue };
}

function isSubset(subset: ReadonlySet<number>, superset: ReadonlySet<number>): boolean {
  for (const line of subset) if (!superset.has(line)) return false;
  return true;
}

/** Structural equality over the JSON domain (Python `==` on parsed JSON).
 * Exported for the numeric-equality regression tests. */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a instanceof JsonNumber || b instanceof JsonNumber) {
    // Python `==` on numbers: 1 == 1.0, and exponent/lexeme forms like 1e0
    // compare by value, not raw text (a reformat must not read as a rollout
    // change). Exact for integers above Number.MAX_SAFE_INTEGER.
    return pythonNumbersEqual(a, b) === true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (a instanceof JsonObject || b instanceof JsonObject) {
    if (!(a instanceof JsonObject) || !(b instanceof JsonObject)) return false;
    if (a.entries.length !== b.entries.length) return false;
    return a.entries.every(([key, value]) => {
      if (!b.has(key)) return false;
      return jsonEqual(value, b.get(key));
    });
  }
  return false;
}

/** `review_ledger.digest`: canonical bytes hashed over the payload domain. */
function digestJson(value: JsonValue): string {
  return ledgerDigestOf(value);
}

/** Python's `value.get(key, default)` for the numeric fields of the sibling rule. */
function numericOr(value: JsonValue | undefined, fallback: number): number {
  if (value instanceof JsonNumber) {
    if (value.integer !== null) return Number(value.integer);
    if (value.float !== null) return value.float;
  }
  return fallback;
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
        const parsed = parseQueueBytes(await effects.readQueue());
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
