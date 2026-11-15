/**
 * The error classes every deploy module shares.
 *
 * Python has one `Refused`, one `FailStop(Refused)`, one `OSError` and so on; the
 * TypeScript ports each declared their own copy, so `instanceof` was false across
 * modules and the run-body binding had to re-wrap errors by name. One declaration
 * each restores Python's identity. Modules re-export what they used to declare.
 */

/** Python `Refused`: a precondition failed. */
export class Refused extends Error {
  override readonly name: string = 'Refused';
}
/** A refusal that must keep the hold: recovery is an owner operation. */
export class FailStop extends Refused {
  override readonly name = 'FailStop';
}
/** A health check failed after the switch: roll back, do not fail-stop. */
export class HealthFailed extends Refused {
  override readonly name = 'HealthFailed';
}
/** Python `OSError`: what an injected read throws when the filesystem refuses. */
export class OSError extends Error {
  override readonly name = 'OSError';
}
/** Python `ValueError` (includes `json.JSONDecodeError`). */
export class ValueError extends Error {
  override readonly name = 'ValueError';
}
/** A Python exception the real code would let escape (`KeyError`, `TypeError`, ...). */
export class PythonError extends Error {
  constructor(
    override readonly name: string,
    message: string,
  ) {
    super(message);
  }
}
/** Python `KeyboardInterrupt`: not an `Exception`, so recovery handlers pass it through. */
export class Interrupted extends Error {
  override readonly name = 'Interrupted';
}
/** The host could not be returned to a verified state; the hold is retained. */
export class RecoveryRequired extends Error {
  override readonly name = 'RecoveryRequired';
  readonly record: Record<string, unknown>;
  constructor(message: string, record?: Record<string, unknown>) {
    super(message);
    this.record = record !== undefined && Object.keys(record).length > 0 ? record : {};
  }
}

/** Trigger states that mean "stopped". */
export const DEAD_STATES: readonly string[] = ['inactive', 'failed'];
