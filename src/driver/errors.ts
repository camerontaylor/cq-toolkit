// Dispatch error classes — seam v2 (ADR-0002 §2.2). Pre-dispatch throws
// (the only throws the seam allows) carry a class too, so consumers map a
// throw to a status from structured data instead of parsing message text.
// No kernel import: this file belongs to the driver family.

/** Class of a pre-dispatch dispatch failure. */
export type DispatchErrorClass =
  /** Bad binding inputs: a missing/bad path, a workspace/session realpath mismatch, an unknown role. */
  | 'config'
  /** Credentials rejected before any dispatch (the driver never reached the provider). */
  | 'auth';

/**
 * A pre-dispatch throw carrying its class as structured data. Thrown by
 * drivers and pass-through wrappers before any worker dispatch; the class is
 * read back with {@link errorClassOf}.
 */
export class DispatchError extends Error {
  /** The dispatch failure class, for {@link errorClassOf} to extract. */
  readonly dispatchClass: DispatchErrorClass;

  constructor(dispatchClass: DispatchErrorClass, message: string) {
    super(message);
    this.name = 'DispatchError';
    this.dispatchClass = dispatchClass;
  }
}

/**
 * Extracts the dispatch class from a thrown value: a {@link DispatchError},
 * or a plain object tagged with the same `dispatchClass` field. Returns
 * `undefined` for anything untagged or carrying an unrecognized value — a
 * class is never guessed from message text.
 */
export function errorClassOf(err: unknown): DispatchErrorClass | undefined {
  if (err instanceof DispatchError) return err.dispatchClass;
  if (typeof err === 'object' && err !== null && 'dispatchClass' in err) {
    const tagged: unknown = (err as { dispatchClass?: unknown }).dispatchClass;
    if (tagged === 'config' || tagged === 'auth') return tagged;
  }
  return undefined;
}
