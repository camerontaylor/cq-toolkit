/**
 * Review capability effects bound to one runner's state and clone.
 *
 * Reads and writes stay crash-safe and Python-compatible: the queue keeps its
 * indented canonical form, receipts are verified against their filename digest,
 * record events are validated before they enter the publisher's outbox, and
 * every artifact reference is checked against the configured durable store.
 * Git runs through the bounded helper, so a snapshot or history call can never
 * outlive the forced command.
 */
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonNumber, JsonObject as ObjectValue } from '../../policy/crq/jsonValue.js';
import type { JsonObject } from '../../policy/crq/jsonValue.js';
import { parseJsonValue } from '../../policy/crq/jsonValue.js';
import {
  ledgerCanonicalBytes,
  ledgerValidate,
  LedgerIntegrityError,
} from '../../policy/crq/ledger.js';
import { pythonJsonText, sha256Hex } from '../../policy/crq/pythonJson.js';
import { GitUnavailable, type GitFn } from '../../policy/crq/reviewHistory.js';
import { ValueError } from '../../policy/crq/reviewAdmission.js';
import { MAX_EVENT_BYTES } from '../../policy/crq/reviewRecord.js';
import { MAX_RECEIPT_BYTES } from '../../policy/crq/queueReceipt.js';
import type { ReviewCapabilityEffects } from '../../ops/crq/reviewCapability.js';
import { atomicWrite } from './atomic.js';
import { loadQueueDocument, queueBytes, queueEffectPaths } from './queueEffects.js';
import { withLock } from './lock.js';
import { SlotBusyError } from '../lock/slotLock.js';
import { GitPool, gitCall, gitOk } from './gitExec.js';
import { installAuthorSnapshot } from './authorSnapshotInstall.js';

export interface ReviewEffectsOptions {
  readonly root: string;
  readonly repo: string;
  readonly config: JsonObject;
  readonly pool: GitPool;
  readonly now?: () => Date;
}

/** `crq.UNIVERSAL_SCAN_CLASSES`: the secret shapes every repository scans. */
const UNIVERSAL_SCAN_CLASSES = [
  'class:token-ssh-plumbing',
  'class:route-key-material',
  'class:key-material-env',
  'class:inline-secret-assignments',
] as const;

export interface ReviewEffectsBundle {
  readonly effects: ReviewCapabilityEffects;
  /** Kill every live Git child (the forced-command deadline). */
  readonly terminate: () => void;
}

function isoUtc(clock: Date): string {
  return `${clock.toISOString().slice(0, 19)}Z`;
}

function isoNow(clock: () => Date): string {
  return isoUtc(clock());
}

