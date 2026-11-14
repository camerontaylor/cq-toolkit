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
 * With a configured clone, the route captures and constructs off lock, then
 * merges its inventory delta under tick.lock. It writes durable artifacts,
 * state events, the ranked report and the current queue. The state-root-only
 * compatibility seam remains a retained-manifest report replay.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonValue } from '../../policy/crq/jsonValue.js';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { ledgerLoads } from '../../policy/crq/ledger.js';
import { enqueue as enqueueJob } from '../../policy/crq/backfillJobs.js';
import { fromPlainJson, isJsonRecord, recordGet } from '../../policy/crq/queueDoc.js';
import { compareCodePoints } from '../../policy/crq/pythonJson.js';
import {
  runBackfillInventory,
  rolloutSettings,
  type BackfillArtifactReference,
  type BackfillArtifactStore,
  type BackfillInventoryEffects,
  type BackfillRouteResult,
  type BackfillTriageFile,
} from '../../ops/crq/backfillInventory.js';
import { atomicWrite } from './atomic.js';
import { fileArtifactStore } from './findingStore.js';
import { GitAccountingRepository } from './backfillAccounting.js';
import { gitSubjectRepository } from './backfillSubjects.js';
import { collectRequired, fetchRequiredPr } from './backfillRequired.js';
import { prepareInventory } from './backfillPreparation.js';
import { createBackfillTransactionEffects } from './backfillTransactionSource.js';
import { inventoryTransaction } from '../../ops/crq/backfillTransaction.js';
import { GitLedger } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';

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
      // `verify` already proved this location resolves to the store's own
      // `sha256/<digest>` entry and hashes to it, so the read binds the same
      // file without re-deriving the store's layout. `rank` then re-checks the
      // decoded payload against the manifest digest, so a swap between the two
      // is a refusal, not a replay of unverified bytes.
      await store.verify(reference);
      return parseJsonValue(await readFile(reference.location, 'utf8'));
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
  options: {
    readonly stateRoot: string;
    readonly cloneRoot?: string;
    readonly runnerRoot?: string;
  },
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
  if (options.cloneRoot === undefined || options.runnerRoot === undefined)
    return runBackfillInventory(argv.slice(1), fileBackfillInventoryEffects(options.stateRoot));
  const args = argv.slice(1);
  if (args.some((arg) => arg !== '--report-only') || args.length > 1)
    return { artifact: { status: 'failed', error: 'invalid inventory arguments' }, exitCode: 2 };
  const reportOnly = args.length === 1;
  try {
    const clone = options.cloneRoot;
    // Python's backfill_runtime.ROOT is the toolkit installation, not the
    // runner's working directory. This layout is the same in src and dist.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const runGit = runGitIn(clone);
    const accounting = new GitAccountingRepository({ repo: clone, runGit });
    const subjects = gitSubjectRepository({ runGit, accounting });
    const effects = createBackfillTransactionEffects({
      stateRoot: options.stateRoot,
      async prepare(queue, enqueue) {
        const rolloutText = await readOptional(join(options.stateRoot, 'backfill-rollout.json'));
        if (rolloutText === null)
          throw new Error('operator rollout configuration required for inventory publication');
        const config = rolloutSettings(ledgerLoads(Buffer.from(rolloutText)));
        if (enqueue && !config.enabled)
          throw new Error('operator rollout must be enabled before inventory enqueue');
        const store = fileArtifactStore(config.durableArtifactRoot);
        const reference = (value: unknown): BackfillArtifactReference => {
          if (!isJsonRecord(value)) throw new Error('artifact reference is malformed');
          const sha256 = recordGet(value, 'sha256');
          const location = recordGet(value, 'location');
          if (typeof sha256 !== 'string' || typeof location !== 'string')
            throw new Error('artifact reference is malformed');
          return { sha256, location };
        };
        const artifacts = {
          put: store.put,
          verify: async (value: unknown) => store.verify(reference(value)),
          async read(value: unknown) {
            const ref = reference(value);
            await store.verify(ref);
            return ledgerLoads(await readFile(ref.location));
          },
        };
        return prepareInventory(queue, enqueue, {
          accounting,
          subjects,
          artifacts,
          now: () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          enqueue: (q, p, at) => {
            const value = fromPlainJson(p);
            if (!(value instanceof JsonObject)) throw new Error('partition must be an object');
            return enqueueJob(q, value, at);
          },
          baseline: async () => {
            const text = await readOptional(join(options.stateRoot, 'backfill', 'baseline.json'));
            return text === null ? null : ledgerLoads(Buffer.from(text));
          },
          triage: async () =>
            (await readTriageRows(options.stateRoot)).map((row) => ({
              file: row.file,
              value: ledgerLoads(row.bytes),
            })),
          async acquire() {
            const policy = async (name: string) =>
              ledgerLoads(await readFile(join(root, 'policy', `review-${name}.json`)));
            const tiers = await policy('tiers');
            const limits = await policy('limits');
            const required = await policy('required-list');
            const fetch = await runGit([
              'fetch',
              '--no-tags',
              '--no-write-fetch-head',
              'origin',
              'refs/heads/main:refs/remotes/origin/main',
            ]);
            if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr}`);
            const resolved = await runGit(['rev-parse', 'origin/main^{commit}']);
            if (resolved.code !== 0) throw new Error(`git rev-parse failed: ${resolved.stderr}`);
            const target = await accounting.resolve(
              new TextDecoder().decode(resolved.stdout).trim(),
            );
            const ledger = await new GitLedger({ repo: clone, runGit }).fetch();
            const collected = await collectRequired({
              repo: accounting,
              runGit,
              target,
              required,
              artifacts: store,
              fetchPr: fetchRequiredPr,
            });
            const members = Object.fromEntries(
              Object.entries(collected.members).map(([key, member]) => {
                if (!isJsonRecord(member)) throw new Error('invalid required member');
                return [key, member];
              }),
            );
            return {
              target,
              ledgerHead: ledger.head,
              events: ledger.values,
              required,
              tiers,
              limits,
              requiredPaths: collected.requiredPaths,
              members,
              protectedBytes: await readFile(join(root, 'policy', 'protected-paths.json')),
            };
          },
        });
      },
    });
    const value = await inventoryTransaction(effects, { reportOnly });
    return { artifact: { status: 'ok', value }, exitCode: 0 };
  } catch (error) {
    return {
      artifact: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
      exitCode: 3,
    };
  }
}
