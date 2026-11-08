import type { AddressLease } from './addressOwnership.js';
import type { ReviewAddressResult, ReviewAddressReport } from '../address.js';
import type { AddressTerminalAttempt, AddressTerminalAttemptInput } from './addressEvidence.js';
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
