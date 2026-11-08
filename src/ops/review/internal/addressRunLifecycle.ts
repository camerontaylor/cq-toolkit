import type { AddressLease } from './addressOwnership.js';
import type { ReviewAddressResult, ReviewAddressReport } from '../address.js';
import {
  recordAddressTerminalEvidence,
  releaseAddressTerminalEvidence,
  settleAddressTerminalEvidence,
  persistAddressTerminalReport,
  type AddressTerminalAttempt,
  type AddressTerminalAttemptInput,
} from './addressEvidence.js';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
const same = (a: Identity, b: Identity) => a.ino === b.ino && a.dev === b.dev;
type Identity = { ino: number; dev: number };
/** Identity boundary shared by store-backed and future checkout-lock lifetimes. */
export interface AddressRunAuthority {
  readonly commonDir: string;
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
}
export const liveLeases = new WeakMap<AddressLease, AddressRunAuthority>();
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
export const terminalInternals = new WeakMap<AddressRunAuthority, TerminalInternals>();
export const terminalAuthorities = new WeakMap<object, AddressRunAuthority>();
export const terminalWorkers = new WeakMap<
  object,
  { owner: AddressRunAuthority; participant: Participant }
>();
export const participantLeases = new WeakMap<AddressLease, Participant>();
export interface Participant {
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

/** In-memory writer and terminal lifetime; contains no durable ownership protocol. */
export abstract class AddressRunLifecycle implements AddressRunAuthority {
  abstract readonly commonDir: string;
  abstract assertOwned(): Promise<void>;
  protected abstract assertIdentity(): Promise<void>;
  readonly signal: AbortSignal;
  protected readonly controller: AbortController;
  protected readonly tasks = new Set<Promise<unknown>>();
  protected readonly retentionAdvisories: string[] = [];
  protected readonly terminalToken = Object.freeze({});
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

  protected async participant<T>(lease: AddressLease, action: () => Promise<T>): Promise<T> {
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

  protected async bindReport(lease: AddressLease, report: ReviewAddressReport): Promise<void> {
    const participant = participantLeases.get(lease);
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

  protected noteOpaqueInvocation(lease: AddressLease): void {
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

  protected workerBinding(lease: AddressLease): object {
    const participant = participantLeases.get(lease);
    if (!participant || participant.closed || !this.participants.has(participant))
      throw new Error('address terminal: worker association refused');
    const binding = Object.freeze({});
    terminalWorkers.set(binding, { owner: this, participant });
    return binding;
  }

  protected async recordAttempt(
    participant: Participant,
    input: AddressTerminalAttemptInput,
  ): Promise<object> {
    if (participant.closed || this.stopping)
      throw new Error('address terminal: attempt after close');
    await this.assertOwned();
    const attempt = await recordAddressTerminalEvidence(this.terminalToken, input);
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

  protected async cancelledResult(lease: AddressLease): Promise<ReviewAddressResult> {
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
  lease: AddressLease,
  root: string,
  entries: ReadonlyMap<string, string>,
): Promise<void> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: invalid bookkeeping lease');
  return terminalInternals.get(owner)!.bookkeeping(root, entries);
}
export function addressOrdinaryReport(
  lease: AddressLease,
  path: string,
  bytes: string,
): Promise<void> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address terminal: invalid report lease');
  return terminalInternals.get(owner)!.ordinaryReport(path, bytes);
}