function objectOrNull(value: unknown): JsonObject | null {
  return value instanceof ObjectValue ? value : null;
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Build the review effects and their Git kill switch. */
export function createReviewEffects(options: ReviewEffectsOptions): ReviewEffectsBundle {
  const clock = options.now ?? (() => new Date());
  const paths = queueEffectPaths(options.root);
  const state = paths.stateRoot;
  const pool = options.pool;
  const repos = arrayOrEmpty(options.config.get('repos'))
    .map(objectOrNull)
    .filter((entry): entry is JsonObject => entry !== null);

  const repoEntry = (repo: string): JsonObject | null => {
    if (sameRepo(repo, options.repo)) return null;
    return (
      repos.find((entry) => {
        const slug = entry.get('repo');
        return typeof slug === 'string' && sameRepo(slug, repo);
      }) ?? null
    );
  };

  const cloneFor = (repo: string): string => {
    if (sameRepo(repo, options.repo)) {
      const clone = options.config.get('clone');
      if (typeof clone !== 'string' || clone.length === 0) {
        throw new ValueError('runner clone is not configured');
      }
      return clone;
    }
    const entry = repoEntry(repo);
    const clone = entry?.get('clone');
    if (entry === null || typeof clone !== 'string' || clone.length === 0) {
      throw new ValueError('unconfigured review repository');
    }
    return clone;
  };

  const historyGit = (repo: string): GitFn => {
    const clone = cloneFor(repo);
    return async (...args: string[]): Promise<Uint8Array> => {
      const result = await gitCall(pool, clone, args);
      if (result.code !== 0) {
        throw new GitUnavailable(result.stderr.trim().slice(0, 200) || 'git operation unavailable');
      }
      return result.stdout;
    };
  };

  const storeFor = async (): Promise<{ root: string; durable: boolean } | null> => {
    const settings = await readRollout(state);
    if (settings === null) return null;
    return { root: String(settings.get('durable_artifact_root')), durable: true };
  };

  const effects: ReviewCapabilityEffects = {
    runnerRepo: options.repo,
    config: options.config,
    nowIso: () => isoNow(clock),
    loadQueue: () => loadQueueDocument(paths.queuePath),
    async saveQueue(queue) {
      await atomicWrite(paths.queuePath, queueBytes(queue));
    },
    async withQueueLock(work, waitMs) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        try {
          return await withLock(join(state, 'tick.lock'), { wait: false }, work);
        } catch (error) {
          if (!(error instanceof SlotBusyError)) throw error;
          if (Date.now() >= deadline) return null;
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
        }
      }
    },
    async readReceipt(receiptId) {
      if (!/^[0-9a-f]{64}$/.test(receiptId)) throw new ValueError('invalid receipt id');
      const bytes = await readFile(join(paths.receiptRoot, `${receiptId}.json`), {
        flag: 'r',
      });
      if (bytes.length > MAX_RECEIPT_BYTES) throw new ValueError('receipt exceeds its read bound');
      if (sha256Hex(bytes) !== receiptId) throw new ValueError('receipt digest mismatch');
      return new Uint8Array(bytes);
    },
    isConfiguredRepo: (repo) => sameRepo(repo, options.repo) || repoEntry(repo) !== null,
    async hasCommit(repo, commit) {
      const clone = cloneFor(repo);
      const result = await gitCall(pool, clone, ['cat-file', '-e', `${commit}^{commit}`]);
      return result.code === 0;
    },
    async fetchRepo(repo) {
      const clone = cloneFor(repo);
      const result = await gitCall(pool, clone, ['fetch', '--prune', '--quiet', 'origin']);
      if (result.code !== 0) {
        throw new ValueError(
          `could not fetch the review repository: ${result.stderr.trim().slice(0, 200)}`,
        );
      }
    },
    async installSnapshot(repo, snapshot, binding) {
      const configured = repoEntry(repo);
      const scanClasses =
        configured === null
          ? undefined
          : [
              ...UNIVERSAL_SCAN_CLASSES,
              ...arrayOrEmpty(configured.get('scan_extra_classes')).filter(
                (value): value is string => typeof value === 'string' && value.length > 0,
              ),
            ];
      await installAuthorSnapshot({
        pool,
        clone: cloneFor(repo),
        scanClone: cloneFor(options.repo),
        ...(scanClasses === undefined ? {} : { scanClasses }),
        snapshot,
        binding,
        original: true,
      });
    },
    async resolveIdentity(repo, inputs, profile) {
      const clone = cloneFor(repo);
      const facts = new ObjectValue([
        ['repo', inputs.get('repo') ?? null],
        ['base_commit', inputs.get('base_commit') ?? null],
        ['head_commit', inputs.get('head_commit') ?? null],
        ['projection', inputs.get('projection') ?? null],
      ]);
      const withTrees: Array<readonly [string, import('../../policy/crq/jsonValue.js').JsonValue]> =
        [];
      for (const end of ['base', 'head'] as const) {
        const claimed = inputs.get(`${end}_commit`);
        if (typeof claimed !== 'string') throw new ValueError('invalid claimed commit');
        const commit = Buffer.from(
          await gitOk(pool, clone, ['rev-parse', '--verify', `${claimed}^{commit}`]),
        )
          .toString('utf8')
          .trim();
        const tree = Buffer.from(
          await gitOk(pool, clone, ['rev-parse', '--verify', `${commit}^{tree}`]),
        )
          .toString('utf8')
          .trim();
        if (commit !== claimed || tree !== inputs.get(`${end}_tree`)) {
          throw new ValueError('claimed commit/tree mismatch');
        }
        withTrees.push([`${end}_tree`, tree]);
      }
      const listing = Buffer.from(
        await gitOk(pool, clone, [
          'ls-tree',
          String(inputs.get('head_commit')),
          '--',
          '.coderabbit.yaml',
        ]),
      )
        .toString('utf8')
        .split(/\s+/)
        .filter((part) => part.length > 0);
      const blob =
        listing.length > 0
          ? await gitOk(pool, clone, ['cat-file', 'blob', listing[2] as string])
          : new Uint8Array(0);
      const adapter = profile.get('adapter');
      const revision = profile.get('revision');
      return withFields(
        new ObjectValue([
          ...facts.entries,
          ...withTrees,
          ['v', JsonNumber.int(1)],
          ['scope', 'full-diff'],
          ['config_digest', sha256Hex(blob)],
          [
            'profile',
            new ObjectValue([
              ['adapter', adapter ?? null],
              ['revision', revision ?? null],
            ]),
          ],
        ]),
        [],
      );
    },
    historyGit,
    async retainedRecords() {
      const roots = [join(state, 'backfill/publication'), join(state, 'record-outbox')];
      const seen = new Set<string>();
      const records: JsonObject[] = [];
      for (const root of roots) {
        const directory = join(root, 'pending');
        let names: string[];
        try {
          names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        for (const name of names) {
          let value: JsonObject;
          try {
            const parsed = parseJsonValue(await readFile(join(directory, name), 'utf8'), {
              duplicates: 'error',
            });
            if (!(parsed instanceof ObjectValue)) continue;
            ledgerValidate(parsed);
            value = parsed;
          } catch {
            continue;
          }
          const id = value.get('id');
          if (value.get('event_type') === 'review' && typeof id === 'string' && !seen.has(id)) {
            seen.add(id);
            records.push(value);
          } else if (
            value.get('event_type') === 'import-result' &&
            typeof value.get('source_key') === 'string' &&
            (value.get('source_key') as string).startsWith('record:') &&
            typeof id === 'string' &&
            !seen.has(id)
          ) {
            seen.add(id);
            records.push(value);
          }
        }
      }
      return records;
    },
    rolloutSettings: () => readRollout(state),
    async putReport(bytes) {
      const store = await storeFor();
      const root = store?.root ?? join(state, 'record-artifacts');
      const digest = sha256Hex(bytes);
      const filename = join(resolve(root), 'sha256', digest);
      let existing: Buffer | null = null;
      try {
        existing = await readFile(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing !== null) {
        if (!existing.equals(Buffer.from(bytes)))
          throw new LedgerIntegrityError('artifact store corruption');
      } else {
        await mkdir(join(filename, '..'), { recursive: true });
        await atomicWrite(filename, bytes);
      }
      return new ObjectValue([
        ['sha256', digest],
        ['location', filename],
      ]);
    },
    async spoolEvent(event) {
      ledgerValidate(event);
      const store = await storeFor();
      const storeRoot = store === null ? join(state, 'record-artifacts') : store.root;
      const payload = objectOrNull(event.get('payload'));
      for (const reference of arrayOrEmpty(payload?.get('artifacts')).map(objectOrNull)) {
        if (reference === null) continue;
        await verifyArtifact(reference, storeRoot);
      }
      const serialized = ledgerCanonicalBytes(event);
      if (serialized.length > MAX_EVENT_BYTES)
        throw new LedgerIntegrityError('event exceeds publisher bound');
      const outbox =
        store === null ? join(state, 'record-outbox') : join(state, 'backfill/publication');
      const id = event.get('id');
      if (typeof id !== 'string') throw new LedgerIntegrityError('event has no id');
      const directory = join(outbox, 'pending');
      await mkdir(directory, { recursive: true });
      await withLock(join(outbox, 'outbox.lock'), { wait: true }, async () => {
        const filename = join(directory, `${id}.json`);
        try {
          const previous = await readFile(filename);
          if (!Buffer.from(previous).equals(Buffer.from(serialized))) {
            throw new LedgerIntegrityError('outbox replay conflict');
          }
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await atomicWrite(filename, serialized);
      });
    },
    async requestPublication() {
      const settings = await readRollout(state);
      if (settings === null) return;
      await atomicWrite(
        join(state, 'backfill/publish-request.json'),
        ledgerCanonicalBytes(new ObjectValue([['request', randomUUID().replaceAll('-', '')]])),
      );
    },
    async audit(kind, data) {
      await mkdir(state, { recursive: true });
      const line = pythonJsonText(
        new ObjectValue([['at', isoNow(clock)], ['event', kind], ...data.entries]),
        {
          asciiOnly: true,
          sortKeys: false,
          spacedSeparators: true,
          trailingNewline: true,
        },
      );
      await appendFile(join(state, 'events.jsonl'), line);
    },
  };

  return { effects, terminate: () => pool.killAll() };
}

function withFields(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, import('../../policy/crq/jsonValue.js').JsonValue]>,
): JsonObject {
  if (updates.length === 0) return object;
  const map = new Map(updates);
  const entries = object.entries.map(
    ([key, value]) =>
      [
        key,
        (map.has(key) ? map.get(key) : value) as import('../../policy/crq/jsonValue.js').JsonValue,
      ] as const,
  );
  for (const [key, value] of updates) if (!object.has(key)) entries.push([key, value] as const);
  return new ObjectValue(entries);
}

async function readRollout(state: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(join(state, 'backfill-rollout.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseJsonValue(text, { duplicates: 'error' });
  if (!(parsed instanceof ObjectValue)) throw new LedgerIntegrityError('invalid backfill rollout');
  const required = [
    'operational_ruling',
    'no_live_run_verification',
    'owner_branch_ruleset_evidence',
    'durable_artifact_root',
    'runner_identity',
    'publisher_spool',
  ];
  if (
    required.some((key) => !parsed.get(key)) ||
    parsed.get('runner_identity') !== 'crq-runner-app'
  ) {
    throw new LedgerIntegrityError('backfill rollout prerequisites incomplete');
  }
  return parsed;
}

async function verifyArtifact(reference: JsonObject, storeRoot: string): Promise<void> {
  const sha = reference.get('sha256');
  const location = reference.get('location');
  if (typeof sha !== 'string' || typeof location !== 'string') {
    throw new LedgerIntegrityError('invalid retained artifact reference');
  }
  const expected = join(resolve(storeRoot), 'sha256', sha);
  if (resolve(location) !== expected) {
    throw new LedgerIntegrityError('artifact outside configured durable store');
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(expected);
  } catch {
    throw new LedgerIntegrityError('missing or corrupt retained artifact');
  }
  if (sha256Hex(bytes) !== sha)
    throw new LedgerIntegrityError('missing or corrupt retained artifact');
}
