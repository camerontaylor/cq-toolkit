/**
 * Real git plumbing for `review_ledger.GitLedger`, behind one injected
 * command seam.
 *
 * This adapter owns the effects the pure publisher driver
 * (`src/ops/review/internal/crq/publisher.ts`) deliberately defers: fetching
 * and reading validated ledger history from the publication clone, committing
 * one planned batch on top of the fetched head through a temporary index
 * (never the clone's own), and handing the bundle to the configured signer
 * transport. Layout and bytes are Python-compatible:
 *
 * - `fetch()` pins rollback protection BEFORE network I/O
 *   (`refs/crq/review-ledger-validated` compare-and-swap under contention),
 *   fetches into a throwaway `refs/crq/ledger-fetch/<uuid>` ref, then reads
 *   every commit of the head (including empty ones and refusing merges).
 * - `read()` inspects `--raw -z` diff-tree output so only additions of
 *   regular 100644 blobs are ever accepted, addresses blobs by the immutable
 *   oid from the raw diff (never a caller path), and batches
 *   `cat-file --batch` responses in groups of 64.
 * - `publishBatch()` builds the commit with `GIT_INDEX_FILE` in a throwaway
 *   directory, Python's committer identity and `batch[0].occurred_at` for
 *   both dates, then either pushes `head:refs/heads/cq/review-ledger`
 *   directly or creates `refs/crq/ledger-publish/<head>` and hands
 *   `bundle create <ref> --not <base>` bytes to the injected signer spool
 *   (`push_commit`), deleting the temporary ref afterwards. The bundle is
 *   bounded at 64 MiB exactly as Python's signer transport requires.
 *
 * Every git call runs through the injected `runGit` port, which the file
 * binding realizes with the repository's hardened argv-array `execFile`
 * (`src/shared/gitHarden.ts`): no shell, scrubbed git environment, no
 * replace objects, no prompts. Nothing here reads the environment or the
 * clock itself; the caller's effects own those.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCanonicalBytes,
  ledgerLoads,
  ledgerRecordPath,
  ledgerValidate,
  ledgerValidateSequence,
} from '../../policy/crq/ledger.js';

/** A push/transport failure that a fresh fetch can reconcile: retry class. */
export class LedgerTransportError extends Error {
  override readonly name = 'LedgerTransportError';
  /** The git subcommand whose failure produced this error (`push`, ...). */
  readonly operation: string;

  constructor(message: string, operation = '') {
    super(message);
    this.operation = operation;
  }
}

/** One executed git invocation: exactly what Python's `git()` returned. */
export interface GitCall {
  readonly args: readonly string[];
  /** Process exit code; null when the process did not exit normally. */
  readonly code: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/**
 * The single process seam. The file binding spawns hardened git; tests bind
 * scripted replies. A non-zero exit is data here, not an exception: several
 * probes (`rev-parse --verify --quiet`, `merge-base --is-ancestor`,
 * compare-and-swap `update-ref`) are meaningful only by exit code.
 */
export type RunGit = (
  args: readonly string[],
  options?: { readonly env?: Record<string, string>; readonly input?: Uint8Array },
) => Promise<GitCall>;

/** The signer transport seam (`crq.Spool.publish_ledger`). */
export type PushCommit = (base: string, head: string, bundle: Uint8Array) => Promise<void>;

export interface GitLedgerOptions {
  /** The publication clone (Python's publisher-owned `publisher.git`). */
  readonly repo: string;
  /** Python fixes the branch; anything else is an integrity refusal. */
  readonly branch?: string;
  readonly remote?: string;
  /** Signer transport; absence selects the ordinary push path. */
  readonly pushCommit?: PushCommit;
  readonly runGit: RunGit;
}

/** Batched `cat-file --batch` group size, exactly Python's read(). */
const READ_GROUP = 64;
/** The signer transport bundle bound (`review_ledger.GitLedger.push`). */
const BUNDLE_BYTES = 64 * 1024 * 1024;
const CHECKPOINT = 'refs/crq/review-ledger-validated';
const ZERO_OID = '0'.repeat(40);
/** Empty stdin placeholder (a zero-length input is never piped). */
const EMPTY = new Uint8Array(0);

const OID = /^[0-9a-f]{40}$/;

function integrity(message: string): LedgerIntegrityError {
  return new LedgerIntegrityError(message);
}

function decode(out: Uint8Array): string {
  return new TextDecoder('utf-8').decode(out);
}

/** A subprocess failure Python retried through the publish loop's break. */
function transport(name: string, call: GitCall): LedgerTransportError {
  return new LedgerTransportError(
    `ledger git ${name} failed: ${call.stderr.trim() || decode(call.stdout).trim()}`,
    name,
  );
}

export class GitLedger {
  private readonly repo: string;
  private readonly remote: string;
  private readonly branch: string;
  private readonly pushCommit: PushCommit | undefined;
  private readonly runGit: RunGit;

