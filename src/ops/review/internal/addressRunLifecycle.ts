import type { ReviewAddressResult, ReviewAddressReport } from '../address.js';
import type { AddressTerminalAttempt, AddressTerminalAttemptInput } from './addressEvidence.js';
/** Minimal capability surface; checkout registry and durable claims stay with the owner. */
export interface AddressRunLease {
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
}
type Identity = { ino: number; dev: number };
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
export function createAddressRunContext(owner: AddressRunAuthority, internals: TerminalInternals) {
  const token = Object.freeze({});
  if (terminalInternals.has(owner)) throw new Error('address terminal: reused run authority');
  terminalInternals.set(owner, internals);
  return Object.freeze({
    token,
    activate() {
      terminalAuthorities.set(token, owner);
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
