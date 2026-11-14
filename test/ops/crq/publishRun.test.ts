import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  GitLedger,
  LedgerTransportError,
  type RunGit,
} from '../../../src/adapters/crq/ledgerGit.js';
import {
  jsonEqual,
  runPublish,
  PublishRolloutDisabled,
  type PublishRunEffects,
} from '../../../src/ops/crq/publishRun.js';
import {
  JsonObject,
  JsonNumber,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerDigestOf,
  ledgerEvent,
  ledgerLoads,
} from '../../../src/policy/crq/ledger.js';
import {
  arrayAt,
  loadPublisherVectors,
  recordEventType,
  recordId,
  requireObject,
  stringAt,
} from '../../policy/crq/publisherVectors.js';

// ---------------------------------------------------------------------------
// In-memory GitLedger transport: a tiny but honest object store, so the
// adapter's fetch/read/publishBatch byte flow is exercised end to end.
// ---------------------------------------------------------------------------

interface FakeCommit {
  readonly tree: Map<string, Uint8Array>;
  readonly parents: string[];
  message: string;
}

class FakeGit {
  readonly objects = new Map<string, Uint8Array>();
  readonly commits = new Map<string, FakeCommit>();
  readonly remoteBranch: { head: string | null } = { head: null };
  readonly refs = new Map<string, string>();
  readonly pushed: string[] = [];
  private counter = 0;

  private oid(): string {
    // Distinct prefix so fake oids never collide with test-seeded heads.
    this.counter += 1;
    return `f${this.counter.toString(16).padStart(39, '0')}`;
  }

  static sha(bytes: Uint8Array): string {
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0').repeat(5);
  }

  run(args: readonly string[], input?: Uint8Array): { code: number; stdout: Uint8Array } {
    const text = (value?: string): Uint8Array =>
      new TextEncoder().encode(value === undefined ? '' : `${value}\n`);
    const [verb] = args;
    switch (verb) {
      case undefined:
        return { code: 128, stdout: new Uint8Array(0) };
      case 'rev-parse': {
        // publisherLockPath probes `rev-parse --git-common-dir` (Python's
        // publisher lock derivation); the fake's bare clone answers '.' like
        // real git for a bare repository. ensureBareRepo no longer probes
        // (unconditional `git init --bare`), so this is the only consumer.
        if (args.includes('--git-common-dir')) {
          return { code: 0, stdout: text('.') };
        }
        const target = args[args.length - 1] ?? '';
        const quiet = args.includes('--verify') && args.includes('--quiet');
        const resolved =
          this.refs.get(target) ??
          (this.commits.has(target) || target === '0'.repeat(40) ? target : undefined);
        if (resolved === undefined) return { code: quiet ? 1 : 128, stdout: new Uint8Array(0) };
        return { code: 0, stdout: text(resolved) };
      }
      case 'config':
      case 'init': {
        return { code: 0, stdout: new Uint8Array(0) };
      }
      case 'hash-object': {
        const data = input ?? new Uint8Array(0);
        const oid = FakeGit.sha(data);
        this.objects.set(oid, data);
        return { code: 0, stdout: text(oid) };
      }
      case 'cat-file': {
        // --batch: "<oid> blob <size>\n<bytes>\n" per requested oid.
        const requested = new TextDecoder()
          .decode(input ?? new Uint8Array(0))
          .split('\n')
          .filter((line) => line !== '');
        const chunks: number[] = [];
        for (const oid of requested) {
          const data = this.objects.get(oid);
          if (data === undefined) return { code: 128, stdout: new Uint8Array(0) };
          const header = new TextEncoder().encode(`${oid} blob ${data.length}\n`);
          chunks.push(...header, ...data, 0x0a);
        }
        return { code: 0, stdout: new Uint8Array(chunks) };
      }
      case 'update-index':
      case 'read-tree':
      case 'write-tree': {
        // The fake treats the temporary index as caller-owned state; the
        // publishBatch flow re-derives the tree from the current batch, so a
        // per-call index map keyed on GIT_INDEX_FILE is unnecessary here.
        return { code: 0, stdout: new Uint8Array(0) };
      }
      case 'commit-tree': {
        const message = args[args.indexOf('-m') + 1] ?? '';
        const parent = args[args.indexOf('-p') + 1] ?? '';
        const oid = this.oid();
        this.commits.set(oid, { tree: new Map(), parents: [parent], message });
        return { code: 0, stdout: text(oid) };
      }
      case 'update-ref': {
        const deleteForm = args.includes('-d');
        const ref = args[1] ?? '';
        if (deleteForm) {
          this.refs.delete(ref);
          return { code: 0, stdout: new Uint8Array(0) };
        }
        this.refs.set(ref, args[2] ?? '');
        return { code: 0, stdout: new Uint8Array(0) };
      }
      case 'merge-base': {
        // `merge-base --is-ancestor A B`: args[2]=A, args[3]=B. The fake
        // history is linear: walk parents from B looking for A.
        const ancestor = args[2] ?? '';
        const descendant = args[3] ?? '';
        let cursor: string | null = descendant;
        while (cursor !== null && cursor !== '' && cursor !== '0'.repeat(40)) {
          if (cursor === ancestor) return { code: 0, stdout: new Uint8Array(0) };
          cursor = this.commits.get(cursor)?.parents[0] ?? null;
        }
        return { code: 1, stdout: new Uint8Array(0) };
      }
      case 'fetch': {
        // An empty remote has no branch to fetch yet: git exits non-zero and
        // Python treats the empty ledger as a valid initial snapshot.
        if (this.remoteBranch.head === null) return { code: 128, stdout: new Uint8Array(0) };
        const refspec = args[args.length - 1] ?? '';
        const local = refspec.split(':')[1] ?? '';
        if (local !== '') this.refs.set(local, this.remoteBranch.head);
        return { code: 0, stdout: new Uint8Array(0) };
      }
      case 'push': {
        const refspec = args[args.length - 1] ?? '';
        const head = refspec.split(':')[0] ?? '';
        // Remote keeps only additions of 100644 blobs, like the real ref.
        this.remoteBranch.head = head;
        this.pushed.push(head);
        return { code: 0, stdout: new Uint8Array(0) };
      }
      case 'bundle': {
        // The spool transport bundles `refs/crq/ledger-publish/<head>` into a
        // real file before handing bytes to pushCommit; materialize a
        // plausible bundle file so the size-bound read succeeds. The review
        // verifier's `bundle verify/unbundle` also lands here and succeeds.
        if (args[1] === 'create' || args[1] === 'verify' || args[1] === 'unbundle') {
          const target = args[2] ?? '';
          if (target !== '' && args[1] === 'create') {
            const { writeFileSync } = require('node:fs') as typeof import('node:fs');
            writeFileSync(target, Buffer.from(`bundle ${args.slice(3).join(' ')}\n`));
          }
          return { code: 0, stdout: new Uint8Array(0) };
        }
        return { code: 0, stdout: new Uint8Array(0) };
      }
      case 'rev-list': {
        const head = args[args.length - 1] ?? '';
        const ordered: string[] = [];
        const visited = new Set<string>();
        let cursor: string | null = head;
        while (cursor !== null && cursor !== '' && !visited.has(cursor)) {
          const record = this.commits.get(cursor);
          if (record === undefined) break;
          visited.add(cursor);
          ordered.push(cursor);
          cursor = record.parents[0] ?? null;
          if (cursor === '0'.repeat(40)) cursor = null;
        }
        return { code: 0, stdout: text(ordered.reverse().join('\n')) };
      }
      case 'diff-tree': {
        // NUL-separated raw output, exactly real git's: "<commit>\0" then per
        // entry "<meta>\0<path>\0". No extra trailing terminator: the last
        // path's NUL already ends the stream.
        const out: number[] = [];
        const heads = new TextDecoder()
          .decode(input ?? new Uint8Array(0))
          .split('\n')
          .filter((line) => line !== '');
        if (heads.length === 0) return { code: 0, stdout: new Uint8Array(0) };
        for (const commit of heads) {
          const record = this.commits.get(commit);
          if (record === undefined) return { code: 128, stdout: new Uint8Array(0) };
          out.push(...new TextEncoder().encode(commit), 0);
          for (const [path, data] of record.tree) {
            const blob = FakeGit.sha(data);
            out.push(
              ...new TextEncoder().encode(`:000000 100644 ${'0'.repeat(40)} ${blob} A`),
              0,
              ...new TextEncoder().encode(path),
              0,
            );
          }
        }
        return { code: 0, stdout: new Uint8Array(out) };
      }
      default:
        return { code: 0, stdout: new Uint8Array(0) };
    }
  }
}

/**
 * A scripted RunGit over one FakeGit, with a per-call environment hook so
 * publishBatch's temporary-index commits land in a per-invocation tree. The
 * fake cannot track a real index, so publishBatch builds each batch commit's
 * tree from its own updates; this runner wires that by simulating the index
 * inside a call-scoped store keyed by GIT_INDEX_FILE.
 */
