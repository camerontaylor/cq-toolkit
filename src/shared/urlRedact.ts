// Shared URL handling: showUrl for structured values, redactUrlUserinfo for
// free-text display, stripCredentialText for strict persisted observations,
// and urlValueRefused for fail-closed child-environment acceptance. All URL
// scanning stays in this module (test/config/url-redactor.test.ts pins it).

/** An authority start found in a whitespace-free run: where its scheme begins and where its authority does. */
interface SchemeHit {
  start: number;
  authority: number;
}

const SPECIAL_SCHEME_TAIL = /(?:https?|wss?|ftp)$/;
const isSlash = (ch: string | undefined): boolean => ch === '/' || ch === '\\';

/**
 * ONE scheme scanner for both modes. Strict (default): `scheme://` at a word
 * start. Lenient (diagnostic text): also `scheme:` + any run of `/` or `\\`
 * (JSON-escaped and WHATWG separators), the fixed-length special schemes
 * (http, https, ws, wss, ftp) with no slashes at all even glued to preceding
 * text, and a bare scheme-relative `//`. Single forward pass, constant work per
 * character (the special-scheme test looks at a bounded tail).
 */
function discoverSchemes(run: string, lenient: boolean): SchemeHit[] {
  const hits: SchemeHit[] = [];
  let wordStart = 0;
  for (let j = 0; j < run.length; j++) {
    const ch = run[j] ?? '';
    if (ch === ':') {
      let k = 0;
      while (isSlash(run[j + 1 + k])) k++;
      if (!lenient) {
        if (
          run[j + 1] === '/' &&
          run[j + 2] === '/' &&
          j > wordStart &&
          /[a-z]/i.test(run[wordStart] ?? '')
        ) {
          hits.push({ start: wordStart, authority: j + 3 });
          j += 2;
          wordStart = j + 1;
          continue;
        }
      } else {
        const tail = run.slice(Math.max(wordStart, j - 5), j).toLowerCase();
        const special = SPECIAL_SCHEME_TAIL.test(tail);
        const generic = k >= 2 && j > wordStart && /[a-z]/i.test(run[wordStart] ?? '');
        if (special || generic) {
          hits.push({ start: wordStart, authority: j + 1 + k });
          j += k;
          wordStart = j + 1;
          continue;
        }
      }
    }
    if (
      lenient &&
      isSlash(ch) &&
      isSlash(run[j + 1]) &&
      (j === 0 || !/[a-z0-9+.:-]/i.test(run[j - 1] ?? ''))
    ) {
      let k = 0;
      while (isSlash(run[j + k])) k++;
      hits.push({ start: j, authority: j + k });
      j += k - 1;
      wordStart = j + 1;
      continue;
    }
    if (!/[a-z0-9+.-]/i.test(ch)) wordStart = j + 1;
  }
  return hits;
}

/** Keep nested scheme-like text inside its enclosing authority or query. */
function independentTextUrls(run: string, hits: readonly SchemeHit[]): SchemeHit[] {
  const independent: SchemeHit[] = [];
  let scan = 0;
  let inAuthority = false;
  let inQuery = false;
  for (const hit of hits) {
    while (scan < hit.start) {
      const ch = run[scan] ?? '';
      if ('/\\?#'.includes(ch)) inAuthority = false;
      if (ch === '?' || ch === '#') inQuery = true;
      scan++;
    }
    // Whitespace already separates runs. Inside one run, a hit outside the
    // enclosing authority and query starts a new URL: a scheme in a password or
    // a query parameter is data, never an independent URL, while one nested in
    // a path (e.g. `https://archive.test/web/https://u:p@host/`) must still be
    // redacted on its own.
    if (independent.length === 0 || (!inAuthority && !inQuery)) {
      independent.push(hit);
      scan = hit.authority;
      inAuthority = true;
      inQuery = false;
    }
  }
  return independent;
}

