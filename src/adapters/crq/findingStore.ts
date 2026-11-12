/**
 * Filesystem finding store adapter.
 *
 * Implements the three seams the C1 finding inbox and publisher already use:
 * `FindingInboxFiles` (`state/backfill/findings`), `FindingPublication`
 * (`state/backfill/publication`) and the durable `ArtifactStore`.
 *
 * Layout and bytes are Python `finding_delivery` / `review_ledger` compatible:
 * a persistent `findings.lock` inode, canonical `triage/<finding>.json` rows,
 * filename-ordered `pending/<event>.json`, and `sha256/<digest>` artifacts in
 * the separately provisioned durable volume. This module only performs local
 * filesystem effects; it never dispatches, publishes or contacts a provider.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  FindingInboxFiles,
  FindingPublication,
} from '../../ops/review/internal/crq/findingInbox.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerLoads,
  ledgerValidate,
  ledgerValueEqual,
} from '../../policy/crq/ledger.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';

/** A `review_ledger` artifact reference: content digest and absolute path. */
export interface ArtifactReference {
  readonly sha256: string;
  readonly location: string;
}

/** `review_ledger.ArtifactStore`, reduced to the operations C1 consumes. */
export interface ArtifactStore {
  put(data: Uint8Array): Promise<ArtifactReference>;
  verify(reference: ArtifactReference): Promise<void>;
}

export interface FindingStoreRoots {
  /** `state/` root; findings and publication directories derive from it. */
  readonly stateRoot: string;
  /** Separately provisioned durable artifact volume. */
  readonly durableArtifactRoot: string;
}

export interface FindingStore {
  readonly files: FindingInboxFiles;
  readonly publication: FindingPublication;
  readonly artifacts: ArtifactStore;
}

function integrity(message: string): LedgerIntegrityError {
  return new LedgerIntegrityError(message);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function artifactReference(value: JsonValue): ArtifactReference {
  if (!(value instanceof JsonObject)) throw integrity('artifact reference is malformed');
  const sha256 = value.get('sha256');
  const location = value.get('location');
  if (typeof sha256 !== 'string' || typeof location !== 'string') {
    throw integrity('artifact reference is malformed');
  }
  return { sha256, location };
}

/** `Path.resolve()` without strict mode: resolve the existing parent, then append. */
async function resolveExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

/**
 * `review_ledger.ArtifactStore`: content-addressed `sha256/<digest>` blobs.
 *
 * `put` accepts the same bytes twice and refuses an existing digest whose
 * bytes differ (store corruption). `verify` requires the reference location to
 * be the configured path, then re-hashes the retained file.
 */
export function fileArtifactStore(durableRoot: string): ArtifactStore {
  // Python resolves the durable root in the constructor; failing to resolve a
  // not-yet-created root falls back to the absolute path it will occupy.
  const root = (() => {
    try {
      return realpathSync(durableRoot);
    } catch {
      return resolve(durableRoot);
    }
  })();
  const store = join(root, 'sha256');

  async function verify(reference: ArtifactReference): Promise<void> {
    const expected = join(store, reference.sha256);
    // Python resolves the reference location, so a symlink in either the
    // configured path or the store entry cannot equal the durable path.
    const resolvedLocation = await resolveExisting(reference.location);
    if (resolvedLocation !== expected) throw integrity('artifact outside configured durable store');
    const entry = await lstat(expected).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (entry === null || !entry.isFile()) {
      throw integrity('missing or corrupt retained artifact');
    }
    const hasher = createHash('sha256');
    hasher.update(await readFile(expected));
    if (hasher.digest('hex') !== reference.sha256) {
      throw integrity('missing or corrupt retained artifact');
    }
  }

  return {
    async put(data: Uint8Array): Promise<ArtifactReference> {
      const sha256 = createHash('sha256').update(data).digest('hex');
      const filename = join(store, sha256);
      const existing = await readFile(filename).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      });
      if (existing !== null) {
        if (Buffer.compare(existing, Buffer.from(data)) !== 0) {
          throw integrity('artifact store corruption');
        }
      } else {
        await ensureParent(filename);
        await atomicWrite(filename, data);
      }
      return { sha256, location: filename };
    },
    verify,
  };
}

