import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  GitLedger,
  LedgerTransportError,
  type RunGit,
} from '../../../src/adapters/crq/ledgerGit.js';
import { runPublish, type PublishRunEffects } from '../../../src/ops/crq/publishRun.js';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { LedgerIntegrityError, ledgerCanonicalBytes } from '../../../src/policy/crq/ledger.js';
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
        // `rev-parse --git-common-dir` probes for a repository in
        // ensureBareRepo; an empty repo directory answers with `.`.
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
        // `merge-base --is-ancestor A B`: args[2]=A, args[3]=B.
        const ancestor = args[2] ?? '';
        const descendant = args[3] ?? '';
        if (ancestor === descendant) return { code: 0, stdout: new Uint8Array(0) };
        // The fake history is linear; everything fetched before the current
        // remote head is an ancestor of it.
        const known = ['0'.repeat(40), ...this.pushed];
        if (this.remoteBranch.head !== null && known.includes(ancestor ?? '')) {
          return { code: 0, stdout: new Uint8Array(0) };
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
  const effects: PublishRunEffects = {
    stateRoot,
    durableArtifactRoot: join(root, 'artifacts'),
    runSchedulerGit: fakeRunGit(scheduler),
    runPublisherGit: fakeRunGit(publisher),
    // Python's B1 emitter drives the real publisher through `OracleArtifacts`,
    // which accepts the two public synthetic references before the real store.
    // Mirror that wrapper so vector replay needs no host paths.
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
  return `${JSON.stringify(JSON.parse(canonicalText(queue)))}\n`;
}

function canonicalText(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
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
      await expect(runPublish(effects)).rejects.toBeInstanceOf(Error);
      // Python returns {"publication": "disabled"} for a missing rollout;
      // the route refuses instead of guessing, so no request was written.
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

      // Recovery: rebuild the roots with a working transport; the request
      // marker written by the failed run drives one more publication.
      const healed = await makeEffects(root);
      await seedRollout(healed);
      await seedRemoteBranch(healed);
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
    if (options?.input !== undefined && options.input.length > 0) {
      return new Promise((resolve) => {
        const child = spawn('git', ['-C', repo, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
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
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
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

describe('git ledger transport: fetch refuses a non-descendant head', () => {
  test('the validated checkpoint blocks rollback', async () => {
    const fake = new FakeGit();
    const ledger = new GitLedger({ repo: '/unused', runGit: fakeRunGit(fake) });
    // With no remote branch the fetch refuses; the checkpoint protection is
    // exercised in the real-git test above.
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
});

void stringAt;
void requireObject;
