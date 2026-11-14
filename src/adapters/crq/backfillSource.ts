/**
 * File adapter for the `crq backfill inventory` route.
 *
 * Binds the route's effects to the runner's own state root: the queue document,
 * the rollout configuration, the retained triage rows and the durable artifact
 * volume. Artifact reads go through the existing `review_ledger.ArtifactStore`
 * port (`fileArtifactStore`), so store containment and the content digest are
 * enforced by the same implementation the finding inbox uses; this adapter only
 * adds the canonical JSON decode.
 *
 * The route's only writes are `backfill/latest-ranked.json` and
 * `backfill/latest-report.json`, both through the durable atomic write the other
 * crq adapters use.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseJsonValue } from '../../policy/crq/jsonValue.js';
import { compareCodePoints } from '../../policy/crq/pythonJson.js';
import {
  runBackfillInventory,
  type BackfillArtifactReference,
  type BackfillArtifactStore,
  type BackfillInventoryEffects,
  type BackfillRouteResult,
  type BackfillTriageFile,
} from '../../ops/crq/backfillInventory.js';
import { atomicWrite } from './atomic.js';
import { fileArtifactStore } from './findingStore.js';

/** Read a document that legitimately may not exist yet (`null`). */
async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    // Only absence is "not yet"; EACCES/EIO must surface rather than read as a
    // disabled configuration.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The triage rows under `backfill/findings/triage`, in Python's sorted order. */
async function readTriageRows(stateRoot: string): Promise<readonly BackfillTriageFile[]> {
  const directory = join(stateRoot, 'backfill', 'findings', 'triage');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: BackfillTriageFile[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort(compareCodePoints)) {
    files.push({ file: name, bytes: await readFile(join(directory, name)) });
  }
  return files;
}

/** `review_ledger.ArtifactStore` plus a canonical decode of the verified bytes. */
function fileBackfillStore(durableRoot: string): BackfillArtifactStore {
  const store = fileArtifactStore(durableRoot);
  return {
    verify: (reference: BackfillArtifactReference) => store.verify(reference),
    async read(reference: BackfillArtifactReference): Promise<unknown> {
      await store.verify(reference);
      // The store's successful verify proves `reference.location` resolves to
      // `sha256/<digest>`; reading through the same root is that file.
      const bytes = await readFile(join(resolve(durableRoot), 'sha256', reference.sha256));
      return parseJsonValue(bytes.toString('utf8'));
    },
  };
}

/** The route's effects, bound to one state root. */
export function fileBackfillInventoryEffects(stateRoot: string): BackfillInventoryEffects {
  return {
    readQueue: () => readFile(join(stateRoot, 'queue.json'), 'utf8'),
    readRollout: () => readOptional(join(stateRoot, 'backfill-rollout.json')),
    readBaseline: () => readOptional(join(stateRoot, 'backfill', 'baseline.json')),
    readTriage: () => readTriageRows(stateRoot),
    artifacts: (durableArtifactRoot: string) => fileBackfillStore(durableArtifactRoot),
    writeRanked: (bytes: Uint8Array) =>
      atomicWrite(join(stateRoot, 'backfill', 'latest-ranked.json'), bytes),
    writeReport: (bytes: Uint8Array) =>
      atomicWrite(join(stateRoot, 'backfill', 'latest-report.json'), bytes),
  };
}

/** `crq backfill …`: the operator-live entry over a resolved state root. */
export async function runBackfillUnit(
  argv: readonly string[],
  options: { readonly stateRoot: string },
): Promise<BackfillRouteResult> {
  if (argv[0] !== 'inventory') {
    return {
      artifact: {
        status: 'failed',
        error: `backfill subcommand is not implemented in this runtime: ${argv[0] ?? ''}`,
      },
      exitCode: 3,
    };
  }
  return runBackfillInventory(argv.slice(1), fileBackfillInventoryEffects(options.stateRoot));
}
