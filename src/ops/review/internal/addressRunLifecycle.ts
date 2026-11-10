import type { SlotWorktreeRegistry } from '../../../adapters/git/slotWorktreeRegistry.js';
import { boundedFile, same, type Identity } from './addressFileIdentity.js';
import type { ReviewAddressResult, ReviewAddressReport } from '../address.js';
import {
  disposeAddressTerminalSession,
  checkpointAddressTerminalEvidence,
  noteAddressTerminalBookkeeping,
  noteAddressOrdinaryReport,
  removeAddressTerminalCandidate,
  recordAddressTerminalEvidence,
  releaseAddressTerminalEvidence,
  settleAddressTerminalEvidence,
  persistAddressTerminalReport,
  type AddressTerminalAttempt,
  type AddressTerminalAttemptInput,
} from './addressEvidence.js';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
export interface AddressSelection {
  pr: number;
  head: string;
  headRepo: string;
  headRefName: string;
}

export interface AddressLease {
  signal: AbortSignal;
  expectedHead?: string;
  incompleteReason?(): string | undefined;
  registry?: SlotWorktreeRegistry;
  assertOwned(): Promise<void>;
  /** Track actual work even when an outer governor abandons its promise. */
  track<T>(action: () => Promise<T>): Promise<T>;
  /** Called before resolution, including before stale checkout removal. */
  assertSelection(selection: Omit<AddressSelection, 'head'>): Promise<void>;
  /** Confirms canonical checkout and administrative git-dir before driver work. */
  claimCheckout(info: { path: string; branch: string; head: string }): Promise<void>;
}

/** Minimal capability surface; checkout registry and durable claims stay with the owner. */
export interface AddressRunLease {
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
}
/** Identity boundary shared by store-backed and future checkout-lock lifetimes. */
export interface AddressRunAuthority {
  readonly commonDir: string;
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
}
const liveLeases = new WeakMap<AddressRunLease, AddressRunAuthority>();
export interface TerminalInternals {
  participant<T>(lease: AddressRunLease, action: () => Promise<T>): Promise<T>;
  bindReport(lease: AddressRunLease, report: ReviewAddressReport): Promise<void>;
  workerBinding(lease: AddressRunLease): object;
  opaque(lease: AddressRunLease): void;
  cancelledResult(lease: AddressRunLease): Promise<ReviewAddressResult>;
  validate(): Promise<{ commonDir: string; terminal: boolean }>;
  track(promise: Promise<void>): void;
  record(participant: Participant, input: AddressTerminalAttemptInput): Promise<object>;
  defer(participant: Participant, attempt: object): boolean;
  release(participant: Participant, attempt: object): void;
  checkpoint(
    root: string,
    head?: string,
    expected?: { parent: string; tree: string },
  ): Promise<string>;
  bookkeeping(root: string, entries: ReadonlyMap<string, string>): Promise<void>;
  ordinaryReport(path: string, bytes: string): Promise<void>;
  candidate(root: string, path: string, remove: boolean): Promise<void>;
}
const terminalInternals = new WeakMap<AddressRunAuthority, TerminalInternals>();
const runTokens = new WeakMap<AddressRunAuthority, object>();
function terminalToken(owner: AddressRunAuthority): object {
  const token = runTokens.get(owner);
  if (!token) throw new Error('address terminal: unknown run authority');
  return token;
}
const terminalAuthorities = new WeakMap<object, AddressRunAuthority>();
const terminalWorkers = new WeakMap<
  object,
  { owner: AddressRunAuthority; participant: Participant }