  constructor(options: GitLedgerOptions) {
    this.repo = options.repo;
    this.remote = options.remote ?? 'origin';
    this.branch = options.branch ?? 'cq/review-ledger';
    this.pushCommit = options.pushCommit;
    this.runGit = options.runGit;
    // Python refuses in the constructor so a misconfigured publisher never
    // starts; `origin` stays safe because it cannot begin with a dash.
    if (this.remote.startsWith('-') || this.branch !== 'cq/review-ledger') {
      throw integrity('invalid publication destination');
    }
  }

  private async git(...args: readonly string[]): Promise<GitCall> {
    return this.runGit(args);
  }

  private async gitOk(...args: readonly string[]): Promise<Uint8Array> {
    const call = await this.git(...args);
    if (call.code !== 0) throw transport(args[0] ?? '', call);
    return call.stdout;
  }

  private async gitOkEnv(
    env: Record<string, string>,
    input: Uint8Array,
    ...args: readonly string[]
  ): Promise<Uint8Array> {
    const call = await this.runGit(args, { env, input });
    if (call.code !== 0) throw transport(args[0] ?? '', call);
    return call.stdout;
  }

  /** `rev-parse --verify --quiet`: empty string when the ref is absent. */
  private async revParseQuiet(ref: string): Promise<string> {
    const call = await this.git('rev-parse', '--verify', '--quiet', ref);
    if (call.code !== 0) return '';
    return decode(call.stdout).trim();
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    const call = await this.git('merge-base', '--is-ancestor', a, b);
    return call.code === 0;
  }

  /**
   * `GitLedger.fetch`: bind rollback protection before network I/O, fetch
   * into a throwaway ref, read and validate the whole history, then advance
   * the validated checkpoint without moving it backward.
   */
  async fetch(): Promise<{ head: string; values: JsonValue[] }> {
    const previous = await this.revParseQuiet(CHECKPOINT);
    const ref = `refs/crq/ledger-fetch/${randomUUID().replace(/-/g, '')}`;
    let head = '';
    try {
      await this.gitOk(
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        this.remote,
        `refs/heads/${this.branch}:${ref}`,
      );
      const parsed = await this.revParseQuiet(ref);
      if (!OID.test(parsed)) throw integrity('ledger fetch produced no head');
      head = parsed;
    } finally {
      await this.git('update-ref', '-d', ref, head === '' ? ZERO_OID : head).catch(() => undefined);
    }
    if (previous !== '' && !(await this.isAncestor(previous, head))) {
      throw integrity('ledger head is not a descendant of validated history');
    }
    const values = await this.read(head);
    // Python: never move the checkpoint backward; a checkpoint that is an
    // ancestor of ours advances past an older concurrent validation, a
    // diverged one is an integrity refusal. Compare-and-swap through
    // `update-ref <ref> <new> <expected>`, retrying up to eight times.
    let expected = previous === '' ? ZERO_OID : previous;
    for (let attempt = 0; ; attempt++) {
      const swap = await this.git('update-ref', CHECKPOINT, head, expected);
      if (swap.code === 0) break;
      const latest = await this.revParseQuiet(CHECKPOINT);
      if (latest === '') throw integrity('validated checkpoint contention');
      if (await this.isAncestor(head, latest)) break;
      if (!(await this.isAncestor(latest, head))) {
        throw integrity('validated checkpoint diverged from ledger head');
      }
      expected = latest;
      if (attempt >= 7) throw integrity('validated checkpoint contention');
    }
    return { head, values };
  }

