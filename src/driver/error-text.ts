// Diagnostic text for WorkerResult.error — plain, bounded, secret-redacted.
//
// A driver failure cause is PERSISTED (WorkerResult.error; the eval runner
// journals it), so it must be plain bounded text: a full model output or an
// environment secret echoed by a vendor SDK must never land in a persisted
// record verbatim. describeError keeps the MESSAGE only — a vendor class
// name (NoOutputGeneratedError, …) is SDK vocabulary in persisted data (I10);
// each driver already prefixes its own lane-specific context.
//
// Redaction is WHOLE-TOKEN: the value floor is short (4 chars), so a bare
// substring replace would shred unrelated words that merely contain the
// value — a match is bounded by non-identifier characters instead.
import { isSecretEnvName } from '../config/secret.js';
import { isUrlEnvName, redactUrlUserinfo, showUrl } from '../shared/urlRedact.js';

const MAX_ERROR_CHARS = 500;

/** The caught cause as plain message text (never a vendor class name). */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Redact the VALUES of secret-classed environment variables (and strip the
 * credentials of URL-named ones) from text. No generic URL scanning: callers
 * that run their own URL pass (the attempt-record sanitizer) use this.
 */
export function redactEnvSecrets(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    // Environment names are case-insensitive (win32) or may simply be spelled
    // in lowercase by an operator; classify case-folded so `metrics_url`
    // cannot dodge the redaction.
    const classified = name.toUpperCase();
    if (value === undefined || value.length < 4) continue;
    // `_URL` is not a secret suffix: a URL value is shown with userinfo, query
    // and fragment stripped (the one shared redactor); a clean URL is left as is.
    const secret = isSecretEnvName(classified);
    const shown = !secret && isUrlEnvName(classified) ? showUrl(value) : undefined;
    if (secret || (shown !== undefined && shown !== value)) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'),
        () => shown ?? '[redacted]',
      );
    }
  }
  return out;
}

/** Redact environment secrets and credential-bearing URL values from text. */
export function redactSensitiveText(text: string): string {
  // Every URL in the text loses its userinfo, query and fragment, with or
  // without an environment value to match (the one shared scanner,
  // src/shared/urlRedact.ts).
  return redactUrlUserinfo(redactEnvSecrets(text));
}

/** Bound a diagnostic string and redact environment secrets before persistence. */
export function boundedErrorText(text: string): string {
  const out = redactSensitiveText(text);
  return out.length <= MAX_ERROR_CHARS ? out : `${out.slice(0, MAX_ERROR_CHARS)}… [truncated]`;
}
