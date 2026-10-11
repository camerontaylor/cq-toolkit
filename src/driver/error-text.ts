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
// URL redaction is VALUE-based and env-independent. Owner ruling (b) replaced
// the two URL regexes (and their 4000-char scan cap) with the single-pass
// scanner below: ONE forward index over the WHOLE diagnostic, constant work
// per code unit, no backtracking, no substring retry and no URL parsing. It
// records the source spans that must become `[redacted]`, then copies the
// untouched slices verbatim; a credential-free URL is left byte-for-byte.
//
// What the scanner recognizes. A candidate starts at a text boundary before
// an ASCII `scheme:` or a literal `//`; only whitespace/EOF ends it, so
// quotes, apostrophes, angle brackets and other punctuation INSIDE it are
// ordinary characters (swallowing closing prose punctuation on a redacted URL
// is preferable to leaking a credential suffix). A raw `@` in the authority
// or in an opaque body marks the candidate sensitive — no length limit and no
// required host — so a long contiguous tunnel/DSN token, an opaque JDBC form
// (`jdbc:oracle:thin:scott/tiger@//db`), a scheme-less `//user:pass@host` and
// the slashless/single-slash special forms all scrub whole. Parameter names
// are percent-decoded exactly once (`+` decodes to a boundary) and classified
// by whole ASCII-alphanumeric runs against the secret-key list, so
// `access_token`, `%74oken`, `api-key` and `x.token` match while `monkey`,
// `sessionid`, `keyword` and `xtoken` do not; commitment needs a raw `=`, and
// a malformed percent escape fails closed. Values are never classified, so
// `?sort=key` survives. The authority/path split keeps a credential-free URL
// whose only `@` sits in the path untouched.
//
// A raw newline can split userinfo before redaction runs, so the scanner also
// runs a bounded WRAP probe: when an authority ends at its FIRST whitespace no
// more than 200 code units after the authority began, the probe watches for a
// later eligible `@` — admitting whitespace, ending at `/`, `?`, `#`, a
// special-scheme `\`, EOF or the 200-code-unit window — and on a hit redacts
// from the original URL start through the token end. The probe keeps watching
// after that tail closes, so a later eligible `@` in the same window merges
// into the SAME span: the pinned `user:\npass@host` and the greedy last-`@`
// case both scrub whole, while a stray `@` 300 code units away cannot drag a
// credential-free block in. Contiguous authority userinfo needs no probe: it
// is unbounded.
//
// Two sideways shapes are covered beside the main candidate: a slash run at the
// authority start (`///user:pass@host`) stays in the authority rather than
// opening a path, and a NESTED `scheme://` or `//` credential URL inside a path
// segment or a parameter VALUE is tracked alongside the outer candidate — a raw
// `@` in that nested authority marks the whole outer candidate sensitive, so
// `?target=https://user:pass@host` scrubs entire (over-redaction of the outer
// prefix is the accepted direction).
//
// The env-value pass below is unchanged: env-NAME driven, exact-value and
// whole-token, and it runs on the full text after the scanner.
const MAX_ERROR_CHARS = 500;

// `_URL` is deliberately absent from the suffix list (owner decision,
// issue #291 row 6b): a plain URL value is not a secret. URLs that DO carry
// credentials are scrubbed from text by VALUE (the scanner above), regardless
// of which env name holds them; the config resolver's credential-URL screen
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

const REDACTION_MARKER = '[redacted]';

// Secret-looking parameter-name words, matched case-insensitively as whole
// ASCII-alphanumeric runs of the percent-decoded name: `access_token`,
// `api-key`, `%74oken` and `x.token` match; `monkey`, `sessionid`, `keyword`
// and `xtoken` do not. The longest entry sets the run buffer bound, and a run
// that outgrows it can never match, so an overflow flag replaces the buffer.
const SECRET_KEY_WORDS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'apikey',
  'accesskey',
  'auth',
  'credential',
  'credentials',
  'signature',
  'sig',
  'sign',
  'jwt',
  'session',
  'key',
]);
const MAX_SECRET_KEY_CHARS = 11; // 'credentials'

