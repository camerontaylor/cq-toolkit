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
  /** `IsADirectoryError`, an `OSError` subclass (`read_text` on a directory). */
  | 'IsADirectoryError'
  /** `UnicodeEncodeError`, a `ValueError` subclass (`write_text` of a lone surrogate). */
  | 'UnicodeEncodeError'
  /** `json.JSONDecodeError`, a `ValueError` subclass (`json.loads` of malformed text). */
  | 'JSONDecodeError'
  /** `UnicodeDecodeError`, a `ValueError` subclass (`read_text` of non-UTF-8 bytes). */
  | 'UnicodeDecodeError'
  /** `FileNotFoundError`, an `OSError` subclass (`subprocess` with a missing executable). */
  | 'FileNotFoundError'
  /** `subprocess.TimeoutExpired`, a `SubprocessError` (not an `OSError` or `RuntimeError`). */
  | 'TimeoutExpired'
  | 'RuntimeError'
  | 'AttributeError'
  /** `subprocess.CalledProcessError` (`subprocess.run(check=True)` on a non-zero exit). */
  | 'CalledProcessError'
  /** `crq_repair.retain.UnsupportedUntracked`, a `ValueError` subclass. */
  | 'UnsupportedUntracked'
  /** `review_ledger.IntegrityError`, a `ValueError` subclass. */
  | 'IntegrityError'
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

/** `isinstance(exc, <kind>)`: `DetectorUnavailable` is a `ValueError`, `FileNotFoundError` an `OSError`. */
export function isPyError(e: unknown, ...kinds: readonly PyErrorKind[]): e is PyError {
  if (!(e instanceof PyError)) return false;
  return kinds.some(
    (kind) =>
      kind === e.kind ||
      (kind === 'ValueError' &&
        (e.kind === 'DetectorUnavailable' ||
          e.kind === 'UnsupportedUntracked' ||
          e.kind === 'IntegrityError' ||
          e.kind === 'UnicodeEncodeError' ||
          e.kind === 'JSONDecodeError' ||
          e.kind === 'UnicodeDecodeError')) ||
      (kind === 'OSError' && (e.kind === 'FileNotFoundError' || e.kind === 'IsADirectoryError')),
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

/** The `OSError` Python raises for a failed `open(path)`, with its errno wording. */
export function pyOsError(e: unknown, path: string): PyError {
  const code = (e as { code?: string } | null)?.code;
  const q = `'${path}'`;
  if (code === 'ENOENT')
    return new PyError('FileNotFoundError', `[Errno 2] No such file or directory: ${q}`);
  if (code === 'EISDIR') return new PyError('IsADirectoryError', `[Errno 21] Is a directory: ${q}`);
  if (code === 'EACCES') return new PyError('OSError', `[Errno 13] Permission denied: ${q}`);
  return new PyError('OSError', e instanceof Error ? e.message : String(e));
}
