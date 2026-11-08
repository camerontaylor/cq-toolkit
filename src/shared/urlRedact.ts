// The ONE URL-value redactor. Every place that shows or records a URL-valued
// config/env value (cq config text and --json, v3 provenance, diagnostics,
// attempt records, persisted error text) calls `stripCredentialText`; there is
// no second implementation (test/config/url-redactor.test.ts scans for it).
// It is a linear, ReDoS-safe procedural scan (no backtracking regex over
// attacker-controlled text). `urlValueHasUserinfo` is the matching detector
// used to REFUSE (not redact) a credential-bearing URL in passthrough.

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
    const schemes: Array<{ start: number; authority: number }> = [];
    let wordStart = 0;
    for (let j = 0; j < run.length; j++) {
      const ch = run[j] ?? '';
      if (
        ch === ':' &&
        run[j + 1] === '/' &&
        run[j + 2] === '/' &&
        j > wordStart &&
        /[a-z]/i.test(run[wordStart] ?? '')
      ) {
        schemes.push({ start: wordStart, authority: j + 3 });
        j += 2;
        wordStart = j + 1;
      } else if (!/[a-z0-9+.-]/i.test(ch)) {
        wordStart = j + 1;
      }
    }
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
 * Does this URL-ish value carry credentials before the host (`user@host`,
 * `user:pass@host`)? Fails closed: any `@` in the authority part counts, even
 * when the value does not parse as a URL. An `@` only in the path, query or
 * fragment does not. A scheme-less value is its own authority up to the first
 * `/`, `?` or `#`. Linear time.
 */
export function urlValueHasUserinfo(value: string): boolean {
  const trimmed = value.trim();
  const scheme = trimmed.indexOf('://');
  let start = 0;
  if (scheme >= 0) start = scheme + 3;
  else if (trimmed.startsWith('//')) start = 2;
  let end = start;
  while (end < trimmed.length && !'/?#'.includes(trimmed[end] ?? '')) end++;
  return trimmed.slice(start, end).includes('@');
}

/**
 * Show a value that may be a URL: the redactor applies when the NAME says URL
 * or the value carries a scheme separator; any other value is returned as is.
 */
export function redactIfUrl(name: string, value: string): string {
  return isUrlEnvName(name) || value.includes('://') ? stripCredentialText(value) : value;
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