/**
 * `Inbox` filesystem effects. The lock is the Python-compatible persistent
 * `findings.lock`; its parent is created once so `withLock` can open it.
 */
export function fileFindingInbox(findingsRoot: string): FindingInboxFiles {
  const root = resolve(findingsRoot);
  const triage = join(root, 'triage');
  const lock = join(root, 'findings.lock');

  function triagePath(findingId: string): string {
    if (
      findingId.length === 0 ||
      findingId === '.' ||
      findingId === '..' ||
      findingId.includes('/') ||
      findingId.includes('\\') ||
      findingId.includes('\u0000')
    ) {
      throw integrity('finding id escapes the triage directory');
    }
    const filename = resolve(triage, `${findingId}.json`);
    if (dirname(filename) !== triage) throw integrity('finding id escapes the triage directory');
    return filename;
  }

  return {
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      await mkdir(root, { recursive: true });
      return withLock(lock, { wait: true }, fn);
    },
    async readTriage(findingId: string): Promise<Uint8Array | null> {
      const filename = triagePath(findingId);
      const bytes = await readFile(filename).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      });
      return bytes === null ? null : new Uint8Array(bytes);
    },
    async writeTriage(findingId: string, bytes: Uint8Array): Promise<void> {
      const filename = triagePath(findingId);
      await mkdir(triage, { recursive: true });
      await atomicWrite(filename, bytes);
    },
  };
}

/**
 * `review_ledger.Outbox`: validate, verify every artifact, then take
 * `outbox.lock` for the replay/conflict check and atomic pending write.
 * Retained events are returned in filename order, matching `sorted(glob)`.
 */
export function fileFindingPublication(input: {
  root: string;
  artifacts: ArtifactStore;
}): FindingPublication {
  const root = resolve(input.root);
  const pending = join(root, 'pending');
  const lock = join(root, 'outbox.lock');

  async function retained(): Promise<JsonValue[]> {
    const names = await readdir(pending).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    });
    const values: JsonValue[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
      values.push(ledgerLoads(await readFile(join(pending, name))));
    }
    return values;
  }

  return {
    async spool(value: JsonValue): Promise<string> {
      ledgerValidate(value);
      if (!(value instanceof JsonObject)) throw integrity('event is not an object');
      const payload = value.get('payload');
      if (!(payload instanceof JsonObject)) throw integrity('event payload is not an object');
      const artifacts = payload.get('artifacts');
      if (artifacts !== undefined) {
        if (!Array.isArray(artifacts)) throw integrity('artifact list is malformed');
        for (const reference of artifacts) {
          await input.artifacts.verify(artifactReference(reference));
        }
      }
      const id = value.get('id');
      if (typeof id !== 'string') throw integrity('event id is not a string');
      const filename = join(pending, `${id}.json`);

      await mkdir(root, { recursive: true });
      return withLock(lock, { wait: true }, async () => {
        const existing = await readFile(filename).catch((error: unknown) => {
          if (errorCode(error) === 'ENOENT') return null;
          throw error;
        });
        if (existing !== null && !ledgerValueEqual(ledgerLoads(existing), value)) {
          throw integrity('outbox replay conflict');
        }
        await mkdir(pending, { recursive: true });
        await atomicWrite(filename, ledgerCanonicalBytes(value));
        return id;
      });
    },
    retained,
  };
}

/**
 * Compose the three seams from the existing state root and the configured
 * durable artifact root. No new configuration path is introduced.
 */
export function fileFindingStore(roots: FindingStoreRoots): FindingStore {
  const findingsRoot = join(roots.stateRoot, 'backfill', 'findings');
  const publicationRoot = join(roots.stateRoot, 'backfill', 'publication');
  const artifacts = fileArtifactStore(roots.durableArtifactRoot);
  return {
    files: fileFindingInbox(findingsRoot),
    publication: fileFindingPublication({ root: publicationRoot, artifacts }),
    artifacts,
  };
}
