import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { GhFn } from '../../../adapters/forge-github/gh.js';
import { fileWorktreeRegistry, reviewBranchFor } from '../../../adapters/git/prWorktree.js';
import { makeGitMutex } from '../../../shared/gitMutex.js';
import type { ReviewAddressInput, ReviewAddressResult, ReviewAddressReport } from '../address.js';
import {
  recordAddressTerminalEvidence,
  settleAddressTerminalEvidence,
  persistAddressTerminalReport,
  type AddressTerminalAttempt,
  type AddressTerminalAttemptInput,
} from './addressEvidence.js';
import type { ReviewLoopOpts, ReviewLoopOutcome } from '../../../plans/review-loop.js';

/** No capability is serialized or accepted from an op input or dependency object. */
const childContext = new AsyncLocalStorage<Child>();
const liveLeases = new WeakMap<AddressLease, AddressOwnership>();
const loopContext = new AsyncLocalStorage<{ lease: AddressLease; consumed: boolean }>();

export interface AddressSelection {
  pr: number;
  head: string;
  headRepo: string;
  headRefName: string;
}

// Private format. Bounds also apply before allocating/JSON-parsing file contents.
const MAX_RECORDS = 64;
const MAX_RECORD_BYTES = 16_384;
const MAX_TOTAL_BYTES = 131_072;
const MAX_RESOURCES = 64;
const MAX_RESOURCE_BYTES = 2_048;
const MAX_ANCHOR_BYTES = 256;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const slot = (sequence: number) => `${String(sequence).padStart(6, '0')}.json`;
const bounded = () => new Error('address ownership: bound reached; attended compaction required');
type Identity = { ino: number; dev: number };
const same = (a: Identity, b: Identity) => a.ino === b.ino && a.dev === b.dev;

interface Guard {
  version: 3;
  anchor: string;
  sequence: number;
  previous: string;
  epoch: string;
  state: 'active' | 'quiescent' | 'quarantined';
  resources: string[];
}

interface Snapshot {
  anchor: string;
  identity: Identity;
  store: Identity;
  sequence: number;
  tail: string;
  total: number;
  guard?: Guard;
  receipts: Map<number, { digest: string; identity: Identity }>;
}

interface Completion {
  owner: AddressOwnership;
  predecessor: Snapshot;
  sequence: number;
  bytes: Buffer;
  staging: string;
  stagingIdentity: Identity;
}
// Only this module can mint a proof. Callback results, leases and structural
// objects cannot authorize publication; consumption precedes the first await.
const completionProofs = new WeakMap<object, Completion>();
interface TerminalInternals {
  participant<T>(lease: AddressLease, action: () => Promise<T>): Promise<T>;
  bindReport(lease: AddressLease, report: ReviewAddressReport): Promise<void>;
  workerBinding(lease: AddressLease): object;
  opaque(lease: AddressLease): void;
  cancelledResult(lease: AddressLease): Promise<ReviewAddressResult>;
  validate(): Promise<{ commonDir: string; terminal: boolean }>;
  track(promise: Promise<void>): void;
  record(participant: Participant, input: AddressTerminalAttemptInput): Promise<object>;
  defer(participant: Participant, attempt: object): boolean;
}
const terminalInternals = new WeakMap<AddressOwnership, TerminalInternals>();
const terminalAuthorities = new WeakMap<object, AddressOwnership>();
const terminalWorkers = new WeakMap<
  object,
  { owner: AddressOwnership; participant: Participant }
>();
const participantLeases = new WeakMap<AddressLease, Participant>();
interface Participant {
  lease: AddressLease;
  closed: boolean;
  arrived: boolean;
  report?: ReviewAddressReport;
  reportTarget?: string;
  reportDirectory?: Identity;
  reportAncestor?: { path: string; identity: Identity };
  started: number;
  attempts: AddressTerminalAttempt[];
  opaqueDispatched: boolean;
}

// Only validated pre-entry guard barriers can mint this classification.
const admissionRefusals = new WeakSet<object>();
function admissionRefusal(): Error {
  const error = new Error(
    'could not acquire address ownership: active or quarantined guard; attended recovery required',
  );
  admissionRefusals.add(error);
  return error;
}
export function isAddressOwnershipAdmissionRefusal(value: unknown): boolean {
  return typeof value === 'object' && value !== null && admissionRefusals.has(value);
}

function resourcesValid(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_RESOURCES &&
    value.every((key) => typeof key === 'string' && Buffer.byteLength(key) <= MAX_RESOURCE_BYTES) &&
    value.every((key, index) => index === 0 || value[index - 1]! < key)
  );
}

/** Open the actual inode, bound allocation, then verify the pathname still names it. */
async function boundedFile(path: string, limit: number, links: number) {
  if (!constants.O_NOFOLLOW) throw new Error('address ownership: no-follow unavailable');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== links) throw new Error('unsafe authority file');
    if (before.size > limit) throw bounded();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('short authority read');
      offset += read.bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(path);
    if (
      !same(before, after) ||
      !same(before, named) ||
      !named.isFile() ||
      after.size !== before.size ||
      named.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.nlink !== links
    )
      throw new Error('authority changed during read');
    return { bytes, identity: before };
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isDirectory()) throw new Error('unsafe authority directory');
    await file.sync(); // Unsupported directory fsync fails closed; no fallback.
  } finally {
    await file.close();
  }
}