/**
 * The FREE-TEXT form: wherever a URL authority appears in text, drop its
 * userinfo (`https://u:p@host/x` becomes `https://[redacted]@host/x`) and its
 * query and fragment (`?q=1#f` becomes `?[redacted]`); the path, other text,
 * bare `name@host` prose and package specs are untouched. Same scanner as {@link stripCredentialText}
 * (lenient mode); the authority ends at the first `/`, `\\`, `?` or `#`, and
 * the userinfo is cut at its LAST `@`. Linear in the text length.
 */
export function redactUrlUserinfo(text: string): string {
  const out: string[] = [];
  const closers: string[] = [];
  let proseBackslashes = 0;
  // Track delimiters across prose and whitespace, not just beside the scheme.
  const rememberProse = (fragment: string): void => {
    for (const ch of fragment) {
      if (ch === '\\') {
        proseBackslashes++;
        continue;
      }
      const escaped = proseBackslashes % 2 !== 0;
      proseBackslashes = 0;
      if (escaped) continue;
      const top = closers.at(-1);
      if (top === '"' || top === "'") {
        if (ch === top) closers.pop();
      } else if (ch === top) {
        closers.pop();
      } else {
        const close =
          ch === '(' ? ')' : ch === '[' ? ']' : ch === '{' ? '}' : ch === '<' ? '>' : ch;
        if ('\"\'([{<'.includes(ch)) closers.push(close);
      }
    }
  };
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i] ?? '')) {
      out.push(text[i] ?? '');
      rememberProse(text[i] ?? '');
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && !/\s/.test(text[i] ?? '')) i++;
    const run = text.slice(start, i);
    const hits = independentTextUrls(run, discoverSchemes(run, true));
    let cursor = 0;
    for (let k = 0; k < hits.length; k++) {
      const hit = hits[k];
      if (hit === undefined) continue;
      const limit = hits[k + 1]?.start ?? run.length;
      const token = run.slice(hit.authority, limit);
      let authorityEnd = 0;
      while (authorityEnd < token.length && !'/\\?#'.includes(token[authorityEnd] ?? ''))
        authorityEnd++;
      const at = token.lastIndexOf('@', authorityEnd - 1);
      // Everything from the first `?` or `#` after the authority is a query or
      // fragment: drop it and mark the cut (the authority is known, so this is
      // not guesswork about prose).
      let q = authorityEnd;
      while (q < token.length && token[q] !== '?' && token[q] !== '#') q++;
      const authorityAndPath = token.slice(0, q);
      const shown = at < 0 ? authorityAndPath : `[redacted]${authorityAndPath.slice(at)}`;
      rememberProse(run.slice(cursor, hit.start));
      out.push(run.slice(cursor, hit.authority));
      let queryEnd = token.length;
      if (q < token.length) {
        // Preserve only terminal prose punctuation when no matching opener exists.
        while (queryEnd > q + 1 && ',.\"\')>]}'.includes(token[queryEnd - 1] ?? '')) {
          const end = queryEnd - 1;
          let backslashes = 0;
          for (let b = end - 1; b >= 0 && token[b] === '\\'; b--) backslashes++;
          if (backslashes % 2 !== 0) break;
          queryEnd--;
        }
        // Use the nearest unmatched opener to choose its closing delimiter,
        // but only inside the terminal punctuation suffix. A quote inside a
        // query value must not expose the remaining query as prose.
        const closer = closers.at(-1);
        for (let j = queryEnd; closer !== undefined && j < token.length; j++) {
          if (token[j] === closer) {
            queryEnd = j;
            break;
          }
        }
        rememberProse(token.slice(queryEnd));
      } else {
        // A query-free URL can close the prose delimiter before a later URL.
        let tail = token.length;
        while (tail > 0 && '\"\')>]}'.includes(token[tail - 1] ?? '')) tail--;
        while (tail > 0 && token[tail - 1] === '\\') tail--;
        rememberProse(token.slice(tail));
      }
      out.push(q < token.length ? `${shown}${token[q]}[redacted]${token.slice(queryEnd)}` : shown);
      cursor = limit;
    }
    out.push(run.slice(cursor));
    rememberProse(run.slice(cursor));
  }
  return out.join('');
}