>();
const participantLeases = new WeakMap<AddressRunLease, Participant>();
export interface Participant {
  lease: AddressRunLease;
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

/** A fresh context mints its own token; callers cannot install or replace global capabilities. */
function createAddressRunContext(owner: AddressRunAuthority, internals: TerminalInternals) {
  const token = Object.freeze({});
  if (terminalInternals.has(owner)) throw new Error('address terminal: reused run authority');
  terminalInternals.set(owner, internals);
  runTokens.set(owner, token);
  return Object.freeze({
    activate() {
      terminalAuthorities.set(token, owner);
    },
    deactivate() {
      terminalAuthorities.delete(token);
    },
    registerLease(lease: AddressRunLease) {
      if (liveLeases.has(lease)) throw new Error('address terminal: reused lease');
      liveLeases.set(lease, owner);
    },
    participant(lease: AddressRunLease) {
      return liveLeases.get(lease) === owner ? participantLeases.get(lease) : undefined;
    },
    registerParticipant(lease: AddressRunLease, participant: Participant) {
      if (liveLeases.get(lease) !== owner || participantLeases.has(lease))
        throw new Error('address terminal: forged/reused participant');
      participantLeases.set(lease, participant);
    },
    workerBinding(participant: Participant) {
      if (
        participantLeases.get(participant.lease) !== participant ||
        liveLeases.get(participant.lease) !== owner
      )
        throw new Error('address terminal: forged participant');
      const binding = Object.freeze({});
      terminalWorkers.set(binding, { owner, participant });
      return binding;
    },
    runParticipant<T>(lease: AddressRunLease, action: () => Promise<T>): Promise<T> {
      return internals.participant(lease, action);
    },
  });
}

/** Read-only lookup for authentic single-use nested leases. */
export function addressRunLeaseAuthority(lease: AddressRunLease): AddressRunAuthority | undefined {
  return liveLeases.get(lease);
}

/** In-memory writer and terminal lifetime; contains no durable ownership protocol. */
export abstract class AddressRunLifecycle implements AddressRunAuthority {
  abstract readonly commonDir: string;
  abstract assertOwned(): Promise<void>;
  protected abstract assertIdentity(): Promise<void>;
  readonly signal: AbortSignal;
  protected readonly controller: AbortController;
  protected readonly tasks = new Set<Promise<unknown>>();
  protected readonly retentionAdvisories: string[] = [];
  protected readonly runContext: ReturnType<typeof createAddressRunContext>;
  protected readonly participants = new Set<Participant>();
  protected readonly terminalProcesses = new Set<Promise<void>>();
  protected readonly terminalOperations = new Set<Promise<void>>();
  protected stopping = false;
  // Refusal blocks terminal IO, but cannot substitute for the actual-task drain.
  protected terminalAdmissionRefusal?: Error;
  protected terminalFailure?: unknown;
  protected terminalRun?: Promise<void>;