async function prepare(path: string, bytes: Uint8Array): Promise<void> {
  if (!constants.O_NOFOLLOW) throw new Error('address ownership: no-follow unavailable');
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

interface Child {
  owner: AddressOwnership;
  selection: AddressSelection;
  consumed: boolean;
  keys: Set<string>;
  tasks: Set<Promise<unknown>>;
}

export interface AddressLease {
  signal: AbortSignal;
  expectedHead?: string;
  registry?: ReturnType<typeof fileWorktreeRegistry>;
  assertOwned(): Promise<void>;
  /** Track actual work even when an outer governor abandons its promise. */
  track<T>(action: () => Promise<T>): Promise<T>;
  /** Called before resolution, including before stale checkout removal. */
  assertSelection(selection: Omit<AddressSelection, 'head'>): Promise<void>;
  /** Confirms canonical checkout and administrative git-dir before driver work. */
  claimCheckout(info: { path: string; branch: string; head: string }): Promise<void>;
}

interface OwnershipOptions {
  repoRoot: string;
  git: GhFn;
  controller?: AbortController;
  signal?: AbortSignal;
}

async function gitText(git: GhFn, root: string, args: string[]): Promise<string> {
  const result = await git(['-C', root, ...args]);
  if (result.code !== 0 || !result.stdout.trim())
    throw new Error('address ownership: Git identity unavailable');
  return result.stdout.trim();
}

/** Canonical bootstrap is read-only and precedes admission. */
async function commonDirectory(opts: OwnershipOptions): Promise<string> {
  return realpath(
    resolve(
      opts.repoRoot,
      await gitText(opts.git, opts.repoRoot, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]),
    ),
  );
}

