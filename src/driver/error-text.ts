// Diagnostic text for WorkerResult.error — plain, bounded, secret-redacted.
//
// A driver failure cause is PERSISTED (WorkerResult.error; the eval runner
// journals it), so it must be plain bounded text: a full model output or an
// environment secret echoed by a vendor SDK must never land in a persisted
// record verbatim. describeError keeps the MESSAGE only — a vendor class
// name (NoOutputGeneratedError, …) is SDK vocabulary in persisted data (I10);
// each driver already prefixes its own lane-specific context.
const MAX_ERROR_CHARS = 500;
const SECRET_ENV_SUFFIXES = ['_API_KEY', '_TOKEN', '_AUTH_TOKEN', '_SECRET'];

/** The caught cause as plain message text (never a vendor class name). */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bound a diagnostic string and redact any environment secret value it echoes. */
export function boundedErrorText(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      value.length >= 8 &&
      SECRET_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix))
    ) {
      out = out.split(value).join('[redacted]');
    }
  }
  return out.length <= MAX_ERROR_CHARS ? out : `${out.slice(0, MAX_ERROR_CHARS)}… [truncated]`;
}
