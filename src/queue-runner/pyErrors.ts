/**
 * The Python exception classes `repair_tick.harvest` branches on. Python
 * catches by class (`except (ValueError, IndexError, KeyError, TypeError)`,
 * `except DetectorUnavailable: raise` ahead of `except ValueError`), so an
 * injected effect that mirrors a Python raise throws a `PyError` carrying the
 * class name; anything else is an unclassified failure and propagates.
 */
export type PyErrorKind =
  | 'ValueError'
  | 'KeyError'
  | 'TypeError'
  | 'IndexError'
  | 'OSError'
  | 'RuntimeError'
  /** `crq_repair.DetectorUnavailable`, a `ValueError` subclass. */
  | 'DetectorUnavailable';

export class PyError extends Error {
  constructor(
    readonly kind: PyErrorKind,
    /** `str(exc)`. */
    message: string,
  ) {
    super(message);
    this.name = kind;
  }
}

/** `isinstance(exc, <kind>)`: `DetectorUnavailable` is a `ValueError`. */
export function isPyError(e: unknown, ...kinds: readonly PyErrorKind[]): e is PyError {
  if (!(e instanceof PyError)) return false;
  return kinds.some(
    (kind) => kind === e.kind || (kind === 'ValueError' && e.kind === 'DetectorUnavailable'),
  );
}

/** `str(exc)`: a `KeyError` already carries its repr'd key as the message. */
export function excText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `str(exc)[:300]`, sliced by code point as Python does. */
export function clip300(text: string): string {
  const points = Array.from(text);
  return points.length <= 300 ? text : points.slice(0, 300).join('');
}