function resourceKeys(selection: AddressSelection): string[] {
  if (
    !Number.isSafeInteger(selection.pr) ||
    selection.pr < 1 ||
    !/^[a-f0-9]{40,64}$/.test(selection.head) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(selection.headRepo) ||
    !selection.headRefName ||
    selection.headRefName.startsWith('-') ||
    /[\s~^:?*\[\\]/.test(selection.headRefName) ||
    [...selection.headRefName].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    selection.headRefName.includes('..') ||
    selection.headRefName.includes('@{')
  )
    throw new Error('address ownership: invalid selection identity');
  return [
    `branch:refs/heads/${reviewBranchFor(selection.pr)}`,
    `remote:${selection.headRepo.toLowerCase()}:refs/heads/${selection.headRefName}`,
  ].sort();
}

/**
 * One common-dir lifetime owner. Lock order: owner -> resource set -> registry.
 * Active guard files are NEVER reclaimed using time or process liveness. Recovery
 * requires attended positive quiescence evidence, outside this API. Old binaries
 * which ignore the guard must not overlap deployment of this coordinator.
 */
export class AddressOwnership {
  readonly registry;
  readonly signal: AbortSignal;
  readonly guardPath: string;
  private readonly controller: AbortController;
  private readonly epoch = randomUUID();
  private readonly claims = new Map<string, Child>();
  private readonly children = new Set<Promise<unknown>>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly recorded = new Set<string>();
  private readonly terminalToken = Object.freeze({});
  private readonly participants = new Set<Participant>();
  private readonly terminalProcesses = new Set<Promise<void>>();
  private readonly terminalOperations = new Set<Promise<void>>();
  private stopping = false;
  // Refusal blocks terminal IO, but cannot substitute for the actual-task drain.
  private terminalAdmissionRefusal?: Error;
  private terminalFailure?: unknown;
  private terminalRun?: Promise<void>;

  private active = false;
  private used = false;
  private admitting = false;
  private compromised = false;
  private writeTail: Promise<void> = Promise.resolve();
  private artifact?: { ino: number; dev: number };

  constructor(
    private readonly opts: OwnershipOptions,
    readonly commonDir: string,
  ) {
    this.controller = opts.controller ?? new AbortController();
    this.signal = opts.signal
      ? AbortSignal.any([opts.signal, this.controller.signal])
      : this.controller.signal;
    this.guardPath = resolve(commonDir, 'cq-review-address-ownership.owner.json');
    this.registry = fileWorktreeRegistry(resolve(commonDir, 'cq-review-address-worktrees.json'));
    terminalInternals.set(this, {
      participant: (lease, action) => this.participant(lease, action),
      bindReport: (lease, report) => this.bindReport(lease, report),
      workerBinding: (lease) => this.workerBinding(lease),
      opaque: (lease) => this.noteOpaqueInvocation(lease),
      cancelledResult: (lease) => this.cancelledResult(lease),
      validate: () => this.validateTerminal(),
      track: (promise) => this.registerTerminalProcess(promise),
      record: (participant, input) => this.recordAttempt(participant, input),
      defer: (participant, attempt) => this.deferAttempt(participant, attempt),
    });
  }

  private get storePath(): string {
    return resolve(this.commonDir, 'cq-review-address-ownership.store');
  }
  private snapshot?: Snapshot;
  private pending: number | undefined;

  /** No authority pathname is ever replaced, repaired or recreated. */
  private async readSnapshot(allowEmpty = false): Promise<Snapshot | undefined> {
    try {
      let store;
      try {
        store = await lstat(this.storePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await lstat(this.guardPath);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw missing;
        }
        throw new Error('legacy or foreign guard without authority store');
      }
      if (!store.isDirectory() || store.isSymbolicLink()) throw new Error('unsafe authority store');
      const names = new Set<string>();
      // Bound enumeration before a readdir array or file-content allocation.
      const directory = await opendir(this.storePath);
      for await (const entry of directory) {
        if (names.size >= MAX_RECORDS * 2 + 1) throw bounded();
        if (!entry.isFile() || !/^(?:anchor|(?:pending-)?[0-9]{6})\.json$/.test(entry.name))
          throw new Error('unknown authority entry');
        names.add(entry.name);
      }
      const anchor = await boundedFile(this.guardPath, MAX_ANCHOR_BYTES, 2);
      const staged = await boundedFile(resolve(this.storePath, 'anchor.json'), MAX_ANCHOR_BYTES, 2);
      if (!same(anchor.identity, staged.identity) || !anchor.bytes.equals(staged.bytes))
        throw new Error('anchor link changed');
      const value = JSON.parse(anchor.bytes.toString('utf8')) as {
        version: number;
        anchor: string;
      };
      if (
        value.version !== 3 ||
        !UUID.test(value.anchor) ||
        Object.keys(value).sort().join() !== 'anchor,version'
      )
        throw new Error('invalid authority anchor; v2 requires attended migration');
      names.delete('anchor.json');
      let sequence = 0,
        tail = digest(anchor.bytes),
        total = anchor.bytes.length,
        guard: Guard | undefined;
      const receipts = new Map<number, { digest: string; identity: Identity }>();
      while (names.has(slot(sequence + 1))) {
        sequence++;
        if (sequence > MAX_RECORDS) throw bounded();
        const name = slot(sequence),
          pending = `pending-${name}`;
        if (!names.has(pending)) throw new Error('missing retained staging link');
        const record = await boundedFile(
          resolve(this.storePath, name),
          Math.min(MAX_RECORD_BYTES, MAX_TOTAL_BYTES - total),
          2,
        );
        const staging = await boundedFile(resolve(this.storePath, pending), MAX_RECORD_BYTES, 2);
        if (!same(record.identity, staging.identity) || !record.bytes.equals(staging.bytes))
          throw new Error('record staging link changed');
        total += record.bytes.length;
        const next = JSON.parse(record.bytes.toString('utf8')) as Guard;
        if (
          next.version !== 3 ||
          next.anchor !== value.anchor ||
          next.sequence !== sequence ||
          next.previous !== tail ||
          !UUID.test(next.epoch) ||
          !['active', 'quiescent', 'quarantined'].includes(next.state) ||
          !resourcesValid(next.resources) ||
          Object.keys(next).sort().join() !==
            'anchor,epoch,previous,resources,sequence,state,version' ||
          (!guard && (next.state !== 'active' || next.resources.length !== 0)) ||
          guard?.state === 'quarantined' ||
          (guard?.state === 'quiescent' &&
            (next.state !== 'active' ||
              next.epoch === guard.epoch ||
              next.resources.length !== 0)) ||
          (guard?.state === 'active' &&
            (next.epoch !== guard.epoch ||
              guard.resources.some((key) => !next.resources.includes(key)) ||
              (next.state === 'quiescent' && next.resources.length !== guard.resources.length)))
        )
          throw new Error('invalid authority chain');
        guard = next;
        tail = digest(record.bytes);
        receipts.set(sequence, { digest: tail, identity: record.identity });
        names.delete(name);
        names.delete(pending);
      }
      // Only this live owner's uncommitted next staging file may be in flight.
      if (this.pending === sequence + 1) names.delete(`pending-${slot(this.pending)}`);
      if (names.size || (!guard && !allowEmpty)) throw new Error('partial authority history');
      const namedStore = await lstat(this.storePath);
      if (!namedStore.isDirectory() || !same(store, namedStore))
        throw new Error('authority store changed');
      return {
        anchor: value.anchor,
        identity: anchor.identity,
        store,
        sequence,
        tail,
        total,
        receipts,
        ...(guard ? { guard } : {}),
      };
    } catch (error) {
      throw new Error(
        'address ownership: active or quarantined guard; attended recovery required',
        { cause: error },
      );
    }
  }

  private async bootstrap(): Promise<Snapshot> {
    // An existing/partial directory is a durable refusal barrier, never recovery.
    await mkdir(this.storePath, { mode: 0o700 });
    await syncDirectory(this.commonDir);
    const path = resolve(this.storePath, 'anchor.json');
    await prepare(path, Buffer.from(JSON.stringify({ version: 3, anchor: randomUUID() })));
    await link(path, this.guardPath); // Atomic create-if-absent, NEVER replacement.
    await syncDirectory(this.storePath);
    await syncDirectory(this.commonDir);
    const snapshot = await this.readSnapshot(true);
    if (!snapshot) throw new Error('address ownership: bootstrap authority missing');
    return snapshot;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const write = this.writeTail.then(action);
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async identityNow(): Promise<Snapshot> {
    const expected = this.snapshot;
    if (!expected || this.compromised) throw new Error('owner inactive');
    const [current, artifact] = await Promise.all([
      this.readSnapshot(expected.sequence === 0),
      lstat(resolve(this.commonDir, 'cq-review-address-ownership.lock')),
    ]);
    if (
      !current ||
      !same(current.identity, expected.identity) ||
      !same(current.store, expected.store) ||
      current.anchor !== expected.anchor ||
      current.tail !== expected.tail ||
      !this.artifact ||
      !artifact.isDirectory() ||
      !same(artifact, this.artifact)
    )
      throw new Error('ownership authority or lock changed');
    return current;
  }

  private transition(current: Snapshot, state: Guard['state'], resources: string[]) {
    if (current.guard && current.guard.state !== 'quiescent' && current.guard.epoch !== this.epoch)
      throw new Error('foreign active epoch');
    const sequence = current.sequence + 1;
    if (sequence > MAX_RECORDS || !resourcesValid(resources)) throw bounded();
    const bytes = Buffer.from(
      JSON.stringify({
        version: 3,
        anchor: current.anchor,
        sequence,
        previous: current.tail,
        epoch: this.epoch,
        state,
        resources,
      } satisfies Guard),
    );
    if (bytes.length > MAX_RECORD_BYTES || bytes.length + current.total > MAX_TOTAL_BYTES)
      throw bounded();
    return { sequence, bytes, staging: resolve(this.storePath, `pending-${slot(sequence)}`) };
  }

  private async writeTransition(
    state: 'active' | 'quarantined',
    resources = [...this.recorded].sort(),
  ): Promise<void> {
    try {
      const current = await this.identityNow();
      const { sequence, bytes, staging } = this.transition(current, state, resources);
      this.pending = sequence;
      await prepare(staging, bytes);
      // Awaited preparation is not an ownership fence. Revalidate before link.
      await this.identityNow();
      await link(staging, resolve(this.storePath, slot(sequence)));
      await syncDirectory(this.storePath);
      const installed = await this.identityAfter(current, sequence, digest(bytes));
      if (installed.sequence !== sequence) throw new Error('unexpected authority successor');
      const physical = await lstat(resolve(this.commonDir, 'cq-review-address-ownership.lock'));
      if (!this.artifact || !physical.isDirectory() || !same(physical, this.artifact))
        throw new Error('physical owner changed during publication');
      this.snapshot = installed;
    } catch (error) {
      await this.lose(error);
    } finally {
      this.pending = undefined;
    }
  }

  private async identityAfter(
    expected: Snapshot,
    sequence: number,
    receipt: string,
    identity?: Identity,
  ) {
    const installed = await this.readSnapshot();
    if (
      !installed ||
      !same(installed.identity, expected.identity) ||
      !same(installed.store, expected.store) ||
      installed.anchor !== expected.anchor ||
      installed.receipts.get(sequence)?.digest !== receipt ||
      (identity !== undefined && !same(installed.receipts.get(sequence)!.identity, identity))
    )
      throw new Error('address ownership: lost owner; authority prefix changed');
    return installed;
  }

  private async prepareCompletion(): Promise<Completion> {
    // Caller closed admission and verified actual descendants, not just an
    // abandoned outer promise. No lease is usable after this preparation.
    if (!this.active || this.compromised) throw new Error('owner inactive');
    this.controller.signal.throwIfAborted();
    const predecessor = await this.identityNow().catch((error: unknown) => this.lose(error));
    const prepared = this.transition(predecessor, 'quiescent', [...this.recorded].sort());
    this.pending = prepared.sequence;
    await prepare(prepared.staging, prepared.bytes);
    await syncDirectory(this.storePath);
    const staging = await boundedFile(prepared.staging, MAX_RECORD_BYTES, 1);
    if (!staging.bytes.equals(prepared.bytes)) throw new Error('completion staging changed');
    await this.identityNow().catch((error: unknown) => this.lose(error));
    this.controller.signal.throwIfAborted();
    if (
      this.children.size ||
      this.tasks.size ||
      this.terminalProcesses.size ||
      this.terminalOperations.size ||
      this.terminalAdmissionRefusal ||
      this.terminalFailure ||
      this.admitting ||
      this.compromised
    )
      throw new Error('address ownership: completion not quiescent');
    return { owner: this, predecessor, ...prepared, stagingIdentity: staging.identity };
  }

  private async publishCompletion(proof: object): Promise<void> {
    const prepared = completionProofs.get(proof);
    completionProofs.delete(proof); // Synchronous, single-use even on failure.
    if (!prepared || prepared.owner !== this || this.active || this.admitting || !this.used)
      throw new Error('address ownership: forged or consumed completion proof');
    // The ENTIRE mutex promise has fulfilled. ACTIVE/partial still blocks
    // cooperating entrants; actual old work and all old admissions are closed.
    try {
      this.controller.signal.throwIfAborted();
      const current = await this.identityAfter(
        prepared.predecessor,
        prepared.predecessor.sequence,
        prepared.predecessor.tail,
      );
      if (current.sequence !== prepared.predecessor.sequence)
        throw new Error('completion predecessor changed');
      const staging = await boundedFile(prepared.staging, MAX_RECORD_BYTES, 1);
      if (
        !same(staging.identity, prepared.stagingIdentity) ||
        !staging.bytes.equals(prepared.bytes)
      )
        throw new Error('completion staging changed');
      try {
        await lstat(resolve(this.commonDir, 'cq-review-address-ownership.lock'));
        throw new Error('conflicting physical owner before completion');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.controller.signal.throwIfAborted();
      await link(prepared.staging, resolve(this.storePath, slot(prepared.sequence)));
      // After accepting link, NEVER append an old-epoch marker or record. A
      // legitimate successor may already be active. Failure is unconfirmed
      // invocation completion, not confirmed durable quarantine.
      await syncDirectory(this.storePath);
      await this.identityAfter(
        prepared.predecessor,
        prepared.sequence,
        digest(prepared.bytes),
        prepared.stagingIdentity,
      );
    } finally {
      this.pending = undefined;
    }
  }

  private async adoptQuiescence(previous: Snapshot): Promise<void> {
    // A fresh reader must establish durability itself before its fresh ACTIVE.
    const path = resolve(this.storePath, slot(previous.sequence));
    const before = await boundedFile(path, MAX_RECORD_BYTES, 2);
    if (digest(before.bytes) !== previous.tail) throw new Error('certificate changed');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(await file.stat(), before.identity)) throw new Error('certificate replaced');
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(this.storePath);
    await this.identityNow();
  }

  private persist(state: 'active' | 'quarantined'): Promise<void> {
    return this.enqueue(() => this.writeTransition(state));
  }

  private async lose(error: unknown): Promise<never> {
    this.compromised = true;
    this.admitting = false;
    this.controller.abort(error);
    // An ambiguity marker is deliberately outside the accepted history grammar.
    // Even a partial marker refuses future admission; no guard/record is repaired.
    try {
      await prepare(
        resolve(this.storePath, `quarantined-${this.epoch}.json`),
        Buffer.from(JSON.stringify({ version: 3, epoch: this.epoch, state: 'quarantined' })),
      );
      await syncDirectory(this.storePath);
    } catch {
      /* Existing evidence or unavailable storage is never overwritten. */
    }
    throw new Error(
      'address ownership: lost owner; completion failed, durable quarantine unconfirmed; attended recovery/compaction required',
      { cause: error },
    );
  }

  private async assertIdentity(): Promise<void> {
    if (!this.active || this.compromised) throw new Error('address ownership: owner inactive');
    await this.writeTail;
    try {
      const current = await this.identityNow();
      if (
        current.guard?.epoch !== this.epoch ||
        current.guard.state !== 'active' ||
        !this.active ||
        this.compromised
      )
        throw new Error('owner no longer active');
    } catch (error) {
      await this.lose(error);
    }
  }

  private stopAdmissions = () => {
    this.stopping = true;
    this.admitting = false;
  };

  private async validateTerminal(): Promise<{ commonDir: string; terminal: boolean }> {
    if (!this.active || this.compromised || this.terminalFailure)
      throw new Error('address terminal: owner inactive/compromised');
    this.controller.signal.throwIfAborted();
    await this.assertIdentity();
    this.controller.signal.throwIfAborted();
    return { commonDir: this.commonDir, terminal: this.stopping };
  }

  private registerTerminalProcess(promise: Promise<void>): void {
    if (!this.active || this.compromised || this.terminalFailure)
      throw new Error('address terminal: process after retirement');
    const set = this.stopping ? this.terminalProcesses : this.tasks;
    set.add(promise);
    void promise.then(
      () => set.delete(promise),
      () => set.delete(promise),
    );
  }

  private async participant<T>(lease: AddressLease, action: () => Promise<T>): Promise<T> {
    if (liveLeases.get(lease) !== this || participantLeases.has(lease))
      throw new Error('address terminal: forged/reused participant');
    const participant: Participant = {
      lease,
      closed: false,
      arrived: false,
      started: Date.now(),
      attempts: [],
      opaqueDispatched: false,
    };
    participantLeases.set(lease, participant);
    this.participants.add(participant);
    try {
      const result = await action();
      if (this.stopping) await this.arrive(participant);
      return result;
    } finally {
      participant.arrived = true;
      participant.closed = true;
    }
  }

  private async bindReport(lease: AddressLease, report: ReviewAddressReport): Promise<void> {
    const participant = participantLeases.get(lease);
    if (
      !participant ||
      participant.closed ||
      participant.report ||
      !this.participants.has(participant)
    )
      throw new Error('address terminal: report binding refused');
    // Resolve aliases without creating a missing journal directory. Remember
    // the existing ancestor inode, so a later replacement is not adopted.
    let ancestor = dirname(resolve(report.reportPath));
    const tail = [basename(report.reportPath)];
    let canonical: string;
    for (;;) {
      try {
        canonical = await realpath(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor)
          throw error;
        tail.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
    }
    const identity = await lstat(canonical);
    if (!identity.isDirectory()) throw new Error('address terminal: report ancestor refused');
    const target = resolve(canonical, ...tail);
    await this.assertOwned();
    if (participant.closed || participant.report)
      throw new Error('address terminal: report target alias/rebinding');
    if (
      [...this.participants].some((entry) => entry !== participant && entry.reportTarget === target)
    ) {
      this.terminalAdmissionRefusal ??= new Error(
        'address terminal: report target alias/rebinding',
      );
      this.admitting = false;
      throw this.terminalAdmissionRefusal;
    }
    participant.reportTarget = target;
    participant.reportAncestor = { path: canonical, identity };
    participant.report = report;
  }

  private noteOpaqueInvocation(lease: AddressLease): void {
    const participant = participantLeases.get(lease);
    if (
      !this.active ||
      !this.admitting ||
      this.compromised ||
      this.signal.aborted ||
      !participant ||
      participant.closed ||
      !this.participants.has(participant)
    )
      throw new Error('address terminal: opaque invocation after admission');
    participant.opaqueDispatched = true;
  }

  private workerBinding(lease: AddressLease): object {
    const participant = participantLeases.get(lease);
    if (!participant || participant.closed || !this.participants.has(participant))
      throw new Error('address terminal: worker association refused');
    const binding = Object.freeze({});
    terminalWorkers.set(binding, { owner: this, participant });
    return binding;
  }

  private async recordAttempt(
    participant: Participant,
    input: AddressTerminalAttemptInput,
  ): Promise<object> {
    if (participant.closed || this.stopping)
      throw new Error('address terminal: attempt after close');
    await this.assertOwned();
    const attempt = await recordAddressTerminalEvidence(this.terminalToken, input);
    await this.assertOwned();
    if (participant.closed) {
      this.terminalFailure = new Error('address terminal: late attempt on closed participant');
      throw this.terminalFailure;
    }
    participant.attempts.push(attempt);
    return attempt;
  }

  private deferAttempt(participant: Participant, value: object): boolean {
    if (!this.signal.aborted || this.controller.signal.aborted || this.compromised) return false;
    if (participant.closed) {
      this.terminalFailure = new Error('address terminal: closed participant attempted cleanup');
      throw this.terminalFailure;
    }
    if (!participant.attempts.includes(value as AddressTerminalAttempt))
      throw new Error('address terminal: forged/stale attempt');
    this.stopAdmissions();
    (value as AddressTerminalAttempt).cancelled = true;
    return true;
  }

  private async arrive(participant: Participant): Promise<void> {
    if (!this.signal.aborted || this.controller.signal.aborted)
      throw new Error('address terminal: not an intact parent-cancelled lifetime');
    if (!this.participants.has(participant) || participant.closed)
      throw new Error('address terminal: invalid control arrival');
    this.stopAdmissions();
    participant.arrived = true;
    this.terminalRun ??= this.runTerminal();
    return this.terminalRun;
  }

  private async runTerminal(): Promise<void> {
    const drainDeadline = Date.now() + 60_000;
    try {
      // These control frames were never put in tasks. No actual tracked promise
      // is subtracted, including outer worker/review/registry-op registrations.
      while (
        this.tasks.size ||
        [...this.participants].some((entry) => !entry.closed && !entry.arrived)
      ) {
        await this.validateTerminal();
        if (Date.now() >= drainDeadline)
          throw new Error('address terminal: actual writers/control arrivals unresolved');
        await new Promise<void>((done) => setTimeout(done, 5));
      }
      await this.validateTerminal();
      if (this.terminalAdmissionRefusal) throw this.terminalAdmissionRefusal;
      // An opaque invocation gives no complete write-set/receipt coverage.
      // Drain it and every sibling, then refuse the shared terminal admission
      // before any evidence, restoration or report IO. Closed facts stay closed.
      if ([...this.participants].some((entry) => entry.opaqueDispatched))
        throw new Error(
          'address terminal: opaque invocation write-set unconfirmed; caller bytes retained',
        );
      const open = [...this.participants].filter((entry) => !entry.closed);
      const targets = new Set<string>();
      for (const participant of open)
        if (participant.report) {
          const target = resolve(
            await realpath(dirname(participant.report.reportPath)),
            basename(participant.report.reportPath),
          );
          const ancestor = participant.reportAncestor;
          if (
            !ancestor ||
            !same(await lstat(ancestor.path), ancestor.identity) ||
            (await realpath(ancestor.path)) !== ancestor.path ||
            target !== participant.reportTarget
          )
            throw new Error('address terminal: report target identity changed');
          if (targets.has(target)) throw new Error('address terminal: canonical report alias');
          participant.reportDirectory = await lstat(dirname(target));
          targets.add(target);
        }
      const attempts = open.flatMap((entry) =>
        entry.attempts.filter((attempt) => attempt.cancelled),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = (async () => {
          try {
            await settleAddressTerminalEvidence(this.terminalToken, attempts);
          } finally {
            // Real local ref effects survive a later restore/report failure.
            for (const participant of open)
              for (const attempt of participant.attempts) {
                if (
                  attempt.retained &&
                  participant.report &&
                  !participant.report.failed.includes(attempt.retained)
                ) {
                  participant.report.failed.push(attempt.retained);
                  const row = participant.report.attempts.findLast(
                    (row) => row.finding === attempt.finding && row.invocation === 'edit',
                  );
                  if (row) row.failedAttempt = attempt.retained;
                }
              }
          }
          for (const participant of open)
            if (participant.report) {
              const report = participant.report;
              delete report.stop;
              if (!report.reasons.includes('parent cancelled'))
                report.reasons.push('parent cancelled');
              report.findings = report.findings.map((finding) => {
                const failed = report.failed.findLast((row) => row.finding === finding.id);
                return failed && (finding.status === 'open' || finding.status === 'deferred')
                  ? { ...finding, evidence: JSON.stringify(failed) }
                  : finding;
              });
              report.wallMs = Date.now() - participant.started;
              report.fixesPerRun = new Set(
                report.fixes.flatMap((fix) => (fix.commit ? [fix.commit] : [])),
              ).size;
              await persistAddressTerminalReport(
                this.terminalToken,
                participant.reportTarget!,
                report,
                participant.reportDirectory!,
              );
            }
          if (this.terminalProcesses.size)
            throw new Error('address terminal: subprocess close unobserved');
        })();
        this.terminalOperations.add(work);
        void work.then(
          () => this.terminalOperations.delete(work),
          () => this.terminalOperations.delete(work),
        );
        await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('address terminal: cleanup lifetime unresolved')),
              60_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      await this.validateTerminal();
    } catch (error) {
      this.terminalFailure = error;
      throw error;
    }
  }

  private async cancelledResult(lease: AddressLease): Promise<ReviewAddressResult> {
    const participant = participantLeases.get(lease);
    if (!participant?.report || !this.participants.has(participant))
      throw new Error('address terminal: missing report association');
    await this.arrive(participant);
    return {
      status: 'needs-human',
      reason: `parent cancelled; report: ${participant.report.reportPath}`,
      report: participant.report,
    };
  }

  async assertOwned(): Promise<void> {
    if (!this.active || this.compromised) throw new Error('address ownership: owner inactive');
    this.signal.throwIfAborted();
    await this.assertIdentity();
    this.signal.throwIfAborted();
  }

  async withLock<T>(fn: (owner: AddressOwnership) => Promise<T>): Promise<T> {
    if (this.used) throw new Error('address ownership: owner lifetime already consumed');
    const before = await this.readSnapshot();
    if (before?.guard && before.guard.state !== 'quiescent') throw admissionRefusal();
    const completed = await makeGitMutex({
      lockPath: resolve(this.commonDir, 'cq-review-address-ownership'),
      failFast: true,
    }).withLock(async () => {
      const previous = await this.readSnapshot();
      if (previous?.guard && previous.guard.state !== 'quiescent') throw admissionRefusal();
      this.signal.throwIfAborted();
      if (this.used) throw new Error('address ownership: owner lifetime already consumed');
      this.used = true;
      this.artifact = await lstat(resolve(this.commonDir, 'cq-review-address-ownership.lock'));
      this.snapshot = previous ?? (await this.bootstrap());
      if (previous) await this.adoptQuiescence(previous);
      // Must be durable BEFORE a driver, worktree mutation, or child can start.
      await this.persist('active');
      this.signal.throwIfAborted();
      this.active = this.admitting = true;
      terminalAuthorities.set(this.terminalToken, this);
      this.signal.addEventListener('abort', this.stopAdmissions, { once: true });
      if (this.signal.aborted) this.stopAdmissions();
      let checking: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (checking) return;
        checking = (this.stopping ? this.validateTerminal() : this.assertOwned())
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            checking = undefined;
          });
      }, 250);
      timer.unref();
      try {
        const result = await fn(this);
        this.admitting = false;
        if (this.terminalAdmissionRefusal) throw this.terminalAdmissionRefusal;
        if (this.terminalFailure) throw this.terminalFailure;
        if (
          this.children.size ||
          this.tasks.size ||
          this.terminalProcesses.size ||
          this.terminalOperations.size
        )
          throw new Error('address ownership: detached work requires quarantine');
        clearInterval(timer);
        await checking;
        // Parent cancellation stops dispatch; it is never evidence of quiescence.
        const prepared = await this.enqueue(() => this.prepareCompletion());
        const proof = Object.freeze({});
        completionProofs.set(proof, prepared);
        return { result, proof };
      } catch (error) {
        this.admitting = false;
        this.controller.abort(error);
        // ACTIVE/partial already refuses. Best-effort quarantine earns no claim
        // of durable quarantine if storage is unavailable.
        if (!this.compromised) await this.persist('quarantined').catch(() => undefined);
        throw error;
      } finally {
        clearInterval(timer);
        this.signal.removeEventListener('abort', this.stopAdmissions);
        this.active = false; // Retired forever, including the cleanup interval.
      }
    }, this.signal);
    // No certificate is installed on callback, cleanup or observed compromise
    // rejection. No further write is needed to retain that refusal barrier.
    await this.publishCompletion(completed.proof);
    return completed.result;
  }

  /**
   * Complete sorted claims are taken without waiting. A conflict refuses before
   * driver dispatch; the bulk executor may requeue after the conflicting child.
   * No caller-provided implementation receives a permit.
   */
  address(selection: AddressSelection, input: ReviewAddressInput): Promise<ReviewAddressResult> {
    selection = Object.freeze({ ...selection });
    input = Object.freeze({ ...input });
    const child: Child = {
      owner: this,
      selection,
      consumed: false,
      keys: new Set(),
      tasks: new Set(),
    };
    const work = (async () => {
      if (!this.admitting) throw new Error('address ownership: admissions closed');
      if (input.source !== `pr:${selection.pr}`)
        throw new Error('address ownership: child source mismatch');
      await this.assertOwned();
      const keys = resourceKeys(selection);
      try {
        await this.claim(child, keys);
        await this.assertOwned();
        return await childContext.run(child, async () => {
          const { makeReviewAddress } = await import('../address.js');
          return makeReviewAddress()(input);
        });
      } finally {
        while (child.tasks.size) await Promise.allSettled([...child.tasks]);
        for (const key of child.keys) this.claims.delete(key);
      }
    })();
    this.children.add(work);
    // Observe both outcomes even if the caller neglects to await a child.
    void work.then(
      () => this.children.delete(work),
      () => this.children.delete(work),
    );
    return work;
  }

  private claim(child: Child, keys: string[]): Promise<void> {
    return this.enqueue(async () => {
      await this.identityNow().catch((error: unknown) => this.lose(error));
      if (!this.admitting) throw new Error('address ownership: admissions closed');
      this.signal.throwIfAborted();
      const complete = [...new Set([...child.keys, ...keys])].sort();
      if (complete.some((key) => this.claims.has(key) && this.claims.get(key) !== child))
        throw new Error('address ownership: conflicting child resource');
      const recorded = [...new Set([...this.recorded, ...complete])].sort();
      await this.writeTransition('active', recorded);
      this.signal.throwIfAborted();
      // Install claims only after durable publication and identity post-check.
      for (const key of complete) {
        this.claims.set(key, child);
        child.keys.add(key);
      }
      for (const key of recorded) this.recorded.add(key);
    });
  }

  lease(child?: Child): AddressLease {
    if (!this.active || this.compromised) throw new Error('address ownership: owner inactive');
    const lease: AddressLease = {
      signal: this.signal,
      ...(child ? { expectedHead: child.selection.head, registry: this.registry } : {}),
      assertOwned: async () => {
        if (!this.admitting) throw new Error('address ownership: admissions closed');
        await this.assertOwned();
      },
      track: (action) => {
        if (!this.admitting)
          return Promise.reject(
            this.controller.signal.aborted
              ? (this.controller.signal.reason as unknown)
              : this.signal.aborted
                ? (this.signal.reason as unknown)
                : new Error('address ownership: admissions closed'),
          );
        // Register synchronously, before asynchronous ownership checks: an
        // unawaited caller cannot finish the owner during this admission gap.
        const task = (async () => {
          await this.assertOwned();
          return action();
        })();
        this.tasks.add(task);
        child?.tasks.add(task);
        const settled = () => {
          this.tasks.delete(task);
          child?.tasks.delete(task);
        };
        void task.then(settled, settled);
        return task;
      },
      assertSelection: async (selection) => {
        if (!this.admitting) throw new Error('address ownership: admissions closed');
        await this.assertOwned();
        if (
          child &&
          (selection.pr !== child.selection.pr ||
            selection.headRepo.toLowerCase() !== child.selection.headRepo.toLowerCase() ||
            selection.headRefName !== child.selection.headRefName)
        )
          throw new Error('address ownership: forge selection changed');
      },
      claimCheckout: async (info) => {
        if (!this.admitting) throw new Error('address ownership: admissions closed');
        await this.assertOwned();
        if (!child) return;
        if (
          info.branch !== reviewBranchFor(child.selection.pr) ||
          info.head !== child.selection.head
        )
          throw new Error('address ownership: resolved identity changed');
        const root = await realpath(info.path);
        const common = await commonDirectory({ repoRoot: root, git: this.opts.git });
        const gitDir = await realpath(
          resolve(
            root,
            await gitText(this.opts.git, root, [
              'rev-parse',
              '--path-format=absolute',
              '--git-dir',
            ]),
          ),
        );
        const branch = await gitText(this.opts.git, root, ['symbolic-ref', 'HEAD']);
        if (
          common !== this.commonDir ||
          branch !== `refs/heads/${info.branch}` ||
          (await gitText(this.opts.git, root, ['rev-parse', 'HEAD'])) !== info.head
        )
          throw new Error('address ownership: checkout identity changed');
        // Identity reads can outlive ownership. Fence the final awaited HEAD.
        await this.assertOwned();
        await this.claim(child, [`checkout:${root}`, `git-dir:${gitDir}`]);
        await this.assertOwned();
      },
    };
    liveLeases.set(lease, this);
    return lease;
  }
}

