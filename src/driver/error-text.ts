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
//
// URL redaction is VALUE-based and env-independent: any scheme://userinfo@
// occurrence in the text carries embedded credentials and is scrubbed whole,
// so a driver echoing a request or endpoint URL cannot persist its userinfo
// (issue #291 review). A raw newline can split the userinfo before redaction
// runs, so the userinfo span admits whitespace; a contiguous span is
// unbounded (a long token must not escape), while the wrapped span is
// bounded so a stray `@` paragraphs later cannot drag a large block into one
// match — scrubbing too much near the URL is the acceptable direction. A
// credential-free URL — including one whose only `@` sits in the path — is
// untouched.
const MAX_ERROR_CHARS = 500;
// `_URL` is deliberately absent from the suffix list (owner decision,
// issue #291 row 6b): a plain URL value is not a secret. URLs that DO carry
// credentials are scrubbed from text by VALUE (below), regardless of which
// env name holds them; the config resolver's credential-URL screen
// additionally refuses such values at the passthrough boundary.
const SECRET_ENV_SUFFIXES = [
  '_API_KEY',
  '_TOKEN',
  '_AUTH_TOKEN',
  '_SECRET',
  '_KEY',
  '_PASSWORD',
  '_CREDENTIALS',
  'PRIVATE_KEY',
];
// A URL whose userinfo is present (user[:password]@ before the first `/`)
// embeds a credential in the value itself. Two tiers: a CONTIGUOUS userinfo
// span (no whitespace) is unbounded — a long tunnel/DSN token must not
// escape the scrub, and a contiguous run cannot swallow unrelated text (it
// stops at the first whitespace or the `@`). A WRAPPED span (userinfo
// containing whitespace, e.g. split across a raw newline) is capped at 200
// chars purely as the anti-swallow bound for pathological cross-line
// content — a real wrapped URL is short, and a >200-char userinfo with
// newlines inside is pathological; that residual risk is accepted here. The
// span excludes `/`, so a credential-free URL whose only `@` sits in the
// path does not match. Greedy resolution picks the LAST `@` within reach, so
// an `@` inside a wrapped password cannot leave a credential fragment
// behind.
const CREDENTIAL_URL_PATTERN =
  /[a-z][a-z0-9+.-]*:\/\/(?:[^\s/<>"'`]+|[^/<>"'`]{0,200})@[^\s<>"'`]*/gi;

/** The caught cause as plain message text (never a vendor class name). */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Redact environment secrets and credential-bearing URL values from text. */
export function redactSensitiveText(text: string): string {
  // Value-based first: a credential-bearing URL is scrubbed wherever it
  // appears, even when no env name classified it as a secret.
  let out = text.replace(CREDENTIAL_URL_PATTERN, '[redacted]');
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      value.length >= 4 &&
      SECRET_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix))
    ) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'),
        '[redacted]',
      );
    }
  }
  return out;
}

/** Bound a diagnostic string and redact environment secrets before persistence. */
export function boundedErrorText(text: string): string {
  const out = redactSensitiveText(text);
  return out.length <= MAX_ERROR_CHARS ? out : `${out.slice(0, MAX_ERROR_CHARS)}… [truncated]`;
}