  protected active = false;
  protected admitting = false;
  protected compromised = false;
  protected constructor(opts: { controller?: AbortController; signal?: AbortSignal }) {
    this.controller = opts.controller ?? new AbortController();
    this.signal = opts.signal
      ? AbortSignal.any([opts.signal, this.controller.signal])
      : this.controller.signal;
    const candidates = new Map<
      string,
      { root: string; directory: Identity; entry: Identity; link: string }
    >();
    this.runContext = createAddressRunContext(this, {
      checkpoint: (root, head, expected) =>
        checkpointAddressTerminalEvidence(terminalToken(this), root, head, expected),
      bookkeeping: (root, entries) => this.terminalBookkeeping(root, entries),
      ordinaryReport: (path, bytes) => this.ordinaryReport(path, bytes),
      candidate: async (root, path, remove) => {
        await this.validateTerminal();
        if (!remove) {
          if ((await realpath(path)) !== path) throw new Error('address terminal: candidate alias');
          const entry = await boundedFile(resolve(path, '.git'), 4096, 1);
          candidates.set(path, {
            root,
            directory: await lstat(path),
            entry: entry.identity,
            link: entry.bytes.toString('base64'),
          });
          return;
        }
        const expected = candidates.get(path);
        const entry = await boundedFile(resolve(path, '.git'), 4096, 1);
        if (
          !expected ||
          expected.root !== root ||
          (await realpath(path)) !== path ||
          !same(expected.directory, await lstat(path)) ||
          !same(expected.entry, entry.identity) ||
          expected.link !== entry.bytes.toString('base64')
        )
          throw new Error('address terminal: unknown/replaced candidate');
        await removeAddressTerminalCandidate(terminalToken(this), root, path);
        candidates.delete(path);
      },
      participant: (lease, action) => this.participant(lease, action),
      bindReport: (lease, report) => this.bindReport(lease, report),
      workerBinding: (lease) => this.workerBinding(lease),
      opaque: (lease) => this.noteOpaqueInvocation(lease),
      cancelledResult: (lease) => this.cancelledResult(lease),
      validate: () => this.validateTerminal(),
      track: (promise) => this.registerTerminalProcess(promise),
      record: (participant, input) => this.recordAttempt(participant, input),
      defer: (participant, attempt) => this.deferAttempt(participant, attempt),
      release: (participant, attempt) => {
        if (!this.active || participant.closed || !this.participants.has(participant))
          throw new Error('address terminal: release after close');
        const index = participant.attempts.indexOf(attempt as AddressTerminalAttempt);
        if (index < 0 || participant.attempts[index]!.cancelled)
          throw new Error('address terminal: forged/stale or cancelled release');
        participant.attempts.splice(index, 1);
        releaseAddressTerminalEvidence(attempt);
      },
    });
  }
  protected async ordinaryReport(path: string, bytes: string): Promise<void> {
    await noteAddressOrdinaryReport(terminalToken(this), path, bytes);
  }
  protected async terminalBookkeeping(
    root: string,
    entries: ReadonlyMap<string, string>,
  ): Promise<void> {
    await noteAddressTerminalBookkeeping(terminalToken(this), root, entries);
  }
  protected async disposeTerminalSession(): Promise<void> {
    await disposeAddressTerminalSession(terminalToken(this));
  }

  protected stopAdmissions = () => {
    this.stopping = true;
    this.admitting = false;
  };

  protected async validateTerminal(): Promise<{ commonDir: string; terminal: boolean }> {
    if (!this.active || this.compromised || this.terminalFailure)
      throw new Error('address terminal: owner inactive/compromised');
    this.controller.signal.throwIfAborted();
    await this.assertIdentity();
    this.controller.signal.throwIfAborted();
    return { commonDir: this.commonDir, terminal: this.stopping };
  }

  protected registerTerminalProcess(promise: Promise<void>): void {
    if (!this.active || this.compromised || this.terminalFailure)
      throw new Error('address terminal: process after retirement');
    const set = this.stopping ? this.terminalProcesses : this.tasks;
    set.add(promise);
    void promise.then(
      () => set.delete(promise),
      () => set.delete(promise),
    );
  }