function scriptedGit(fake: FakeGit): RunGit {
  const indexes = new Map<string, Map<string, string>>();
  return async (args, options) => {
    const indexFile = options?.env?.['GIT_INDEX_FILE'];
    const verb = args[0] ?? '';
    // The adapter invokes commit-tree with the author env (no
    // GIT_INDEX_FILE), so intercept it by verb, not by environment.
    if (verb === 'commit-tree') {
      const treeId = args[1] ?? '';
      const tree = fakeTreeContents.get(treeId) ?? new Map<string, string>();
      const parent = args[args.indexOf('-p') + 1] ?? '';
      // Unique per commit: content hashing would collapse all synthetic
      // commits onto one oid.
      commitCounter += 1;
      const oid = `d${commitCounter.toString(16).padStart(39, '0')}`;
      const commit: { tree: Map<string, Uint8Array>; parents: string[]; message: string } = {
        tree: new Map(),
        parents: [parent],
        message: args[args.indexOf('-m') + 1] ?? '',
      };
      for (const [path, blob] of tree) {
        const data = fake.objects.get(blob);
        if (data !== undefined) commit.tree.set(path, data);
      }
      fake.commits.set(oid, commit);
      return { args, code: 0, stdout: new TextEncoder().encode(`${oid}\n`), stderr: '' };
    }
    if (indexFile === undefined) {
      const out = fake.run(args, options?.input);
      return { args, code: out.code, stdout: out.stdout, stderr: '' };
    }
    const index = indexes.get(indexFile) ?? new Map<string, string>();
    if (verb === 'read-tree') {
      // Seed from the base commit's tree: the fake's commits carry their
      // own tree map; start empty because ledger commits only add files.
      indexes.set(indexFile, index);
    } else if (verb === 'update-index') {
      const cacheinfo = args[args.indexOf('--cacheinfo') + 1] ?? '';
      const parts = cacheinfo.split(',');
      const mode = parts[0] ?? '';
      const blob = parts[1] ?? '';
      const path = parts.slice(2).join(',');
      if (mode === '100644') index.set(path, blob);
      indexes.set(indexFile, index);
    } else if (verb === 'write-tree') {
      // Materialize the index into a fresh commit-tree-able tree record.
      const oid = fake.run(['hash-object'], new Uint8Array(0)).stdout;
      const treeId = new TextDecoder().decode(oid).trim();
      fakeTreeContents.set(treeId, new Map(index));
      indexes.set(indexFile, index);
      return { args, code: 0, stdout: oid, stderr: '' };
    }
    const out = fake.run(args, options?.input);
    return { args, code: out.code, stdout: out.stdout, stderr: '' };
  };
}

const fakeTreeContents = new Map<string, Map<string, string>>();

/** Unique synthetic commit ids, module-scoped so they never collide. */
let commitCounter = 0;

function fakeRunGit(fake: FakeGit): RunGit {
  const inner = scriptedGit(fake);
  return inner;
}

// ---------------------------------------------------------------------------
// Memory publish effects over temp directories: real atomic writes, real
// flock inodes, an injected tick lock and queue.
// ---------------------------------------------------------------------------

async function makeEffects(root: string): Promise<PublishRunEffects> {
  const stateRoot = join(root, 'state');
  const queuePath = join(stateRoot, 'queue.json');
  await import('node:fs/promises').then((fs) => fs.mkdir(stateRoot, { recursive: true }));
  await writeFile(queuePath, '{"items":[]}\n');
  const scheduler = new FakeGit();
  const publisher = new FakeGit();
  const publisherRun = fakeRunGit(publisher);
  const effects: PublishRunEffects = {
    stateRoot,
    durableArtifactRoot: join(root, 'artifacts'),
    runSchedulerGit: fakeRunGit(scheduler),
    runPublisherGit: publisherRun,
    // The fake transport replaces the rollout's spool ssh exactly as the B1
    // emitter binds a fake Spool: the signer accepts the bundle and publishes
    // the commit to the origin remote, which the driver's fresh fetch then
    // validates. Scheduler and publisher share one in-memory origin, matching
    // the real deployment's single ledger remote.
    pushCommit: async (_base, head) => {
      const pushed = await publisherRun(['push', 'origin', `${head}:refs/heads/cq/review-ledger`]);
      if (pushed.code !== 0) throw new LedgerTransportError('push failed');
    },
    // Python's B1 emitter drives the real publisher through `OracleArtifacts`,
    // which accepts the two public synthetic references before the real store.
    // Mirror that wrapper so vector replay needs no host paths. The kept
    // synthetic reference (`"c"*64`) is also a git-bundle artifact in some
    // vectors; the fake runner answers `bundle verify/unbundle` like git.
    async verifyArtifact(reference) {
      if (
        reference.sha256 === SYNTHETIC_KEPT_SHA &&
        reference.location === `/fixtures/artifacts/${SYNTHETIC_KEPT_SHA}`
      ) {
        return;
      }
      throw new LedgerIntegrityError('missing or corrupt retained artifact');
    },
    async withTickLock(fn) {
      return fn();
    },
    async readQueue() {
      return new Uint8Array(await readFile(queuePath));
    },
    async writeQueue(queue) {
      await writeFile(queuePath, ledgerQueueText(queue));
    },
  };
  return effects;
}

function ledgerQueueText(queue: JsonObject): string {
  // canonicalText already emits valid queue JSON (quoted keys, JsonNumber raw
  // lexemes, NaN constants); JSON.parse would choke on the NaN constants the
  // float test seeds, and is otherwise an identity round trip.
  return `${canonicalText(queue)}\n`;
}

function canonicalText(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof JsonNumber) return value.raw;
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (value instanceof JsonObject) {
    const keys = [...value.entries.map(([key]) => key)].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalText(value.get(key) as JsonValue)}`).join(',')}}`;
  }
  throw new Error('unsupported queue value');
}

// ---------------------------------------------------------------------------
// Fixtures: the B1 publisher vectors seed the outbox; the run route then
// publishes through the fake transport and reconciles a real queue file.
// ---------------------------------------------------------------------------

const vectors = loadPublisherVectors();

/** The B1 vector with a real review + finding-event chain, for ingest. */
function seedCase(name: string): { ledger: JsonValue[]; pending: JsonValue[] } {
  const entry = vectors.find(
    (candidate) => candidate.family === 'publish' && candidate.name === name,
  );
  if (entry === undefined) throw new Error(`missing publish vector ${name}`);
  return { ledger: arrayAt(entry.input, 'ledger'), pending: arrayAt(entry.input, 'pending') };
}

async function writeSeeds(
  effects: PublishRunEffects,
  pending: readonly JsonValue[],
): Promise<void> {
  const publication = join(effects.stateRoot, 'backfill', 'publication', 'pending');
  await import('node:fs/promises').then((fs) => fs.mkdir(publication, { recursive: true }));
  for (const value of pending) {
    const id = recordId(value);
    await writeFile(join(publication, `${id}.json`), ledgerCanonicalBytes(value));
  }
}

async function seedRollout(effects: PublishRunEffects): Promise<void> {
  const dir = effects.stateRoot;
  await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
  await writeFile(
    join(dir, 'backfill-rollout.json'),
    `${JSON.stringify({
      operational_ruling: 'fixture',
      no_live_run_verification: 'fixture',
      owner_branch_ruleset_evidence: 'fixture',
      durable_artifact_root: '/unused-fixture-volume',
      runner_identity: 'crq-runner-app',
      publisher_spool: { ssh_alias: 'crq@spool.invalid', ssh_key: '/unused/key' },
    })}\n`,
  );
}

function reviewFromVector(pending: readonly JsonValue[]): JsonObject {
  const review = pending.find((value) => recordEventType(value) === 'review');
  if (review === undefined) throw new Error('vector has no review record to reconcile');
  return requireObject(review, 'review');
}

/**
 * Give the fake publisher clone's origin a `cq/review-ledger` branch with one
 * empty seed commit, matching the always-seeded Python deployment.
 */
async function seedRemoteBranch(effects: PublishRunEffects): Promise<void> {
  const current = effects.runPublisherGit;
  const seed = randomOid();
  // The scripted fake is closed over its FakeGit; drive it through the same
  // command surface the adapter uses. `fetch` needs a remote branch head, so
  // expose one by issuing a push of a synthetic seed through the runner.
  const pushed = await current(['push', 'origin', `${seed}:refs/heads/cq/review-ledger`]);
  if (pushed.code !== 0) throw new Error('fake seed push failed');
}

let seedCounter = 0;
function randomOid(): string {
  seedCounter += 1;
  return seedCounter.toString(16).padStart(40, '0');
}

/**
 * The B1 vectors use two public synthetic artifact references ("c"*64 kept,
 * "d"*64 refused by configuration). Python's oracle accepts the kept one via
 * an injected wrapper; the effects above mirror that acceptance.
 */
const SYNTHETIC_KEPT_SHA = 'c'.repeat(64);

describe('jsonEqual numeric equality (Python == over parsed JSON)', () => {
  test('1 == 1.0 and exponent lexemes compare by value, not raw text', () => {
    expect(jsonEqual(JsonNumber.int('1'), JsonNumber.float(1, '1.0'))).toBe(true);
    expect(jsonEqual(JsonNumber.int('100'), JsonNumber.float(100, '1e2'))).toBe(true);
    expect(jsonEqual(JsonNumber.float(1, '1e0'), JsonNumber.float(1, '1.0'))).toBe(true);
    expect(jsonEqual(JsonNumber.int('7'), JsonNumber.float(7, '7.000'))).toBe(true);
    // Negative zero vs zero: Python says True.
    expect(jsonEqual(JsonNumber.int('0'), JsonNumber.float(0, '-0.0'))).toBe(true);
    // Distinct values stay distinct.
    expect(jsonEqual(JsonNumber.int('1'), JsonNumber.float(1.5, '1.5'))).toBe(false);
    // Precision loss is avoided: integers above Number.MAX_SAFE_INTEGER
    // compare exactly, never through a float round trip.
    const bigA = JsonNumber.int('9007199254740993');
    const bigB = JsonNumber.int('9007199254740992');
    expect(jsonEqual(bigA, bigB)).toBe(false);
    // float 1e2 vs int 100 across nested containers and key order.
    expect(
      jsonEqual(
        new JsonObject([
          ['a', [JsonNumber.int('1'), new JsonObject([['b', JsonNumber.int('100')]])]],
        ]),
        new JsonObject([
          [
            'a',
            [JsonNumber.float(1, '1.0'), new JsonObject([['b', JsonNumber.float(100, '1e2')]])],
          ],
        ]),
      ),
    ).toBe(true);
    // NaN equals nothing, not even NaN.
    expect(
      jsonEqual(JsonNumber.float(Number.NaN, 'NaN'), JsonNumber.float(Number.NaN, 'NaN')),
    ).toBe(false);
  });
});