// Special schemes accept any run of `/` or `\` between the colon and the
// authority (`https://`, `https:/`, `https:user:pass@host`, `https:\\host`).
// Anything longer than the longest special scheme is never special.
const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);
const MAX_SCHEME_CHARS = 6;

// The wrapped-authority window, in code units, measured from the authority
// start to the authority's first whitespace/EOF. Deliberately NOT a cap on
// contiguous authority userinfo, which is unbounded.
const WRAP_AUTHORITY_CHARS = 200;

type UriState =
  | 'text'
  | 'scheme'
  | 'slash1'
  | 'prefix'
  | 'auth'
  | 'path'
  | 'opaque'
  | 'query'
  | 'fragment';

type ParameterState = 'off' | 'name' | 'value';

/** Nested-URL substate, tracked only inside PATH/QUERY/FRAGMENT. */
type InnerState = 'none' | 'slash' | 'scheme' | 'auth';

interface WrapProbe {
  /** Original URL start; a hit redacts from here. */
  readonly start: number;
  /** Authority start, the origin of the 200-code-unit window. */
  readonly authority: number;
  readonly special: boolean;
  /** Set on an eligible `@`: the span now runs to the next whitespace/EOF. */
  readonly tail: boolean;
}

/** ASCII letter test on a UTF-16 code unit; `-1` (EOF) is not a letter. */
function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code);
}

/** `[A-Za-z0-9+.-]` — the scheme character set (`-`/`.`/`+` included). */
function isSchemeCharacter(code: number): boolean {
  return isAsciiAlphanumeric(code) || code === 0x2b || code === 0x2d || code === 0x2e;
}