/**
 * Strip URL userinfo/query/fragment and SCP-style (or bare email-like)
 * `user[:secret]@host` prefixes from a text fragment.
 *
 * Deliberate over-matching: a bare `name@host` in free text (an email
 * address, or a package spec like `vitest@5.0.0` that happens to end in a
 * colon-terminated token, `@types/node@22`, `@scope/pkg@1.2.3`, or
 * `image@sha256:…`) is also stripped, because a credential prefix is
 * indistinguishable from these without scheme context and the sanitizer fails
 * closed. Credential leakage is worse than a mangled spec string.
 */
export function stripCredentialText(text: string): string {
  const chunks: string[] = [];
  // Free-text runs deliberately fail closed even for a dangling @ or an
  // unusual host initial. Keep only opening boundary punctuation and the tail.
  const freeText = (run: string): string => {
    const at = run.lastIndexOf('@');
    if (at < 0) return run;
    let prefix = 0;
    while (prefix < at && '\'"([{=,;'.includes(run[prefix] ?? '')) prefix++;
    return run.slice(0, prefix) + run.slice(at + 1);
  };
  // Backslash runs before distinct quotes are disjoint, so counting their
  // parity keeps the scanner linear and works for both quote delimiters.
  const closesQuery = (run: string, index: number, terminator: string): boolean => {
    if (terminator === '' || run[index] !== terminator) return false;
    if (terminator !== "'" && terminator !== '"') return true;
    let backslashes = 0;
    for (let j = index - 1; j >= 0 && run[j] === '\\'; j--) backslashes++;
    return backslashes % 2 === 0;
  };
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i] ?? '')) {
      chunks.push(text[i] ?? '');
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && !/\s/.test(text[i] ?? '')) i++;
    const run = text.slice(start, i);
    let next = i;
    while (next < text.length && /\s/.test(text[next] ?? '')) next++;
    const nextStart = next;
    while (next < text.length && !/\s/.test(text[next] ?? '')) next++;
    const newlineCredential =
      text.slice(i, nextStart).includes('\n') && text.slice(nextStart, next).includes('@');
    // Discover all schemes in one forward pass. Never search the remaining
    // suffix again for each URL (many adjacent URLs must also stay linear).
    const schemes = discoverSchemes(run, false);
    let cursor = 0;
    let droppingQuery = false;
    let terminator = '';
    for (let k = 0; k < schemes.length; k++) {
      const scheme = schemes[k];
      if (scheme === undefined) continue;
      const limit = schemes[k + 1]?.start ?? run.length;
      if (droppingQuery) {
        let close = scheme.start;
        while (close < limit && !closesQuery(run, close, terminator)) close++;
        if (close < limit) {
          chunks.push(freeText(run.slice(close, limit)));
          droppingQuery = false;
        }
        cursor = limit;
        continue;
      }
      chunks.push(freeText(run.slice(cursor, scheme.start)));
      const opener = run[scheme.start - 1];
      terminator = opener === "'" || opener === '"' ? opener : opener === '<' ? '>' : '';
      const token = run.slice(scheme.authority, limit);
      let authorityEnd = 0;
      while (authorityEnd < token.length && !'/?#'.includes(token[authorityEnd] ?? ''))
        authorityEnd++;
      let end = authorityEnd;
      while (end < token.length && !'?#'.includes(token[end] ?? '')) end++;
      let tailEnd = end;
      if (end < token.length) {
        tailEnd++;
        while (tailEnd < token.length && !closesQuery(run, scheme.authority + tailEnd, terminator))
          tailEnd++;
      }
      const at = token.lastIndexOf('@', end - 1);
      const authority = token.slice(0, authorityEnd);
      const hostPort = /^(\[[^\]]*\]|[^:@]+):\d+$/.test(authority);
      const incomplete =
        at < 0 &&
        !hostPort &&
        ((authority.includes(':') && !/^\[[^\]]*\]$/.test(authority)) ||
          (newlineCredential && authorityEnd === token.length));
      chunks.push(run.slice(scheme.start, scheme.authority));
      chunks.push(incomplete ? '' : token.slice(at >= 0 ? at + 1 : 0, end));
      chunks.push(freeText(token.slice(tailEnd)));
      droppingQuery = end < token.length && tailEnd === token.length;
      cursor = limit;
    }
    if (schemes.length === 0) {
      // A newline can split user:token before @. Drop the first half too.
      // Multi-character credential fragments are ambiguous; short k:v prose,
      // paths and numeric stack-frame segments remain intact.
      const parts = run.split(':');
      const credentialShape =
        run.endsWith(':') ||
        (!run.includes('/') &&
          parts.length >= 2 &&
          parts.every((part) => part.length >= 2 && !/^\d+$/.test(part)));
      const nextRun = text.slice(nextStart, next);
      const nextAt = nextRun.indexOf('@');
      const splitUsername =
        !nextRun.slice(0, nextAt).includes('://') &&
        /^[a-z][a-z0-9_-]*$/i.test(run) &&
        nextAt >= 0 &&
        nextRun.slice(0, nextAt).includes(':');
      const splitCredential = newlineCredential && (credentialShape || splitUsername);
      chunks.push(splitCredential ? '' : freeText(run));
    }
  }
  // Scheme-less queries are not stripped: prose ? and # must survive.
  return chunks.join('');
}