/** Only an authentic live address lease can mint a single-use loop invocation. */
export async function runAddressReviewLoop(
  lease: AddressLease,
  opts: ReviewLoopOpts,
): Promise<ReviewLoopOutcome> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address ownership: forged loop lease');
  await lease.assertOwned();
  if ((await commonDirectory(opts)) !== owner.commonDir)
    throw new Error('address ownership: loop identity changed');
  return loopContext.run({ lease, consumed: false }, async () => {
    const { runReviewLoop } = await import('../../../plans/review-loop.js');
    return runReviewLoop(opts);
  });
}

export async function withReviewLoopOwnership<T>(
  opts: OwnershipOptions,
  fn: (lease: AddressLease) => Promise<T>,
): Promise<T> {
  const context = loopContext.getStore();
  if (context) {
    // Consume before ANY await: simultaneous or nested exported calls cannot
    // borrow an invocation, including callbacks running in inherited ALS.
    if (context.consumed) throw new Error('address ownership: loop permit already consumed');
    context.consumed = true;
    const owner = liveLeases.get(context.lease);
    if (!owner || (await commonDirectory(opts)) !== owner.commonDir)
      throw new Error('address ownership: invalid loop permit');
    await context.lease.assertOwned();
    return fn(context.lease);
  }
  return withAddressOwnership({ ...opts, source: 'local', production: false }, fn);
}