// ECMAScript WhiteSpace plus LineTerminator, as individual code units.
const URL_WHITESPACE_CODES = new Set([
  0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

// Code units that may CONTINUE a token (so no candidate may start after them):
// ASCII alphanumerics plus `_`, `+`, `-`, `.`, `@`, `/`, `%` and `\`.
const TOKEN_CONTINUATION_CODES = new Set([0x5f, 0x2b, 0x2d, 0x2e, 0x40, 0x2f, 0x25, 0x5c]);

/** ECMAScript whitespace (EOF is signalled as `-1` and handled by callers). */
function isUrlWhitespace(code: number): boolean {
  return URL_WHITESPACE_CODES.has(code);
}

/** Whether the character at `code` may CONTINUE the token being scanned. */
function continuesToken(code: number): boolean {
  return isAsciiAlphanumeric(code) || TOKEN_CONTINUATION_CODES.has(code);
}

/** Hex digit value, or `-1` when the code unit is not a hex digit. */
function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  return -1;
}

/**
 * The source spans covered by credential-bearing URL candidates.
 *
 * One forward pass with a single index; each code unit advances the main state
 * machine and, at most, a fixed set of wrap probes whose authority starts lie
 * in the trailing WRAP_AUTHORITY_CHARS code units. Spans are pushed in
 * non-decreasing end order, so a newly closed span lies either strictly after
 * the newest recorded span or overlaps it — coalescing is a pop-while-overlap
 * loop, not a sort. No regex, no `new URL`, no input-sized search.
 */
function scanCredentialSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const length = text.length;
  let probes: WrapProbe[] = [];

  let state: UriState = 'text';
  let candidateStart = 0;
  let authorityStart = 0;
  let authorityEmpty = false;
  let special = false;
  let sensitive = false;
  let scheme = '';
  let schemeOverflow = false;
  let prefixSlashes = 0;

  let parameter: ParameterState = 'off';
  let nameRun = '';
  let nameRunOverflow = false;
  let nameMatched = false;
  let nameUncertain = false;
  let escapeActive = false;
  let escapeDigits = 0;
  let escapeValue = 0;

  let inner: InnerState = 'none';
  let innerScheme = '';
  let innerSchemeOverflow = false;
  let innerAuthEmpty = false;

  const clearName = (): void => {
    parameter = 'off';
    nameRun = '';
    nameRunOverflow = false;
    nameMatched = false;
    nameUncertain = false;
    escapeActive = false;
    escapeDigits = 0;
    escapeValue = 0;
  };

  const startName = (): void => {
    clearName();
    parameter = 'name';
  };

  /** Close the current alphanumeric run; a whole-word match is remembered. */
  const closeNameRun = (): void => {
    if (!nameRunOverflow && nameRun.length > 0 && SECRET_KEY_WORDS.has(nameRun)) nameMatched = true;
    nameRun = '';
    nameRunOverflow = false;
  };

  /** Feed one decoded name code unit (an octet from `%HH`, or a literal). */
  const noteDecoded = (code: number): void => {
    if (isAsciiAlphanumeric(code)) {
      if (nameRunOverflow || nameRun.length >= MAX_SECRET_KEY_CHARS) nameRunOverflow = true;
      else nameRun += String.fromCharCode(code).toLowerCase();
      return;
    }
    closeNameRun();
  };

  /** Feed one raw name code unit; percent escapes decode exactly once. */
  const noteNameCharacter = (code: number): void => {
    if (escapeActive) {
      const digit = hexValue(code);
      if (digit < 0) {
        // The escape can never resolve: remember uncertainty and re-handle
        // this code unit as an ordinary name character.
        nameUncertain = true;
        escapeActive = false;
        noteNameCharacter(code);
        return;
      }
      escapeValue = escapeValue * 16 + digit;
      escapeDigits += 1;
      if (escapeDigits === 2) {
        escapeActive = false;
        noteDecoded(escapeValue);
      }
      return;
    }
    if (code === 0x25) {
      // `%`
      escapeActive = true;
      escapeDigits = 0;
      escapeValue = 0;
      return;
    }
    if (code === 0x3d) {
      // `=` commits the name: a listed word, or a malformed escape, is enough.
      closeNameRun();
      if (nameMatched || nameUncertain) sensitive = true;
      parameter = 'value';
      nameMatched = false;
      nameUncertain = false;
      return;
    }
    noteDecoded(code);
  };

  const noteParameterCharacter = (code: number): void => {
    if (parameter === 'name') noteNameCharacter(code);
  };

  const resetInner = (): void => {
    inner = 'none';
    innerScheme = '';
    innerSchemeOverflow = false;
    innerAuthEmpty = false;
  };

  /**
   * Nested-URL tracking, active only in PATH/QUERY/FRAGMENT: a `scheme://` or
   * `//` credential URL inside a path segment or a parameter VALUE must still
   * redact. A raw `@` in the nested authority marks the OUTER candidate
   * sensitive, so the whole outer candidate redacts (over-redaction of the
   * outer prefix is the accepted direction). A slash run at the nested
   * authority start is skipped like the outer machine's, and transitions back
   * to `none` re-handle the code unit. The single-slash and slashless nested
   * forms are deliberately not tracked: the outer machine covers those forms
   * when the URL is the candidate itself.
   */
  const trackInner = (index: number, code: number): void => {
    if (inner === 'auth') {
      // A slash run at the NESTED authority start (`///user:pass@host`,
      // `scheme:///user@host`) is skipped exactly like the outer machine's, so
      // the credential is not dropped at the first slash.
      if (innerAuthEmpty && code === 0x2f) return;
      innerAuthEmpty = false;
      if (code === 0x40) {
        // `@`
        sensitive = true;
        return;
      }
      if (code !== 0x2f && code !== 0x3f && code !== 0x23) return;
      inner = 'none';
    }
    if (inner === 'slash') {
      if (code === 0x2f) {
        inner = 'auth';
        innerAuthEmpty = true;
        return;
      }
      inner = 'none';
    }
    if (inner === 'scheme') {
      if (isSchemeCharacter(code)) {
        if (innerSchemeOverflow || innerScheme.length >= MAX_SCHEME_CHARS)
          innerSchemeOverflow = true;
        else innerScheme += String.fromCharCode(code).toLowerCase();
        return;
      }
      if (code === 0x3a && !innerSchemeOverflow) {
        // `:` — the nested authority follows.
        inner = 'auth';
        innerAuthEmpty = true;
        return;
      }
      inner = 'none';
    }
    const previous = index === 0 ? -1 : text.charCodeAt(index - 1);
    if (continuesToken(previous)) return;
    if (code === 0x2f) {
      inner = 'slash';
      return;
    }
    if (isAsciiLetter(code)) {
      inner = 'scheme';
      innerScheme = String.fromCharCode(code).toLowerCase();
      innerSchemeOverflow = false;
    }
  };

  /**
   * Record a span, coalescing any overlaps. The finalisation-order invariant
   * above means the merged predecessor is always the newest recorded span (and
   * its own predecessors, while the union keeps growing backwards).
   */
  const pushSpan = (start: number, end: number): void => {
    let from = start;
    let to = end;
    while (spans.length > 0) {
      const last = spans[spans.length - 1]!;
      if (last[1] < from) break;
      from = Math.min(from, last[0]);
      to = Math.max(to, last[1]);
      spans.pop();
    }
    spans.push([from, to]);
  };

  const startCandidate = (index: number): void => {
    candidateStart = index;
    sensitive = false;
    clearName();
    resetInner();
  };

  const enterAuthority = (index: number): void => {
    state = 'auth';
    authorityStart = index;
    authorityEmpty = true;
  };

  const advanceAuthority = (code: number): void => {
    // A run of slashes at the authority start (`///user:pass@host`, WHATWG's
    // slash-run form) is still the authority, not a path: skip it while the
    // authority is empty so the credential is not dropped.
    if (authorityEmpty && (code === 0x2f || (special && code === 0x5c))) return;
    authorityEmpty = false;
    if (code === 0x40) {
      // `@` — userinfo, with no length limit and no required host.
      sensitive = true;
      return;
    }
    if (code === 0x2f || (special && code === 0x5c)) {
      // `/`, or a special scheme's `\`
      state = 'path';
      return;
    }
    if (code === 0x3f) {
      // `?`
      state = 'query';
      startName();
      return;
    }
    if (code === 0x23) {
      // `#`
      state = 'fragment';
      startName();
      return;
    }
    if (code === 0x3b) {
      // `;` delimits a parameter name anywhere in a candidate.
      startName();
      return;
    }
    noteParameterCharacter(code);
  };

  const advanceOpaque = (code: number): void => {
    if (code === 0x40) {
      // `/` is ordinary here, so an opaque body's `@` is the credential hint.
      sensitive = true;
      return;
    }
    if (code === 0x3f) {
      state = 'query';
      startName();
      return;
    }
    if (code === 0x23) {
      state = 'fragment';
      startName();
      return;
    }
    if (code === 0x3a || code === 0x26 || code === 0x3b) {
      // `:` `&` `;` delimit parameter names in an opaque body.
      startName();
      return;
    }
    noteParameterCharacter(code);
  };

  const advancePath = (index: number, code: number): void => {
    trackInner(index, code);
    if (code === 0x3f) {
      state = 'query';
      startName();
      return;
    }
    if (code === 0x23) {
      state = 'fragment';
      startName();
      return;
    }
    if (code === 0x3b) {
      startName();
      return;
    }
    noteParameterCharacter(code);
  };

  const advanceQueryOrFragment = (index: number, code: number): void => {
    trackInner(index, code);
    if (code === 0x23) {
      // `#` starts (or restarts, in a fragment) the parameter list.
      state = 'fragment';
      startName();
      return;
    }
    if (code === 0x26 || code === 0x3b) {
      // `&` `;`
      startName();
      return;
    }
    noteParameterCharacter(code);
  };

  /** A candidate ends only at whitespace/EOF; sensitive spans cover it whole. */
  const finishCandidate = (end: number, whitespaceEnded: boolean): void => {
    const endedInAuthority = state === 'auth';
    const authority = authorityStart;
    const probeSpecial = special;
    const start = candidateStart;
    const credential = sensitive;
    state = 'text';
    sensitive = false;
    clearName();
    resetInner();
    if (credential) pushSpan(start, end);
    if (endedInAuthority && whitespaceEnded && end - authority <= WRAP_AUTHORITY_CHARS) {
      probes.push({ start, authority, special: probeSpecial, tail: false });
    }
  };

  const advanceProbes = (index: number, code: number, atEof: boolean): void => {
    const kept: WrapProbe[] = [];
    for (const probe of probes) {
      if (probe.tail) {
        // An activated tail runs to the next whitespace/EOF, punctuation and
        // arbitrarily long, even after eligibility expires.
        if (atEof) {
          pushSpan(probe.start, index);
          continue;
        }
        if (isUrlWhitespace(code)) {
          // Close this hit, but keep probing: a later eligible `@` extends the
          // same merged span, which is the last-`@` behavior the wrap tier had.
          pushSpan(probe.start, index);
          kept.push({ ...probe, tail: false });
          continue;
        }
        kept.push(probe);
        continue;
      }
      if (atEof || index - probe.authority > WRAP_AUTHORITY_CHARS) continue;
      if (code === 0x2f || code === 0x3f || code === 0x23 || (probe.special && code === 0x5c))
        continue;
      kept.push(code === 0x40 ? { ...probe, tail: true } : probe);
    }
    probes = kept;
  };

  const advanceMain = (index: number, code: number): void => {
    if (isUrlWhitespace(code)) {
      if (state !== 'text') finishCandidate(index, true);
      return;
    }
    if (state === 'text') {
      const previous = index === 0 ? -1 : text.charCodeAt(index - 1);
      if (continuesToken(previous)) return;
      if (isAsciiLetter(code)) {
        startCandidate(index);
        state = 'scheme';
        scheme = String.fromCharCode(code).toLowerCase();
        schemeOverflow = false;
        return;
      }
      if (code === 0x2f) {
        startCandidate(index);
        state = 'slash1';
      }
      return;
    }
    if (state === 'scheme') {
      if (code === 0x3a) {
        special = !schemeOverflow && SPECIAL_SCHEMES.has(scheme);
        state = 'prefix';
        prefixSlashes = 0;
        return;
      }
      if (isSchemeCharacter(code)) {
        if (schemeOverflow || scheme.length >= MAX_SCHEME_CHARS) schemeOverflow = true;
        else scheme += String.fromCharCode(code).toLowerCase();
        return;
      }
      // Not a scheme: this code unit is re-handled from TEXT (no rewind).
      state = 'text';
      advanceMain(index, code);
      return;
    }
    if (state === 'slash1') {
      if (code === 0x2f) {
        enterAuthority(index + 1);
        return;
      }
      state = 'text';
      advanceMain(index, code);
      return;
    }
    if (state === 'prefix') {
      if (special) {
        if (code === 0x2f || code === 0x5c) return;
        enterAuthority(index);
        advanceAuthority(code);
        return;
      }
      if (code === 0x2f) {
        prefixSlashes += 1;
        if (prefixSlashes >= 2) enterAuthority(index + 1);
        return;
      }
      state = 'opaque';
      startName();
      advanceOpaque(code);
      return;
    }
    if (state === 'auth') advanceAuthority(code);
    else if (state === 'path') advancePath(index, code);
    else if (state === 'opaque') advanceOpaque(code);
    else advanceQueryOrFragment(index, code);
  };

  for (let i = 0; i <= length; i += 1) {
    const atEof = i === length;
    const code = atEof ? -1 : text.charCodeAt(i);
    if (probes.length > 0) advanceProbes(i, code, atEof);
    if (atEof) {
      if (state !== 'text') finishCandidate(length, false);
    } else {
      advanceMain(i, code);
    }
  }
  return spans;
}

/** Replace every span with the marker, copying the untouched slices verbatim. */
function applyRedactionSpans(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
): string {
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    parts.push(text.slice(cursor, start), REDACTION_MARKER);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/** The caught cause as plain message text (never a vendor class name). */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Redact environment secrets and credential-bearing URL values from text. */
export function redactSensitiveText(text: string): string {
  // Value-based first: a credential-bearing URL is scrubbed wherever it
  // appears, even when no env name classified it as a secret. The scanner
  // reads the FULL text (no scan cap); the env-secret exact-value pass below
  // still runs after it.
  let out = applyRedactionSpans(text, scanCredentialSpans(text));
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
  // Whole-span scanning removes an entire credential URL (plus a whitespace-free
  // tail), which can leave the redacted text SHORT while the raw diagnostic is
  // long; keep the truncation marker whenever either side outgrows the bound.
  return text.length <= MAX_ERROR_CHARS && out.length <= MAX_ERROR_CHARS
    ? out
    : `${out.slice(0, MAX_ERROR_CHARS)}… [truncated]`;
}