/** True for an env NAME that holds a URL by convention (`*_URL`, case-insensitive). */
export function isUrlEnvName(name: string): boolean {
  return name.toUpperCase().endsWith('_URL');
}

/**
 * Fail-closed ACCEPTANCE rule for a URL-valued variable that would be copied
 * into a child. The value passes only if ALL hold: it has no `@` anywhere (raw
 * or `%40`, either case), no whitespace and no backslash, and the whole value
 * parses with WHATWG `new URL()` with an empty username and password. Anything
 * else is refused. (An `@` in a path is rare enough in env URLs to refuse.)
 */
function urlValueAcceptable(value: string): boolean {
  if (/[@\s\\]/.test(value) || /%40/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * Must a passthrough/declared/trusted/allowlisted VALUE be refused? A `*_URL`
 * variable must satisfy {@link urlValueAcceptable}. Any other variable is
 * screened only when its value carries a `://` separator, and is then refused
 * on any `@` (raw or `%40`). Returns true to refuse; the caller names the
 * VARIABLE only, never the value.
 */
export function urlValueRefused(name: string, value: string): boolean {
  if (isUrlEnvName(name)) return !urlValueAcceptable(value);
  return value.includes('://') && (value.includes('@') || /%40/i.test(value));
}

/**
 * THE canonical display form of a structured URL value (a config value,
 * provenance, `cq config`, a snapshot): `protocol//host/pathname`, with no
 * userinfo, query or fragment. The host comes from the parsed URL, never from a
 * last-`@` cut. A value that does not parse (or has no host) is shown as
 * `[redacted-url]`, never as its raw text.
 */
export function showUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    if (parsed.host === '') return REDACTED_URL;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return REDACTED_URL;
  }
}

const REDACTED_URL = '[redacted-url]';

/**
 * Show a value that may be a URL: the canonical display ({@link showUrl})
 * applies when the NAME says URL or the value carries a scheme separator; any
 * other value is returned as is.
 */
export function redactIfUrl(name: string, value: string): string {
  return isUrlEnvName(name) || value.includes('://') ? showUrl(value) : value;
}

/**
 * Cut the userinfo from the authority of the first anchored `scheme://` in
 * `rest` (the authority ends at whitespace, `?` or `#`; the cut is at its LAST
 * `@`). `schemeMatch` is the caller's match of that scheme. Linear.
 */
export function cutAuthorityUserinfo(rest: string, schemeMatch: RegExpExecArray): string {
  const schemeEnd = schemeMatch.index + schemeMatch[0].length;
  let end = schemeEnd;
  while (end < rest.length) {
    const ch: string | undefined = rest[end];
    if (ch === undefined || /\s/.test(ch) || ch === '?' || ch === '#') break;
    end++;
  }
  const authority = rest.slice(schemeEnd, end);
  const at = authority.lastIndexOf('@');
  return (
    rest.slice(0, schemeEnd) + (at === -1 ? authority : authority.slice(at + 1)) + rest.slice(end)
  );
}