  /**
   * `GitLedger.read`: every commit including empty ones, refusing merges;
   * only additions of regular non-executable blobs anywhere in the history;
   * blobs addressed by oid and validated at their canonical record path.
   */
  async read(head: string): Promise<JsonValue[]> {
    if (!OID.test(head)) throw integrity('invalid ledger head');
    const commitsOut = await this.gitOk('rev-list', '--reverse', '--parents', head);
    const ordered: string[] = [];
    for (const line of decode(commitsOut).split('\n')) {
      if (line === '') continue;
      const fields = line.split(' ');
      if (fields.length > 2) throw integrity('ledger merge history unsupported');
      const commit = fields[0] ?? '';
      if (!OID.test(commit)) throw integrity('malformed ledger history');
      ordered.push(commit);
    }
    const changes = await this.gitOkEnv(
      {},
      new TextEncoder().encode(`${ordered.join('\n')}\n`),
      'diff-tree',
      '--stdin',
      '--root',
      '-r',
      '--raw',
      '-z',
      '--no-renames',
      '--no-abbrev',
    );
    const tokens = decode(changes).split('\u0000');
    const commitIds = new Set(ordered);
    const entries: Array<{ commit: string; filename: string; oid: string }> = [];
    let commit: string | null = null;
    let index = 0;
    while (index < tokens.length - 1) {
      const token = tokens[index];
      index += 1;
      if (token === undefined) throw integrity('malformed ledger history');
      if (!token.startsWith(':')) {
        commit = token;
        if (commit === '' || !commitIds.has(commit)) {
          throw integrity('unexpected ledger history commit');
        }
        continue;
      }
      const fields = token.slice(1).split(' ');
      const filename = tokens[index];
      index += 1;
      // Python compares the old mode (`000000` for additions), not the oid.
      if (
        fields.length !== 5 ||
        fields[4] !== 'A' ||
        fields[0] !== '000000' ||
        filename === undefined
      ) {
        throw integrity('ledger history modifies/deletes existing records');
      }
      if (fields[1] !== '100644') {
        throw integrity('ledger records must be regular non-executable blobs');
      }
      if (commit === null) throw integrity('malformed ledger history');
      entries.push({ commit, filename, oid: fields[3] ?? '' });
    }
    const batches = new Map<string, JsonValue[]>();
    for (let offset = 0; offset < entries.length; offset += READ_GROUP) {
      const group = entries.slice(offset, offset + READ_GROUP);
      const raw = await this.gitOkEnv(
        {},
        new TextEncoder().encode(`${group.map((entry) => entry.oid).join('\n')}\n`),
        'cat-file',
        '--batch',
      );
      let cursor = 0;
      for (const entry of group) {
        const end = raw.indexOf(0x0a, cursor);
        const header = end < 0 ? '' : decode(raw.slice(cursor, end));
        const fields = header.split(' ');
        if (
          end < 0 ||
          fields.length !== 3 ||
          fields[0] !== entry.oid ||
          fields[1] !== 'blob' ||
          !/^\d+$/.test(fields[2] ?? '')
        ) {
          throw integrity('malformed ledger blob response');
        }
        const size = Number(fields[2]);
        cursor = end + 1;
        const payload = raw.slice(cursor, cursor + size);
        cursor += size;
        if (payload.length !== size || raw[cursor] !== 0x0a) {
          throw integrity('truncated ledger blob response');
        }
        cursor += 1;
        const value = ledgerLoads(payload);
        ledgerValidate(value);
        if (!(value instanceof JsonObject)) throw integrity('ledger record is not an object');
        if (entry.filename !== ledgerRecordPath(value)) {
          throw integrity('incorrect event location');
        }
        const list = batches.get(entry.commit) ?? [];
        list.push(value);
        batches.set(entry.commit, list);
      }
      if (cursor !== raw.length) throw integrity('unexpected ledger blob response');
    }
    const values: JsonValue[] = [];
    for (const name of ordered) {
      const batch = batches.get(name) ?? [];
      batch.sort((left, right) => {
        // Python sorts by `(event_type != "review", id)`: reviews first.
        const leftReview = left instanceof JsonObject && left.get('event_type') === 'review';
        const rightReview = right instanceof JsonObject && right.get('event_type') === 'review';
        if (leftReview !== rightReview) return leftReview ? -1 : 1;
        const leftId = left instanceof JsonObject ? decodeId(left) : '';
        const rightId = right instanceof JsonObject ? decodeId(right) : '';
        // Python sorts by the id string's code points.
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
      values.push(...batch);
    }
    ledgerValidateSequence(values);
    return values;
  }

  /**
   * Commit one planned batch on top of `baseHead` and publish it: ordinary
   * push when no signer transport is configured, otherwise a bundle through
   * the injected `push_commit`. The outcome is transport data only; the
   * publisher driver never trusts it as acknowledgement.
   */
  async publishBatch(batch: readonly JsonValue[], baseHead: string): Promise<{ commit: string }> {
    if (batch.length === 0) throw integrity('empty publication batch');
    const first = batch[0];
    if (!(first instanceof JsonObject)) throw integrity('batch record is not an object');
    const occurredAt = first.get('occurred_at');
    if (typeof occurredAt !== 'string') throw integrity('batch record has no occurred_at');
    const env: Record<string, string> = {
      GIT_AUTHOR_NAME: 'crq',
      GIT_AUTHOR_EMAIL: 'crq@localhost',
      GIT_COMMITTER_NAME: 'crq',
      GIT_COMMITTER_EMAIL: 'crq@localhost',
      GIT_AUTHOR_DATE: occurredAt,
      GIT_COMMITTER_DATE: occurredAt,
    };
    // The temporary index lives in its own directory so concurrent batch
    // builders never share state (Python's TemporaryDirectory per batch).
    const directory = await mkdtemp(join(tmpdir(), 'crq-ledger-'));
    const indexEnv = (): Record<string, string> => ({
      ...env,
      GIT_INDEX_FILE: join(directory, 'index'),
    });
    try {
      await this.gitOkEnv(indexEnv(), EMPTY, 'read-tree', baseHead);
      for (const value of batch) {
        if (!(value instanceof JsonObject)) throw integrity('batch record is not an object');
        const bytes = ledgerCanonicalBytes(value);
        const blob = decode(
          await this.gitOkEnv(indexEnv(), bytes, 'hash-object', '-w', '--stdin'),
        ).trim();
        if (!OID.test(blob)) throw integrity('hash-object produced no blob id');
        await this.gitOkEnv(
          indexEnv(),
          EMPTY,
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${blob},${ledgerRecordPath(value)}`,
        );
      }
      const tree = decode(await this.gitOkEnv(indexEnv(), EMPTY, 'write-tree')).trim();
      if (!OID.test(tree)) throw integrity('write-tree produced no tree id');
      const commit = decode(
        await this.gitOkEnv(
          env,
          EMPTY,
          'commit-tree',
          tree,
          '-p',
          baseHead,
          '-m',
          `Append review events ${batch.length}`,
        ),
      ).trim();
      if (!OID.test(commit)) throw integrity('commit-tree produced no commit id');
      await this.push(baseHead, commit);
      return { commit };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** `GitLedger.push`: direct push, or the signer bundle transport. */
  private async push(base: string, head: string): Promise<void> {
    if (this.pushCommit === undefined) {
      const call = await this.git('push', this.remote, `${head}:refs/heads/${this.branch}`);
      if (call.code !== 0) throw transport('push', call);
      return;
    }
    const ref = `refs/crq/ledger-publish/${head}`;
    const set = await this.git('update-ref', ref, head);
    if (set.code !== 0) throw transport('update-ref', set);
    try {
      const directory = await mkdtemp(join(tmpdir(), 'crq-bundle-'));
      try {
        const bundle = join(directory, 'publication.bundle');
        const created = await this.git('bundle', 'create', bundle, ref, '--not', base);
        if (created.code !== 0) throw transport('bundle create', created);
        const bytes = new Uint8Array(await readFile(bundle));
        if (bytes.length === 0 || bytes.length > BUNDLE_BYTES) {
          throw integrity('ledger bundle exceeds signer transport bound');
        }
        await this.pushCommit(base, head, bytes);
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      await this.git('update-ref', '-d', ref, head).catch(() => undefined);
    }
  }

  /**
   * Ensure the publisher-owned bare clone exists, then pin the publication
   * remote's URL (Python's `worker_services`: `git init --bare` once, then
   * `git config remote.origin.url <scheduler clone origin>`). The probe
   * requires the discovered repository to be the intended one: a state root
   * nested inside a checkout makes `rev-parse --git-common-dir` succeed
   * against the enclosing checkout, and trusting it would rewrite the
   * enclosing `remote.origin.url` and publish from the wrong repository.
   */
  async ensureBareRepo(url: string): Promise<void> {
    await mkdir(this.repo, { recursive: true });
    const probe = await this.git('rev-parse', '--git-common-dir');
    let initialized = false;
    if (probe.code === 0) {
      const commonDir = decode(probe.stdout).trim();
      const resolved = resolve(this.repo, commonDir);
      initialized = resolved === this.repo || resolved.startsWith(this.repo + sep);
    }
    if (!initialized) {
      const init = await this.runGit(['init', '--bare', '--quiet', this.repo]);
      if (init.code !== 0) throw transport('init', init);
    }
    const set = await this.git('config', 'remote.origin.url', url);
    if (set.code !== 0) throw transport('config', set);
  }
}

function decodeId(value: JsonObject): string {
  const id = value.get('id');
  return typeof id === 'string' ? id : '';
}