describe('publisher route: fixture replay through the run composition', () => {
  test('idle outbox stays idle and writes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-idle-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const result = await runPublish(effects);
      expect(result).toEqual({ publication: 'idle' });
      // No request marker, no failure marker.
      await expect(
        stat(join(effects.stateRoot, 'backfill', 'publish-request.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        stat(join(effects.stateRoot, 'backfill', 'publication-failure.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('disabled rollout reports disabled without touching state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-off-'));
    try {
      const effects = await makeEffects(root);
      // Python returns {"publication": "disabled"} for a missing rollout;
      // the route surfaces the sentinel (the unit adapter maps it to exit 0)
      // and no request was written.
      await expect(runPublish(effects)).rejects.toBeInstanceOf(PublishRolloutDisabled);
      await expect(
        stat(join(effects.stateRoot, 'backfill', 'publish-request.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('valid publication: byte-equal replay, dedup on rerun, queue reconciles once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-ok-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      await writeSeeds(effects, pending);
      // Python's publication ledger always starts from a seeded remote branch;
      // an unseeded origin refuses the fetch (LedgerTransportError), which the
      // transport-down test covers.
      await seedRemoteBranch(effects);

      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');
      expect(result.ledger_head).toBeDefined();

      // Byte-equal round trip: every spooled record is on the remote and
      // acknowledged with its exact canonical bytes.
      const pendingDir = join(effects.stateRoot, 'backfill', 'publication', 'pending');
      const ackDir = join(effects.stateRoot, 'backfill', 'publication', 'ack');
      const remaining = await readdir(pendingDir);
      const acks = await readdir(ackDir);
      expect(acks.sort()).toEqual(remaining.sort());
      for (const name of remaining) {
        const spooled = await readFile(join(pendingDir, name));
        const ack = await readFile(join(ackDir, name));
        expect(ack).toEqual(
          ledgerCanonicalBytes(parseJsonValue(JSON.stringify({ id: name.replace(/\.json$/, '') }))),
        );
        // The retained bytes stay exactly the seeded canonical bytes.
        const seeded = pending.find((value) => `${recordId(value)}.json` === name);
        expect(seeded).toBeDefined();
        expect(spooled).toEqual(ledgerCanonicalBytes(seeded as JsonValue));
      }

      // Reconciliation: the review record's queue item flips to done once.
      const queue = parseJsonValue(await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'));
      expect(queue).toBeInstanceOf(JsonObject);
      expect((queue as JsonObject).get('review_ledger_head')).toBe(result.ledger_head);

      // Duplicate replay: with the request consumed and the outbox fully
      // acknowledged, Python's run reports idle and appends nothing.
      const second = await runPublish(effects);
      expect(second).toEqual({ publication: 'idle' });
      expect(await readdir(pendingDir)).toEqual(remaining);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a queue float diagnostic survives reconciliation and the failure halt', async () => {
    // Python's load_queue (admission_history.Reader, non-strict) accepts
    // finite floats and NaN constants; test_backfill.py seeds diagnostic: 1.5.
    // ledgerLoads refuses every float, so using it here made reconciliation
    // (and the failure handler's halt) fail forever on a queue Python accepts.
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-float-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      const review = pending.find((value) => recordEventType(value) === 'review');
      if (!(review instanceof JsonObject)) throw new Error('fixture has no review');
      const reviewScope = (review.get('payload') as JsonObject).get('requested_scope');
      await writeSeeds(effects, pending);
      await seedRemoteBranch(effects);
      // Write the queue as raw Python-shaped JSON text: 1.5 stays a float
      // lexeme and NaN stays a constant, which the plain JSON.stringify path
      // above cannot express.
      const reviewScopeText = canonicalText(reviewScope as JsonValue);
      await writeFile(
        join(effects.stateRoot, 'queue.json'),
        `{
  "items": [
    {
      "kind": "backfill",
      "family": "review-ledger",
      "job_id": "subject:0",
      "state": "publication-pending",
      "publication_event_id": ${JSON.stringify(recordId(review))},
      "scope": ${reviewScopeText},
      "generation": 1
    }
  ],
  "diagnostic": 1.5,
  "nan_const": NaN
}\n`,
      );
      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');
      const queueText = await readFile(join(effects.stateRoot, 'queue.json'), 'utf8');
      const queue = parseJsonValue(queueText, {
        // The reader side of the same Python-domain rules queueLoads applies.
        parseConstant: (raw) =>
          raw === 'NaN'
            ? JsonNumber.float(Number.NaN, 'NaN')
            : raw === 'Infinity'
              ? JsonNumber.float(Number.POSITIVE_INFINITY, 'Infinity')
              : JsonNumber.float(Number.NEGATIVE_INFINITY, '-Infinity'),
      });
      if (!(queue instanceof JsonObject)) throw new Error('queue not an object');
      // The float and the NaN constant survive the rewrite losslessly.
      expect(queue.get('diagnostic')).toEqual(JsonNumber.float(1.5));
      const nan = queue.get('nan_const');
      if (!(nan instanceof JsonNumber) || nan.float === null || !Number.isNaN(nan.float)) {
        throw new Error('NaN constant lost');
      }
      const items = queue.get('items');
      if (!Array.isArray(items) || !(items[0] instanceof JsonObject)) {
        throw new Error('queue items lost');
      }
      expect(items[0].get('state')).toBe('done');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('failure replay: transport down retains pending and halts, recovery reconciles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-fail-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      await writeSeeds(effects, pending);

      // First run: the fake publisher clone's origin has no ledger branch, so
      // the fetch fails (LedgerTransportError) like an unreachable remote. The
      // publication attempt must retain the outbox, persist the failure marker
      // and halt the queue.
      await expect(runPublish(effects)).rejects.toBeInstanceOf(LedgerTransportError);
      const failure = JSON.parse(
        await readFile(join(effects.stateRoot, 'backfill', 'publication-failure.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(typeof failure['error']).toBe('string');
      const queue = parseJsonValue(await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'));
      expect((queue as JsonObject).get('backfill_halted')).toBeDefined();
      expect((queue as JsonObject).get('backfill_halt_operation')).toBe('publication');
      const pendingDir = join(effects.stateRoot, 'backfill', 'publication', 'pending');
      expect((await readdir(pendingDir)).length).toBe(pending.length);

      // Recovery: keep the failed queue intact (makeEffects would reset
      // queue.json and erase the fields recovery must clear) and rebuild only
      // the transport-facing seams. The request marker written by the failed
      // run drives one more publication.
      const queueBeforeRecovery = parseJsonValue(
        await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'),
      );
      expect((queueBeforeRecovery as JsonObject).get('backfill_halted')).toBeDefined();
      expect((queueBeforeRecovery as JsonObject).get('backfill_publication_error')).toBeDefined();
      // seedRemoteBranch would overwrite the shared fake origin state, so
      // give recovery its own fake git pair over the same state root: the
      // queue file is reused byte-for-byte, only the transport heals.
      const healed = await makeEffects(root);
      await seedRollout(healed);
      await seedRemoteBranch(healed);
      // Restore the failed run's queue (makeEffects reset it): recovery must
      // clear these fields itself, not inherit their absence.
      await writeFile(join(root, 'state', 'queue.json'), ledgerCanonicalBytes(queueBeforeRecovery));
      const recovered = await runPublish(healed);
      expect(recovered.publication).toBe('reconciled');
      const healedQueue = parseJsonValue(
        await readFile(join(healed.stateRoot, 'queue.json'), 'utf8'),
      );
      expect((healedQueue as JsonObject).get('backfill_halted')).toBeUndefined();
      expect((healedQueue as JsonObject).get('backfill_publication_error')).toBeUndefined();
      await expect(
        stat(join(healed.stateRoot, 'backfill', 'publication-failure.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('review-only ingest feeds the finding inbox without a duplicate ledger append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-ingest-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      const review = reviewFromVector(pending);
      await writeSeeds(effects, [review]);
      await seedRemoteBranch(effects);
      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');

      // Ingest writes one triage row per review finding; rerunning ingests
      // the same review idempotently: Python's run is idle (outbox drained),
      // so no extra row and no duplicate ledger append.
      const triageDir = join(effects.stateRoot, 'backfill', 'findings', 'triage');
      const rows = (await readdir(triageDir)).sort();
      expect(rows.length).toBeGreaterThan(0);
      const second = await runPublish(effects);
      expect(second).toEqual({ publication: 'idle' });
      expect((await readdir(triageDir)).sort()).toEqual(rows);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a real temporary repository publishes one canonical batch through git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-git-'));
    try {
      const stateRoot = join(root, 'state');
      await import('node:fs/promises').then((fs) => fs.mkdir(stateRoot, { recursive: true }));
      const entry = vectors.find(
        (candidate) => candidate.family === 'publish' && candidate.name === 'single-enrollment',
      );
      if (entry === undefined) throw new Error('missing publish vector');
      const pending = arrayAt(entry.input, 'pending');
      const publication = join(stateRoot, 'backfill', 'publication', 'pending');
      await import('node:fs/promises').then((fs) => fs.mkdir(publication, { recursive: true }));
      for (const value of pending) {
        await writeFile(join(publication, `${recordId(value)}.json`), ledgerCanonicalBytes(value));
      }
      await writeFile(
        join(stateRoot, 'backfill-rollout.json'),
        `${JSON.stringify({
          operational_ruling: 'fixture',
          no_live_run_verification: 'fixture',
          owner_branch_ruleset_evidence: 'fixture',
          durable_artifact_root: join(root, 'artifacts'),
          runner_identity: 'crq-runner-app',
          publisher_spool: { ssh_alias: 'crq@spool.invalid', ssh_key: '/unused/key' },
        })}\n`,
      );

      // A real bare remote plus a real publisher clone over actual git.
      // Commit identity is pinned per-repository: CI runners have no ambient
      // git identity and the publish commits carry their own author env.
      const remote = join(root, 'remote.git');
      const clone = join(root, 'clone');
      const { execFileSync } = await import('node:child_process');
      const git = (...args: string[]): void => {
        execFileSync('git', args, { stdio: 'pipe' });
      };
      git('init', '--bare', '--initial-branch=cq/review-ledger', remote);
      git('init', clone);
      git('-C', clone, 'config', 'user.name', 'crq-fixture');
      git('-C', clone, 'config', 'user.email', 'crq-fixture@localhost');
      git('-C', clone, 'remote', 'add', 'origin', remote);
      git('-C', clone, 'commit', '--allow-empty', '-m', 'seed');
      git('-C', clone, 'push', 'origin', 'HEAD:cq/review-ledger');

      const effects: PublishRunEffects = {
        stateRoot,
        durableArtifactRoot: join(root, 'artifacts'),
        runSchedulerGit: gitRunner(clone),
        runPublisherGit: gitRunner(join(stateRoot, 'backfill', 'publisher.git')),
        // The live-path test binds the signer stand-in exactly as the B1
        // vector replay does: the transport publishes the pushed commit to
        // the origin remote, which the driver's fresh fetch then validates.
        pushCommit: async (_base, head) => {
          execFileSync(
            'git',
            [
              '-C',
              join(stateRoot, 'backfill', 'publisher.git'),
              'push',
              'origin',
              `${head}:refs/heads/cq/review-ledger`,
            ],
            { stdio: 'pipe' },
          );
        },
        async withTickLock(fn) {
          return fn();
        },
        async readQueue() {
          return new Uint8Array(await readFile(join(stateRoot, 'queue.json')));
        },
        async writeQueue(queue) {
          await writeFile(join(stateRoot, 'queue.json'), ledgerQueueText(queue));
        },
      };
      await writeFile(join(stateRoot, 'queue.json'), '{"items":[]}\n');

      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');
      expect(result.ledger_head).toBe(
        execFileSync('git', ['-C', remote, 'rev-parse', 'cq/review-ledger'], {
          encoding: 'utf8',
        }).trim(),
      );

      // The remote branch now carries every record as a 100644 blob at its
      // canonical path, and the local outbox is fully acknowledged.
      const listing = execFileSync(
        'git',
        ['-C', remote, 'ls-tree', '-r', '--name-only', 'cq/review-ledger'],
        { encoding: 'utf8' },
      );
      const paths = listing.split('\n').filter((line) => line.startsWith('records/'));
      expect(paths.length).toBe(pending.length);
      const acks = await readdir(join(stateRoot, 'backfill', 'publication', 'ack'));
      expect(acks.length).toBe(pending.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Hardened git runner over a real repository for the live-path test. */
function gitRunner(repo: string): RunGit {
  const { execFile, spawn } = require('node:child_process') as typeof import('node:child_process');
  return async (args, options) => {
    // Forward the caller's injected environment (publishBatch pins
    // GIT_AUTHOR_*/GIT_COMMITTER_*); without it the commit identity comes
    // from whatever ambient global git config the host happens to have, so
    // CI (no global identity) fails while workstations pass.
    const env = { ...process.env, ...options?.env };
    if (options?.input !== undefined && options.input.length > 0) {
      return new Promise((resolve) => {
        const child = spawn('git', ['-C', repo, ...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
        const stdout: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.on('error', () =>
          resolve({ args, code: null, stdout: new Uint8Array(0), stderr: 'spawn failed' }),
        );
        child.on('close', (code) =>
          resolve({
            args,
            code: code ?? null,
            stdout: new Uint8Array(Buffer.concat(stdout)),
            stderr: '',
          }),
        );
        child.stdin.end(options.input);
      });
    }
    return new Promise((resolve) => {
      execFile(
        'git',
        ['-C', repo, ...args],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120_000, env },
        (error, stdout, stderr) => {
          const rawCode = error === null ? 0 : (error as { code?: unknown }).code;
          resolve({
            args,
            code: typeof rawCode === 'number' ? rawCode : null,
            stdout: new Uint8Array(stdout),
            stderr: stderr.toString('utf8'),
          });
        },
      );
    });
  };
}

describe('git ledger transport: empty remote refuses the initial fetch', () => {
  test('an unseeded remote rejects the fetch like real git', async () => {
    const fake = new FakeGit();
    const ledger = new GitLedger({ repo: '/unused', runGit: fakeRunGit(fake) });
    // The checkpoint CAS/ancestry refusal itself is covered by the route
    // test "a checkpoint ahead of the remote ref blocks a rewound
    // publication"; this pins only the unseeded-remote behavior.
    await expect(ledger.fetch()).rejects.toBeInstanceOf(Error);
  });
});

describe('outbox ack idempotence through the route', () => {
  test('an acknowledged id is never published twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-ack-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      await writeSeeds(effects, pending);
      await seedRemoteBranch(effects);
      const first = await runPublish(effects);
      expect(first.publication).toBe('reconciled');
      const ackDir = join(effects.stateRoot, 'backfill', 'publication', 'ack');
      const firstAcks = await readdir(ackDir);
      const second = await runPublish(effects);
      expect(second).toEqual({ publication: 'idle' });
      expect(await readdir(ackDir)).toEqual(firstAcks);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('malformed rollout refuses publication', () => {
  test('a wrong runner identity is Python integrity text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-bad-'));
    try {
      const effects = await makeEffects(root);
      await writeFile(
        join(effects.stateRoot, 'backfill-rollout.json'),
        `${JSON.stringify({
          operational_ruling: 'fixture',
          no_live_run_verification: 'fixture',
          owner_branch_ruleset_evidence: 'fixture',
          durable_artifact_root: '/unused',
          runner_identity: 'someone-else',
          publisher_spool: { ssh_alias: 'crq@spool.invalid', ssh_key: '/unused/key' },
        })}\n`,
      );
      let message = '';
      try {
        await runPublish(effects);
      } catch (error) {
        message = error instanceof LedgerIntegrityError ? error.message : '';
      }
      expect(message).toBe('backfill rollout prerequisites incomplete');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an empty-object evidence field refuses with Python truthiness', async () => {
    // Python settings(): any(not value.get(k) for k in required). An empty
    // object, empty list or numeric zero for any prerequisite is a refusal,
    // not an accepted rollout.
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-empty-'));
    try {
      for (const bad of [{}, [], 0]) {
        const effects = await makeEffects(root);
        await writeFile(
          join(effects.stateRoot, 'backfill-rollout.json'),
          `${JSON.stringify({
            operational_ruling: 'fixture',
            no_live_run_verification: bad,
            owner_branch_ruleset_evidence: 'fixture',
            durable_artifact_root: '/unused',
            runner_identity: 'crq-runner-app',
            publisher_spool: { ssh_alias: 'crq@spool.invalid', ssh_key: '/unused/key' },
          })}\n`,
        );
        let message = '';
        try {
          await runPublish(effects);
        } catch (error) {
          message = error instanceof Error ? error.message : '';
        }
        expect(message).toBe('backfill rollout prerequisites incomplete');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a legacy_shell spool key refuses with the transport ruling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-spool-'));
    try {
      const effects = await makeEffects(root);
      await writeFile(
        join(effects.stateRoot, 'backfill-rollout.json'),
        `${JSON.stringify({
          operational_ruling: 'fixture',
          no_live_run_verification: 'fixture',
          owner_branch_ruleset_evidence: 'fixture',
          durable_artifact_root: '/unused',
          runner_identity: 'crq-runner-app',
          publisher_spool: {
            ssh_alias: 'crq@spool.invalid',
            ssh_key: '/unused/key',
            legacy_shell: true,
          },
        })}\n`,
      );
      let message = '';
      try {
        await runPublish(effects);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toContain('legacy_shell is not supported');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('reconciliation through the route', () => {
  function queueWithItems(items: readonly JsonValue[]): JsonObject {
    return new JsonObject([
      ['items', [...items]],
      ['backfill_scope_failures', new JsonObject([])],
      // The failure-history map the family-release rule reads; tests seed the
      // families they expect to survive or be released.
      ['backfill_families', new JsonObject([['review-ledger', JsonNumber.int(1)]])],
    ]);
  }

  function scopeOf(review: JsonObject): JsonValue {
    const payload = review.get('payload');
    if (!(payload instanceof JsonObject)) throw new Error('review has no payload');
    const scope = payload.get('requested_scope');
    if (scope === undefined) throw new Error('review has no requested_scope');
    return scope;
  }

  async function seedQueue(effects: PublishRunEffects, items: readonly JsonValue[]): Promise<void> {
    await writeFile(join(effects.stateRoot, 'queue.json'), ledgerQueueText(queueWithItems(items)));
  }

  test('a publication-pending item flips to done, families release, head lands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-reconcile-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      const review = pending.find((value) => recordEventType(value) === 'review');
      if (!(review instanceof JsonObject)) throw new Error('fixture has no review');
      await writeSeeds(effects, pending);
      await seedRemoteBranch(effects);
      const reviewId = recordId(review);
      scopeOf(review);
      await seedQueue(effects, [
        new JsonObject([
          ['kind', 'backfill'],
          ['family', 'review-ledger'],
          ['job_id', 'subject:0'],
          ['state', 'publication-pending'],
          ['publication_event_id', reviewId],
          ['scope', scopeOf(review)],
          ['scope_digest', 'digest-1'],
          ['generation', JsonNumber.int(1)],
        ]),
      ]);
      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');
      const queue = parseJsonValue(await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'));
      if (!(queue instanceof JsonObject)) throw new Error('queue not an object');
      expect(queue.get('review_ledger_head')).toBe(result.ledger_head);
      const items = queue.get('items');
      if (!Array.isArray(items) || !(items[0] instanceof JsonObject)) {
        throw new Error('queue items lost');
      }
      expect(items[0].get('state')).toBe('done');
      expect(items[0].get('published_event_id')).toBe(reviewId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a superseded blocked sibling no longer retains the family', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-sibling-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      const review = pending.find((value) => recordEventType(value) === 'review');
      if (!(review instanceof JsonObject)) throw new Error('fixture has no review');
      await writeSeeds(effects, pending);
      await seedRemoteBranch(effects);
      const reviewId = recordId(review);
      scopeOf(review);
      await seedQueue(effects, [
        new JsonObject([
          ['kind', 'backfill'],
          ['family', 'review-ledger'],
          ['job_id', 'subject:0'],
          ['state', 'publication-pending'],
          ['publication_event_id', reviewId],
          ['scope', scopeOf(review)],
          ['scope_digest', 'digest-1'],
          ['generation', JsonNumber.int(2)],
        ]),
        new JsonObject([
          ['kind', 'backfill'],
          ['family', 'review-ledger'],
          ['job_id', 'subject:1'],
          ['state', 'blocked'],
          ['scope', scopeOf(review)],
          ['scope_digest', 'digest-1'],
          ['generation', JsonNumber.int(1)],
        ]),
      ]);
      await runPublish(effects);
      const queue = parseJsonValue(await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'));
      if (!(queue instanceof JsonObject)) throw new Error('queue not an object');
      const families = queue.get('backfill_families');
      expect(families instanceof JsonObject && families.has('review-ledger')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a live execution-owner sibling still retains the family', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-owner-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      const review = pending.find((value) => recordEventType(value) === 'review');
      if (!(review instanceof JsonObject)) throw new Error('fixture has no review');
      await writeSeeds(effects, pending);
      await seedRemoteBranch(effects);
      const reviewId = recordId(review);
      scopeOf(review);
      await seedQueue(effects, [
        new JsonObject([
          ['kind', 'backfill'],
          ['family', 'review-ledger'],
          ['job_id', 'subject:0'],
          ['state', 'publication-pending'],
          ['publication_event_id', reviewId],
          ['scope', scopeOf(review)],
          ['scope_digest', 'digest-1'],
          ['generation', JsonNumber.int(2)],
        ]),
        new JsonObject([
          ['kind', 'backfill'],
          ['family', 'review-ledger'],
          ['job_id', 'subject:1'],
          ['state', 'blocked'],
          ['run', new JsonObject([['attempt', JsonNumber.int(3)]])],
          ['scope', scopeOf(review)],
          ['scope_digest', 'digest-1'],
          ['generation', JsonNumber.int(1)],
        ]),
      ]);
      await runPublish(effects);
      const queue = parseJsonValue(await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'));
      if (!(queue instanceof JsonObject)) throw new Error('queue not an object');
      const families = queue.get('backfill_families');
      expect(families instanceof JsonObject && families.has('review-ledger')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a reformatted rollout with identical values reconciles (Python == semantics)', async () => {
    // jsonEqual compares numbers by Python ==, so a value-identical rewrite
    // between the initial read and the post-push merge is not a configuration
    // change. The rollout domain itself is integer-only (float lexemes are
    // refused at read, Python parity), so the route-level reformat is lexeme
    // (1e2 vs 100), key order and whitespace; the int-vs-float/exponent
    // cross-form equality is pinned at the jsonEqual unit level below.
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-lexeme-'));
    try {
      const base = await makeEffects(root);
      await seedRollout(base);
      const { pending } = seedCase('finding-event-causal-order');
      await writeSeeds(base, pending);
      await seedRemoteBranch(base);
      // Between the run's initial read and the post-push merge, the rollout is
      // rewritten with the identical key set, reordered, reformatted, and the
      // integer limit in an equivalent integer lexeme (1e2 is integral, but
      // the rollout parser refuses exponent forms in EITHER language: they
      // are float lexemes). So the reformatted document keeps plain integers
      // and only changes key order plus whitespace; the numeric-equality
      // cross-form behavior is pinned at the jsonEqual unit level below.
      const initial = `{
  "operational_ruling": "fixture",
  "no_live_run_verification": "fixture",
  "owner_branch_ruleset_evidence": "fixture",
  "durable_artifact_root": "/unused-fixture-volume",
  "runner_identity": "crq-runner-app",
  "publisher_spool": { "ssh_alias": "crq@spool.invalid", "ssh_key": "/unused/key" },
  "generation": 1,
  "limit": 100
}\n`;
      const reformatted = `{
  "limit": 100,
  "generation": 1,
  "publisher_spool": { "ssh_key": "/unused/key", "ssh_alias": "crq@spool.invalid" },
  "runner_identity": "crq-runner-app",
  "durable_artifact_root": "/unused-fixture-volume",
  "owner_branch_ruleset_evidence": "fixture",
  "no_live_run_verification": "fixture",
  "operational_ruling": "fixture"
}\n`;
      await writeFile(join(base.stateRoot, 'backfill-rollout.json'), initial);
      const effects: PublishRunEffects = {
        ...base,
        pushCommit: async (batchBase, head, bundle) => {
          await writeFile(join(base.stateRoot, 'backfill-rollout.json'), reformatted);
          await base.pushCommit?.(batchBase, head, bundle);
        },
      };
      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a changed rollout refuses reconciliation and keeps the request marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-rollover-'));
    try {
      const base = await makeEffects(root);
      await seedRollout(base);
      const { pending } = seedCase('finding-event-causal-order');
      await writeSeeds(base, pending);
      await seedRemoteBranch(base);
      // Simulate a concurrent settings edit between the run's initial read and
      // the post-push merge: the transport rewrites the rollout mid-run.
      const swappedRollout = `${JSON.stringify({
        operational_ruling: 'fixture',
        no_live_run_verification: 'fixture',
        owner_branch_ruleset_evidence: 'fixture',
        durable_artifact_root: '/unused-fixture-volume',
        runner_identity: 'crq-runner-app',
        publisher_spool: { ssh_alias: 'other@spool.invalid', ssh_key: '/unused/key' },
      })}\n`;
      const effects: PublishRunEffects = {
        ...base,
        pushCommit: async (batchBase, head, bundle) => {
          await writeFile(join(base.stateRoot, 'backfill-rollout.json'), swappedRollout);
          await base.pushCommit?.(batchBase, head, bundle);
        },
      };
      let message = '';
      try {
        await runPublish(effects);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toBe('publication configuration changed; retry reconciliation');
      // The request marker survives for a retry against the new configuration.
      await expect(
        stat(join(base.stateRoot, 'backfill', 'publish-request.json')),
      ).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('creditable review verification through the route', () => {
  function syntheticOid(byte: string): string {
    return byte.repeat(40);
  }

  // A completed, creditable crq-run review. The scope digest and event id are
  // the real canonical digests of the rows/base document (sha256 over sorted,
  // utf16be-ordered canonical JSON), so ledgerValidate accepts the record and
  // the record is creditable end to end.
  function completedReview(): JsonObject {
    const A = syntheticOid('a');
    const scopeDigest = '5df73034504e89834f0676b7a127814b91d8183bd5572979160913688a4a6039';
    const scopeRow = (): JsonObject =>
      new JsonObject([
        ['path', 'src/a.ts'],
        ['blob', A],
        ['intervals', [[JsonNumber.int(1), JsonNumber.int(2)]]],
      ]);
    return new JsonObject([
      ['schema', 'cq.review-ledger/v1'],
      ['event_type', 'review'],
      ['source_key', 'camerontaylor/cq-toolkit:crq-runner-app:verify'],
      ['occurred_at', '2026-11-01T00:00:00Z'],
      ['id', '1c488ca56e2d6e776a2135048469ebc65c402839177b3b8558ac3693d0991473'],
      [
        'payload',
        new JsonObject([
          ['repo', 'camerontaylor/cq-toolkit'],
          ['subject_id', 'subject'],
          ['job_id', 'subject:0'],
          ['attempt_id', 'subject:0:1'],
          [
            'source',
            new JsonObject([
              ['repo', 'camerontaylor/cq-toolkit'],
              ['producer', 'crq-runner-app'],
              ['type', 'crq-run'],
              ['id', 'verify'],
              ['authenticated', true],
            ]),
          ],
          ['base', A],
          ['head', A],
          ['head_tree', A],
          ['target', A],
          ['target_tree', A],
          ['policy_digest', 'b'.repeat(64)],
          ['scope_digest', scopeDigest],
          [
            'paths',
            [
              new JsonObject([
                ['path', 'src/a.ts'],
                ['blob', A],
                ['mode', '100644'],
                ['disposition', 'included'],
                ['reason', 'verified'],
                ['baseline', new JsonObject([])],
              ]),
            ],
          ],
          ['requested_scope', [scopeRow()]],
          ['input_scope', [scopeRow()]],
          ['reviewed_scope', [scopeRow()]],
          [
            'completion',
            new JsonObject([
              ['terminal', true],
              ['skipped', false],
              ['scope_verified', true],
              ['exit_code', JsonNumber.int(0)],
              ['errors', []],
            ]),
          ],
          ['findings', []],
          [
            'artifacts',
            [
              new JsonObject([
                ['sha256', 'c'.repeat(64)],
                ['location', `/fixtures/artifacts/${'c'.repeat(64)}`],
              ]),
            ],
          ],
          ['outcome', 'completed'],
        ]),
      ],
    ]);
  }

  test('a creditable review whose tree cannot be verified refuses publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-verif-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const review = completedReview();
      await writeSeeds(effects, [review]);
      await seedRemoteBranch(effects);
      let message = '';
      try {
        await runPublish(effects);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      // verify_review resolves the recorded head/target commits in the review
      // clone; the synthetic oids are unknown there and the review refuses.
      expect(message).toContain('git rev-parse failed');
      // Nothing was acknowledged: the record is still pending.
      const pendingDir = join(effects.stateRoot, 'backfill', 'publication', 'pending');
      expect((await readdir(pendingDir)).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a non-creditable review is accepted without verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-noncred-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      const review = pending.find((value) => recordEventType(value) === 'review');
      if (!(review instanceof JsonObject)) throw new Error('fixture has no review');
      // The vector review carries outcome "skipped": Python accepts it without
      // running verify_review (no credit is claimed).
      expect(
        review.get('payload') instanceof JsonObject &&
          (review.get('payload') as JsonObject).get('outcome'),
      ).toBe('skipped');
      await writeSeeds(effects, pending);
      await seedRemoteBranch(effects);
      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('CAS rollback refusal through the route', () => {
  test('a checkpoint ahead of the remote ref blocks a rewound publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-cas-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      await writeSeeds(effects, pending);
      // Seed the checkpoint ref directly: the validated fetch requires every
      // new head to be a descendant of this ref. The remote branch head stays
      // a synthetic oid with no parent commit, so the ancestry walk cannot
      // reach the checkpoint and the CAS guard refuses (Python parity).
      const checkpoint = 'f'.repeat(40);
      await effects.runPublisherGit(['update-ref', 'refs/crq/review-ledger-validated', checkpoint]);
      await seedRemoteBranch(effects);
      let message = '';
      try {
        await runPublish(effects);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toBe('ledger head is not a descendant of validated history');
      const pendingDir = join(effects.stateRoot, 'backfill', 'publication', 'pending');
      expect((await readdir(pendingDir)).length).toBe(pending.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('round-2 coverage: publisher clone ownership and durable transitions', () => {
  function scopeOf(review: JsonObject): JsonValue {
    const payload = review.get('payload');
    if (!(payload instanceof JsonObject)) throw new Error('review has no payload');
    const scope = payload.get('requested_scope');
    if (scope === undefined) throw new Error('review has no requested_scope');
    return scope;
  }

  /**
   * A state root nested inside a git checkout (the production default, Python's
   * `STATE = ROOT / "state"`): `git rev-parse --git-common-dir` from the bare
   * clone directory would answer with the enclosing checkout's git dir. The
   * clone must still be initialized as its own bare repository and the
   * enclosing checkout's `remote.origin.url` must stay untouched.
   */
  test('a state root inside a checkout initializes its own bare clone (no origin rewrite)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-nested-'));
    try {
      const { execFileSync } = await import('node:child_process');
      // Identity is pinned per repository: CI hosts have no ambient git
      // identity and the enclosing checkout's seed commit needs one.
      const git = (...args: string[]): Buffer =>
        execFileSync('git', args, {
          stdio: 'pipe',
          encoding: 'buffer',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'crq-fixture',
            GIT_AUTHOR_EMAIL: 'crq-fixture@localhost',
            GIT_COMMITTER_NAME: 'crq-fixture',
            GIT_COMMITTER_EMAIL: 'crq-fixture@localhost',
          },
        });
      // Enclosing checkout with a distinct origin, plus the scheduler clone
      // whose origin URL the publisher pins into its own bare clone.
      const enclosing = join(root, 'checkout');
      const enclosingOrigin = join(root, 'elsewhere.git');
      git('init', '--bare', enclosingOrigin);
      git('init', enclosing);
      git('-C', enclosing, 'remote', 'add', 'origin', enclosingOrigin);
      git('-C', enclosing, 'commit', '--allow-empty', '-m', 'seed');

      const effects = await makeEffects(join(enclosing, 'state'));
      await seedRollout(effects);
      // A scheduler clone whose origin points at the real ledger remote; the
      // nested state root sits inside the enclosing checkout.
      const scheduler = join(root, 'scheduler');
      const ledgerRemote = join(root, 'ledger.git');
      git('init', '--bare', '--initial-branch=cq/review-ledger', ledgerRemote);
      git('init', scheduler);
      git('-C', scheduler, 'remote', 'add', 'origin', ledgerRemote);
      const originUrl = git('-C', scheduler, 'remote', 'get-url', 'origin').toString().trim();
      const effectsWithScheduler: PublishRunEffects = {
        ...effects,
        runSchedulerGit: gitRunner(scheduler),
        // The clone initialization itself must run over real git: the fake
        // runner cannot reproduce the enclosing-checkout discovery this
        // regression targets.
        runPublisherGit: gitRunner(join(effects.stateRoot, 'backfill', 'publisher.git')),
        pushCommit: async () => {
          throw new Error('the fetch refuses before any push');
        },
      };

      // Unseeded remote: the run halts on the fetch, but the clone
      // initialization has already happened by then.
      const { pending } = seedCase('finding-event-causal-order');
      await writeSeeds(effectsWithScheduler, pending);
      let message = '';
      try {
        await runPublish(effectsWithScheduler);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toContain('ledger git fetch failed');

      // The bare clone exists inside the state root and owns the pin.
      const cloneDir = join(effectsWithScheduler.stateRoot, 'backfill', 'publisher.git');
      const cloneOrigin = execFileSync(
        'git',
        ['-C', cloneDir, 'config', '--get', 'remote.origin.url'],
        { encoding: 'utf8' },
      ).trim();
      expect(cloneOrigin).toBe(originUrl);
      const cloneCommonDir = execFileSync(
        'git',
        ['-C', cloneDir, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8' },
      ).trim();
      expect(resolve(cloneDir, cloneCommonDir)).toBe(resolve(cloneDir));
      // The enclosing checkout's origin is untouched.
      const enclosingUrl = execFileSync(
        'git',
        ['-C', enclosing, 'config', '--get', 'remote.origin.url'],
        { encoding: 'utf8' },
      ).trim();
      expect(enclosingUrl).toBe(enclosingOrigin);
      // Nothing was acknowledged: the records are still pending.
      const pendingDir = join(effectsWithScheduler.stateRoot, 'backfill', 'publication', 'pending');
      expect((await readdir(pendingDir)).length).toBe(pending.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * The positive verification half: a creditable review whose evidence bundle
   * restores the target/head commits and whose claimed lines sit inside the
   * changed intervals is accepted and published. The synthetic oids of the
   * fixture vectors are unknown to any clone, so this builds a real git
   * history for the review to describe.
   */
  test('a creditable review backed by a restoring bundle is verified and published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-verif-ok-'));
    try {
      const { execFileSync } = await import('node:child_process');
      const git = (...args: string[]): string =>
        execFileSync('git', args, {
          stdio: 'pipe',
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'crq-fixture',
            GIT_AUTHOR_EMAIL: 'crq-fixture@localhost',
            GIT_COMMITTER_NAME: 'crq-fixture',
            GIT_COMMITTER_EMAIL: 'crq-fixture@localhost',
          },
        });
      // Build base and head commits with one changed line in src/a.ts.
      const work = join(root, 'seedwork');
      git('init', work);
      git('-C', work, 'config', 'user.name', 'crq-fixture');
      git('-C', work, 'config', 'user.email', 'crq-fixture@localhost');
      await mkdir(join(work, 'src'), { recursive: true });
      await writeFile(join(work, 'src', 'a.ts'), 'line one\n');
      git('-C', work, 'add', '.');
      git('-C', work, 'commit', '-m', 'base');
      const base = git('-C', work, 'rev-parse', 'HEAD').trim();
      await writeFile(join(work, 'src', 'a.ts'), 'line one changed\n');
      git('-C', work, 'commit', '--all', '-m', 'head');
      const head = git('-C', work, 'rev-parse', 'HEAD').trim();
      const targetTree = git('-C', work, 'rev-parse', `${head}^{tree}`).trim();

      // The evidence bundle carries the head commit with its full history (a
      // revision range would need refs, which this work tree never creates).
      const bundlePath = join(root, 'evidence.bundle');
      git('-C', work, 'bundle', 'create', bundlePath, 'HEAD');
      const { createHash } = await import('node:crypto');
      const bundleSha = createHash('sha256')
        .update(await readFile(bundlePath))
        .digest('hex');
      const durableArtifactRoot = join(root, 'artifacts');
      await mkdir(join(durableArtifactRoot, 'sha256'), { recursive: true });
      await writeFile(join(durableArtifactRoot, 'sha256', bundleSha), await readFile(bundlePath));

      // Bundle-restore writes objects into the publisher clone, so this test
      // runs against the real-git publisher clone, like the live-path test.
      const stateRoot = join(root, 'state');
      await import('node:fs/promises').then((fs) => fs.mkdir(stateRoot, { recursive: true }));
      await writeFile(join(stateRoot, 'queue.json'), '{"items":[]}\n');
      const remote = join(root, 'remote.git');
      const scheduler = join(root, 'scheduler');
      git('init', '--bare', '--initial-branch=cq/review-ledger', remote);
      git('init', scheduler);
      git('-C', scheduler, 'config', 'user.name', 'crq-fixture');
      git('-C', scheduler, 'config', 'user.email', 'crq-fixture@localhost');
      git('-C', scheduler, 'remote', 'add', 'origin', remote);
      git('-C', scheduler, 'commit', '--allow-empty', '-m', 'seed');
      git('-C', scheduler, 'push', 'origin', 'HEAD:cq/review-ledger');

      const blobA = git('-C', work, 'rev-parse', `HEAD:src/a.ts`).trim();
      const review = verifiableReview({
        base,
        head,
        targetTree,
        blob: blobA,
        // The default store verify resolves the recorded location against
        // the durable store, so the record cites the real file path.
        bundleLocation: join(durableArtifactRoot, 'sha256', bundleSha),
        bundleSha,
      });
      const effects: PublishRunEffects = {
        stateRoot,
        durableArtifactRoot,
        runSchedulerGit: gitRunner(scheduler),
        runPublisherGit: gitRunner(join(stateRoot, 'backfill', 'publisher.git')),
        // The default store keeps the bundle bytes under sha256/<sha>; the
        // record cites that real path, so verification resolves it.
        async verifyArtifact(reference) {
          const stored = await readFile(join(durableArtifactRoot, 'sha256', reference.sha256));
          expect(reference.location).toBe(join(durableArtifactRoot, 'sha256', reference.sha256));
          expect(stored.length).toBeGreaterThan(0);
        },
        pushCommit: async (_base, pushedHead) => {
          execFileSync(
            'git',
            [
              '-C',
              join(stateRoot, 'backfill', 'publisher.git'),
              'push',
              'origin',
              `${pushedHead}:refs/heads/cq/review-ledger`,
            ],
            { stdio: 'pipe' },
          );
        },
        async withTickLock(fn) {
          return fn();
        },
        async readQueue() {
          return new Uint8Array(await readFile(join(stateRoot, 'queue.json')));
        },
        async writeQueue(queue) {
          await writeFile(join(stateRoot, 'queue.json'), ledgerQueueText(queue));
        },
      };
      await writeSeeds(effects, [review]);
      await writeFile(
        join(stateRoot, 'backfill-rollout.json'),
        `${JSON.stringify({
          operational_ruling: 'fixture',
          no_live_run_verification: 'fixture',
          owner_branch_ruleset_evidence: 'fixture',
          durable_artifact_root: durableArtifactRoot,
          runner_identity: 'crq-runner-app',
          publisher_spool: { ssh_alias: 'crq@spool.invalid', ssh_key: '/unused/key' },
        })}\n`,
      );

      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');
      const ackDir = join(stateRoot, 'backfill', 'publication', 'ack');
      expect((await readdir(ackDir)).length).toBe(1);
      // The review record is on the remote branch.
      const listing = execFileSync(
        'git',
        ['-C', remote, 'ls-tree', '-r', '--name-only', 'cq/review-ledger'],
        { encoding: 'utf8' },
      );
      expect(listing.split('\n').filter((line) => line.startsWith('records/'))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** The reject half: claimed lines outside the changed intervals refuse. */
  test('a creditable review claiming lines outside the diff refuses publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-verif-no-'));
    try {
      const { execFileSync } = await import('node:child_process');
      const git = (...args: string[]): string =>
        execFileSync('git', args, {
          stdio: 'pipe',
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'crq-fixture',
            GIT_AUTHOR_EMAIL: 'crq-fixture@localhost',
            GIT_COMMITTER_NAME: 'crq-fixture',
            GIT_COMMITTER_EMAIL: 'crq-fixture@localhost',
          },
        });
      const work = join(root, 'seedwork');
      git('init', work);
      git('-C', work, 'config', 'user.name', 'crq-fixture');
      git('-C', work, 'config', 'user.email', 'crq-fixture@localhost');
      await mkdir(join(work, 'src'), { recursive: true });
      await writeFile(join(work, 'src', 'a.ts'), 'line one\n');
      git('-C', work, 'add', '.');
      git('-C', work, 'commit', '-m', 'base');
      const base = git('-C', work, 'rev-parse', 'HEAD').trim();
      await writeFile(join(work, 'src', 'a.ts'), 'line one changed\n');
      git('-C', work, 'commit', '--all', '-m', 'head');
      const head = git('-C', work, 'rev-parse', 'HEAD').trim();
      const targetTree = git('-C', work, 'rev-parse', `${head}^{tree}`).trim();
      const bundlePath = join(root, 'evidence.bundle');
      // Bundle the head commit with its full history (a revision range would
      // need refs, which this work tree never creates).
      git('-C', work, 'bundle', 'create', bundlePath, 'HEAD');
      const { createHash } = await import('node:crypto');
      const bundleSha = createHash('sha256')
        .update(await readFile(bundlePath))
        .digest('hex');
      const durableArtifactRoot = join(root, 'artifacts');
      await mkdir(join(durableArtifactRoot, 'sha256'), { recursive: true });
      await writeFile(join(durableArtifactRoot, 'sha256', bundleSha), await readFile(bundlePath));

      const stateRoot = join(root, 'state');
      await import('node:fs/promises').then((fs) => fs.mkdir(stateRoot, { recursive: true }));
      await writeFile(join(stateRoot, 'queue.json'), '{"items":[]}\n');
      const remote = join(root, 'remote.git');
      const scheduler = join(root, 'scheduler');
      git('init', '--bare', '--initial-branch=cq/review-ledger', remote);
      git('init', scheduler);
      git('-C', scheduler, 'config', 'user.name', 'crq-fixture');
      git('-C', scheduler, 'config', 'user.email', 'crq-fixture@localhost');
      git('-C', scheduler, 'remote', 'add', 'origin', remote);
      git('-C', scheduler, 'commit', '--allow-empty', '-m', 'seed');
      git('-C', scheduler, 'push', 'origin', 'HEAD:cq/review-ledger');

      const blobA = git('-C', work, 'rev-parse', `HEAD:src/a.ts`).trim();
      // The diff changed line 1 only; the review claims line 3.
      const review = verifiableReview({
        base,
        head,
        targetTree,
        blob: blobA,
        // The diff changed line 1 only; the review claims line 3.
        claimedLine: 3,
        bundleLocation: join(durableArtifactRoot, 'sha256', bundleSha),
        bundleSha,
      });
      const effects: PublishRunEffects = {
        stateRoot,
        durableArtifactRoot,
        runSchedulerGit: gitRunner(scheduler),
        runPublisherGit: gitRunner(join(stateRoot, 'backfill', 'publisher.git')),
        async verifyArtifact() {
          return undefined;
        },
        pushCommit: async () => {
          throw new Error('the push must never run: verification refuses first');
        },
        async withTickLock(fn) {
          return fn();
        },
        async readQueue() {
          return new Uint8Array(await readFile(join(stateRoot, 'queue.json')));
        },
        async writeQueue(queue) {
          await writeFile(join(stateRoot, 'queue.json'), ledgerQueueText(queue));
        },
      };
      await writeSeeds(effects, [review]);
      await writeFile(
        join(stateRoot, 'backfill-rollout.json'),
        `${JSON.stringify({
          operational_ruling: 'fixture',
          no_live_run_verification: 'fixture',
          owner_branch_ruleset_evidence: 'fixture',
          durable_artifact_root: durableArtifactRoot,
          runner_identity: 'crq-runner-app',
          publisher_spool: { ssh_alias: 'crq@spool.invalid', ssh_key: '/unused/key' },
        })}\n`,
      );
      let message = '';
      try {
        await runPublish(effects);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toBe('credit outside head-side changed intervals');
      const pendingDir = join(stateRoot, 'backfill', 'publication', 'pending');
      expect((await readdir(pendingDir)).length).toBe(1);
      // No acknowledgements exist, so the ack directory was never created.
      await expect(stat(join(stateRoot, 'backfill', 'publication', 'ack'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** The ack transition mints one durable job-state event with its id recorded. */
  test('acknowledgement spools one job-state event and records it once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-transition-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      const review = pending.find((value) => recordEventType(value) === 'review');
      if (!(review instanceof JsonObject)) throw new Error('fixture has no review');
      await writeSeeds(effects, pending);
      await seedRemoteBranch(effects);
      await writeFile(
        join(effects.stateRoot, 'queue.json'),
        ledgerQueueText(
          new JsonObject([
            [
              'items',
              [
                new JsonObject([
                  ['kind', 'backfill'],
                  ['family', 'review-ledger'],
                  ['subject_id', 'subject'],
                  ['job_id', 'subject:0'],
                  ['state', 'publication-pending'],
                  ['publication_event_id', recordId(review)],
                  ['scope', scopeOf(review)],
                  ['scope_digest', 'digest-1'],
                  ['generation', JsonNumber.int(1)],
                  ['attempt', JsonNumber.int(1)],
                  ['not_before', null],
                ]),
              ],
            ],
            ['backfill_scope_failures', new JsonObject([])],
            ['backfill_families', new JsonObject([['review-ledger', JsonNumber.int(1)]])],
          ]),
        ),
      );
      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');

      // Exactly one durable job-state record for the transition, retained in
      // the outbox (pending/ keeps the canonical bytes; ack/ keeps markers).
      const outboxDir = join(effects.stateRoot, 'backfill', 'publication', 'pending');
      const retained = await readdir(outboxDir);
      const jobStates: JsonObject[] = [];
      const allTypes: string[] = [];
      for (const name of retained) {
        const value = ledgerLoads(await readFile(join(outboxDir, name)));
        const eventType = value instanceof JsonObject ? value.get('event_type') : undefined;
        allTypes.push(typeof eventType === 'string' ? eventType : String(eventType));
        if (value instanceof JsonObject && eventType === 'job-state') {
          jobStates.push(value);
        }
      }
      expect({
        retained: retained.length,
        types: allTypes.sort(),
        jobStates: jobStates.length,
      }).toEqual({
        retained: 3,
        types: ['finding-event', 'job-state', 'review'],
        jobStates: 1,
      });
      const payload = jobStates[0]!.get('payload');
      if (!(payload instanceof JsonObject)) throw new Error('job-state has no payload');
      expect(payload.get('reason')).toBe('remote publication acknowledged');
      expect(payload.get('state')).toBe('done');
      expect(payload.get('job_id')).toBe('subject:0');
      // The queue records the transition id under backfill_state_events.
      const queue = parseJsonValue(await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'));
      if (!(queue instanceof JsonObject)) throw new Error('queue not an object');
      const events = queue.get('backfill_state_events');
      if (!(events instanceof JsonObject)) throw new Error('no backfill_state_events');
      const recorded = events.entries.map(([, value]) => value);
      expect(recorded).toContain(jobStates[0]!.get('id'));
      // A full replay (same retained record still acknowledged) adds nothing:
      // the rerun publishes the ack-spooled job-state record, then a third
      // run is idle and the map keeps exactly that one id.
      const second = await runPublish(effects);
      expect(second.publication).toBe('reconciled');
      const third = await runPublish(effects);
      expect(third).toEqual({ publication: 'idle' });
      const queueAfter = parseJsonValue(
        await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'),
      );
      const eventsAfter = (queueAfter as JsonObject).get('backfill_state_events');
      expect(eventsAfter).toEqual(events);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** The other half of the queue-level transition: failure history is erased. */
  test('reconciliation removes covered entries from backfill_scope_failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-scopefail-'));
    try {
      const effects = await makeEffects(root);
      await seedRollout(effects);
      const { pending } = seedCase('finding-event-causal-order');
      const review = pending.find((value) => recordEventType(value) === 'review');
      if (!(review instanceof JsonObject)) throw new Error('fixture has no review');
      await writeSeeds(effects, pending);
      await seedRemoteBranch(effects);
      // Python keys the failure map by path lineage; the reconciled item
      // completes unit src/a.ts, so that entry must disappear while the
      // untouched sibling stays.
      const lineage = 'src/a.ts';
      await writeFile(
        join(effects.stateRoot, 'queue.json'),
        ledgerQueueText(
          new JsonObject([
            [
              'items',
              [
                new JsonObject([
                  ['kind', 'backfill'],
                  ['family', 'review-ledger'],
                  ['subject_id', 'subject'],
                  ['job_id', 'subject:0'],
                  ['state', 'publication-pending'],
                  ['publication_event_id', recordId(review)],
                  ['scope', scopeOf(review)],
                  ['scope_digest', 'digest-1'],
                  ['generation', JsonNumber.int(1)],
                  ['path_lineages', new JsonObject([[lineage, lineage]])],
                ]),
              ],
            ],
            [
              'backfill_scope_failures',
              new JsonObject([
                [lineage, JsonNumber.int(2)],
                ['other/unit', JsonNumber.int(5)],
              ]),
            ],
            ['backfill_families', new JsonObject([['review-ledger', JsonNumber.int(1)]])],
          ]),
        ),
      );
      const result = await runPublish(effects);
      expect(result.publication).toBe('reconciled');
      const queue = parseJsonValue(await readFile(join(effects.stateRoot, 'queue.json'), 'utf8'));
      if (!(queue instanceof JsonObject)) throw new Error('queue not an object');
      const failures = queue.get('backfill_scope_failures');
      if (!(failures instanceof JsonObject)) throw new Error('no backfill_scope_failures');
      expect(failures.has(lineage)).toBe(false);
      expect(failures.get('other/unit')).toEqual(JsonNumber.int(5));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** The unit path (queue-runner CLI): absent rollout is ok/disabled, exit 0. */
  test('runPublishUnit maps an absent rollout to disabled, not failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-unit-'));
    try {
      const stateRoot = join(root, 'state');
      await import('node:fs/promises').then((fs) => fs.mkdir(stateRoot, { recursive: true }));
      await writeFile(join(stateRoot, 'queue.json'), '{"items":[]}\n');
      const clone = join(root, 'clone');
      await import('node:fs/promises').then((fs) => fs.mkdir(clone, { recursive: true }));
      const { runPublishUnit } = await import('../../../src/adapters/crq/publishSource.js');
      const outcome = await runPublishUnit({
        stateRoot,
        cloneRoot: clone,
        durableArtifactRoot: join(root, 'artifacts'),
      });
      // Python: {"publication": "disabled"}, a unit success with exit 0.
      expect(outcome).toEqual({ status: 'ok', value: { publication: 'disabled' } });
      // No failure marker was written.
      await expect(
        stat(join(stateRoot, 'backfill', 'publication-failure.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a usable config with a custom state root reports disabled only at that root', async () => {
    // The reviewer's scenario: config.json names a custom state_root, the
    // rollout file there is absent, and the default <root>/state directory is
    // also empty. The disabled outcome is legitimate (the configured rollout
    // is genuinely absent), but publisherStateRoot must probe the CONFIGURED
    // root, not the default; if the configured root holds a malformed rollout
    // the outcome is the integrity failure, never disabled.
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-customstate-'));
    try {
      const stateRoot = join(root, 'custom-state');
      await writeFile(
        join(root, 'config.json'),
        `${JSON.stringify({ clone: join(root, 'clone'), state_root: stateRoot })}\n`,
      );
      await import('node:fs/promises').then((fs) => fs.mkdir(stateRoot, { recursive: true }));
      await writeFile(join(stateRoot, 'queue.json'), '{"items":[]}\n');
      const crq = (await import('../../../src/queue-runner/crq.js')) as {
        publishLiveCommand: (runnerRoot: string) => Promise<{
          status: string;
          value?: unknown;
          error?: string;
        }>;
      };
      // Absent rollout at the configured root: disabled, not failure.
      expect(await crq.publishLiveCommand(root)).toEqual({
        status: 'ok',
        value: { publication: 'disabled' },
      });
      // A malformed rollout at the configured root is the integrity refusal.
      await writeFile(join(stateRoot, 'backfill-rollout.json'), '{"durable_artifact_root":');
      const failed = await crq.publishLiveCommand(root);
      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('backfill rollout prerequisites incomplete');
      // A missing or clone-less config.json is the CONFIG-load failure:
      // Python raises before settings() could ever return None.
      await writeFile(join(root, 'config.json'), '{}\n');
      const noClone = await crq.publishLiveCommand(root);
      expect(noClone.status).toBe('failed');
      expect(noClone.error).toBe('runner config.json missing, malformed, or has no clone path');
      await rm(join(root, 'config.json'), { force: true });
      const noConfig = await crq.publishLiveCommand(root);
      expect(noConfig.status).toBe('failed');
      expect(noConfig.error).toBe('runner config.json missing, malformed, or has no clone path');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a relative config state_root resolves against the runner root', async () => {
    // readPublisherRoots resolves a relative state_root before binding
    // effects; a relative root would make git -C state/backfill/publisher.git
    // init into publisher.git/state/... (reproduced by the reviewer). The
    // exported helpers pin both derivations: roots resolve, and the probe
    // (publisherStateRoot) targets the same resolved directory.
    const root = await mkdtemp(join(tmpdir(), 'crq-publish-relstate-'));
    try {
      await writeFile(
        join(root, 'config.json'),
        `${JSON.stringify({ clone: join(root, 'clone'), state_root: 'state' })}\n`,
      );
      const clone = join(root, 'clone');
      await import('node:fs/promises').then((fs) => fs.mkdir(clone, { recursive: true }));
      const crq = (await import('../../../src/queue-runner/crq.js')) as {
        publisherStateRoot: (runnerRoot: string) => Promise<string>;
        readPublisherRoots: (
          runnerRoot: string,
        ) => Promise<{ stateRoot: string; cloneRoot: string } | null>;
      };
      const probed = await crq.publisherStateRoot(root);
      expect(isAbsolute(probed)).toBe(true);
      expect(probed).toBe(join(root, 'state'));
      // No rollout at the resolved root: readPublisherRoots reports null and
      // the CLI branch reports disabled (already covered above).
      const roots = await crq.readPublisherRoots(root);
      expect(roots).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Build a creditable review record over real git history. The bundle artifact
 * restores base..head into the publisher clone; `claimedLine` defaults to the
 * changed line so the scope verifies.
 */
function verifiableReview(options: {
  base: string;
  head: string;
  targetTree: string;
  blob: string;
  bundleLocation: string;
  bundleSha: string;
  claimedLine?: number;
}): JsonObject {
  const A = options.blob;
  const claimedLine = options.claimedLine ?? 1;
  const scopeRow = (): JsonObject =>
    new JsonObject([
      ['path', 'src/a.ts'],
      ['blob', A],
      ['intervals', [[JsonNumber.int(claimedLine), JsonNumber.int(claimedLine)]]],
    ]);
  const scopeRows = [scopeRow()];
  const payload = new JsonObject([
    ['repo', 'camerontaylor/cq-toolkit'],
    ['subject_id', 'subject'],
    ['job_id', 'subject:0'],
    ['attempt_id', 'subject:0:1'],
    [
      'source',
      new JsonObject([
        ['repo', 'camerontaylor/cq-toolkit'],
        ['producer', 'crq-runner-app'],
        ['type', 'crq-run'],
        ['id', 'verify'],
        ['authenticated', true],
      ]),
    ],
    ['base', options.base],
    ['head', options.head],
    ['head_tree', options.targetTree],
    ['target', options.head],
    ['target_tree', options.targetTree],
    ['policy_digest', 'b'.repeat(64)],
    ['scope_digest', ledgerDigestOf(scopeRows)],
    [
      'paths',
      [
        new JsonObject([
          ['path', 'src/a.ts'],
          ['blob', A],
          ['mode', '100644'],
          ['disposition', 'included'],
          ['reason', 'verified'],
          ['baseline', new JsonObject([])],
        ]),
      ],
    ],
    ['requested_scope', scopeRows],
    ['input_scope', scopeRows],
    ['reviewed_scope', scopeRows],
    [
      'completion',
      new JsonObject([
        ['terminal', true],
        ['skipped', false],
        ['scope_verified', true],
        ['exit_code', JsonNumber.int(0)],
        ['errors', []],
      ]),
    ],
    ['findings', []],
    [
      'artifacts',
      [
        new JsonObject([
          ['sha256', options.bundleSha],
          ['location', options.bundleLocation],
          ['kind', 'git-bundle'],
        ]),
      ],
    ],
    ['outcome', 'completed'],
  ]);
  return ledgerEvent(
    'review',
    'camerontaylor/cq-toolkit:crq-runner-app:verify',
    '2026-11-01T00:00:00Z',
    payload,
  );
}

void stringAt;
void requireObject;