export async function makeAddressOwnership(opts: OwnershipOptions): Promise<AddressOwnership> {
  return new AddressOwnership(opts, await commonDirectory(opts));
}

/** Signal is available BEFORE the address factory constructs workers/reviewers. */
export function addressChildSignal(): AbortSignal | undefined {
  return childContext.getStore()?.owner.signal;
}

export async function withAddressOwnership<T>(
  opts: OwnershipOptions & { source: string; production: boolean },
  fn: (lease: AddressLease) => Promise<T>,
): Promise<T> {
  const child = childContext.getStore();
  if (child) {
    if (!opts.production || child.consumed || opts.source !== `pr:${child.selection.pr}`)
      throw new Error('address ownership: invalid production child permit');
    child.consumed = true;
    if ((await commonDirectory(opts)) !== child.owner.commonDir)
      throw new Error('address ownership: invalid production child identity');
    await child.owner.assertOwned();
    const lease = child.owner.lease(child);
    return terminalInternals.get(child.owner)!.participant(lease, () => fn(lease));
  }
  const owner = await makeAddressOwnership(opts);
  return owner.withLock(async () => {
    const lease = owner.lease();
    return terminalInternals.get(owner)!.participant(lease, () => fn(lease));
  });
}

export async function validateAddressTerminalAuthority(
  token: object,
): Promise<{ commonDir: string; terminal: boolean }> {
  const owner = terminalAuthorities.get(token);
  if (!owner) throw new Error('address terminal: forged authority');
  return terminalInternals.get(owner)!.validate();
}
export function trackAddressTerminalProcess(token: object, promise: Promise<void>): void {
  const owner = terminalAuthorities.get(token);
  if (!owner) throw new Error('address terminal: forged process authority');
  terminalInternals.get(owner)!.track(promise);
}
export async function bindAddressTerminalReport(
  lease: AddressLease,
  report: ReviewAddressReport,
): Promise<void> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: forged report lease');
  await terminalInternals.get(owner)!.bindReport(lease, report);
}
export function addressTerminalWorkerBinding(lease: AddressLease): object {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: forged worker lease');
  return terminalInternals.get(owner)!.workerBinding(lease);
}
export function recordAddressTerminalAttempt(
  binding: object,
  input: AddressTerminalAttemptInput,
): Promise<object> {
  const association = terminalWorkers.get(binding);
  if (!association) throw new Error('address terminal: forged worker association');
  return terminalInternals.get(association.owner)!.record(association.participant, input);
}
export function deferAddressTerminalAttempt(binding: object, attempt: object): boolean {
  const association = terminalWorkers.get(binding);
  if (!association) throw new Error('address terminal: forged worker association');
  return terminalInternals.get(association.owner)!.defer(association.participant, attempt);
}
export function addressCancelledResult(lease: AddressLease): Promise<ReviewAddressResult> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: forged cancellation lease');
  return terminalInternals.get(owner)!.cancelledResult(lease);
}

export function noteAddressOpaqueInvocation(lease: AddressLease): void {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: forged opaque invocation lease');
  terminalInternals.get(owner)!.opaque(lease);
}