  protected async participant<T>(lease: AddressRunLease, action: () => Promise<T>): Promise<T> {
    if (addressRunLeaseAuthority(lease) !== this || this.runContext.participant(lease))
      throw new Error('address terminal: forged/reused participant');
    const participant: Participant = {
      lease,
      closed: false,
      arrived: false,
      started: Date.now(),
      attempts: [],
      opaqueDispatched: false,
    };
    this.runContext.registerParticipant(lease, participant);
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

  protected async bindReport(lease: AddressRunLease, report: ReviewAddressReport): Promise<void> {
    const participant = this.runContext.participant(lease);
    if (
      !participant ||
      participant.closed ||
      participant.report ||
      !this.participants.has(participant)
    )
      throw new Error('address terminal: report binding refused');
    if (this.retentionAdvisories.length) {
      report.advisories = [...new Set([...(report.advisories ?? []), ...this.retentionAdvisories])];
    }
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

  protected noteOpaqueInvocation(lease: AddressRunLease): void {
    const participant = this.runContext.participant(lease);
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

  protected workerBinding(lease: AddressRunLease): object {
    const participant = this.runContext.participant(lease);
    if (!participant || participant.closed || !this.participants.has(participant))
      throw new Error('address terminal: worker association refused');
    return this.runContext.workerBinding(participant);
  }

  protected async recordAttempt(
    participant: Participant,
    input: AddressTerminalAttemptInput,
  ): Promise<object> {
    if (participant.closed || this.stopping)
      throw new Error('address terminal: attempt after close');
    await this.assertOwned();
    const attempt = await recordAddressTerminalEvidence(terminalToken(this), input);
    try {
      await this.assertOwned();
      if (participant.closed) {
        this.terminalFailure = new Error('address terminal: late attempt on closed participant');
        throw this.terminalFailure;
      }
      participant.attempts.push(attempt);
      return attempt;
    } catch (error) {
      releaseAddressTerminalEvidence(attempt);
      throw error;
    }
  }

  protected deferAttempt(participant: Participant, value: object): boolean {
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
          let parent: string;
          try {
            parent = await realpath(dirname(participant.report.reportPath));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // The journal directory vanished after binding (ordinary parent
            // cancellation timing). End the attempt without a report rather
            // than failing with ENOENT and quarantining the owner.
            continue;
          }
          const target = resolve(parent, basename(participant.report.reportPath));
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
            await settleAddressTerminalEvidence(terminalToken(this), attempts);
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
              if (!participant.reportDirectory) continue;
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
                terminalToken(this),
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

  protected async cancelledResult(lease: AddressRunLease): Promise<ReviewAddressResult> {
    const participant = this.runContext.participant(lease);
    if (!participant?.report || !this.participants.has(participant))
      throw new Error('address terminal: missing report association');
    await this.arrive(participant);
    return {
      status: 'needs-human',
      reason: `parent cancelled; report: ${participant.report.reportPath}`,
      report: participant.report,
    };
  }
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
  lease: AddressRunLease,
  report: ReviewAddressReport,
): Promise<void> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: forged report lease');
  await terminalInternals.get(owner)!.bindReport(lease, report);
}
export function addressTerminalWorkerBinding(lease: AddressRunLease): object {
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
export function releaseAddressTerminalAttempt(binding: object, attempt: object): void {
  const association = terminalWorkers.get(binding);
  if (!association) throw new Error('address terminal: forged worker association');
  terminalInternals.get(association.owner)!.release(association.participant, attempt);
}
export function deferAddressTerminalAttempt(binding: object, attempt: object): boolean {
  const association = terminalWorkers.get(binding);
  if (!association) throw new Error('address terminal: forged worker association');
  return terminalInternals.get(association.owner)!.defer(association.participant, attempt);
}
export function addressCancelledResult(lease: AddressRunLease): Promise<ReviewAddressResult> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: forged cancellation lease');
  return terminalInternals.get(owner)!.cancelledResult(lease);
}

export function noteAddressOpaqueInvocation(lease: AddressRunLease): void {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: forged opaque invocation lease');
  terminalInternals.get(owner)!.opaque(lease);
}

export function checkpointAddressTerminalWorker(
  binding: object,
  root: string,
  head?: string,
  expected?: { parent: string; tree: string },
): Promise<string> {
  const association = terminalWorkers.get(binding);
  if (!association || association.participant.closed)
    throw new Error('address terminal: invalid worker checkpoint');
  return terminalInternals.get(association.owner)!.checkpoint(root, head, expected);
}
export function addressTerminalCandidate(
  binding: object,
  root: string,
  path: string,
  remove: boolean,
): Promise<void> {
  const association = terminalWorkers.get(binding);
  if (!association || association.participant.closed)
    throw new Error('address terminal: forged worker association');
  return terminalInternals.get(association.owner)!.candidate(root, path, remove);
}
export function addressTerminalBookkeeping(
  lease: AddressRunLease,
  root: string,
  entries: ReadonlyMap<string, string>,
): Promise<void> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: invalid bookkeeping lease');
  return terminalInternals.get(owner)!.bookkeeping(root, entries);
}
export function addressOrdinaryReport(
  lease: AddressRunLease,
  path: string,
  bytes: string,
): Promise<void> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: invalid report lease');
  return terminalInternals.get(owner)!.ordinaryReport(path, bytes);
}
