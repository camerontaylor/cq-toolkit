/**
 * Offline check of one `authorized_keys` line for the TypeScript `dispatch`
 * forced command. Pure: it reads no file and touches no host. The operator
 * pastes the line they intend to install; the check reports what is wrong.
 *
 * This is advice for the operator, not a gate: nothing calls it at runtime.
 * It mirrors the line shape in docs/queue-client.md "Operator activation".
 *
 * Two roots, as the Node units already run on ceres: the runner takes its
 * root (`config.json`, `state/`) from the working directory, so the line `cd`s
 * to the deploy root, while `crq.js` comes from the packaged artifact, which
 * holds `dist/` but no config or state. They may be the same directory.
 */

export type DispatchIdentity = 'queue' | 'author';

export interface DispatchLineCheck {
  readonly ok: boolean;
  readonly identity: DispatchIdentity | null;
  readonly problems: readonly string[];
}

const ALLOWED_OPTIONS = new Set(['restrict', 'command', 'from', 'expiry-time']);
const QUEUE_ENV = ['CRQ_QUEUE_PRINCIPAL', 'CRQ_QUEUE_POLICY'] as const;
const AUTHOR_ENV = [
  'CRQ_AUTHOR_REVIEW_POLICY',
  'CRQ_AUTHOR_FALLBACK_REVIEWER',
  'CRQ_AUTHOR_TARGET',
] as const;
/** The roots the line names; both absolute with no trailing slash. */
export interface DispatchRoots {
  /** The `cd` target: holds the runner's `config.json` and `state/`. */
  readonly deployRoot: string;
  /** The packaged artifact holding `dist/queue-runner/crq.js`. */
  readonly artifactRoot: string;
}

/** Shell metacharacters and expansion, including the `&` and `&&` separators. */
const SHELL_META = /[$`;&|<>\n\r(){}*?!#~\\]/;
const KEY_TYPE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)$/;
/**
 * OpenSSH `expiry-time` values: absolute YYYYMMDD[HHMM[SS]] with an optional
 * case-insensitive `Z` or `UTC` suffix. OpenSSH rejects `forever` and relative
 * times here (parse_absolute_time); seconds 60 and 61 pass its strptime.
 */
const EXPIRY_TIME =
  /^\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:(?:[01]\d|2[0-3])[0-5]\d(?:[0-5]\d|6[01])?)?(?:z|utc)?$/i;

/** OpenSSH refuses a time at or before the epoch (negative time_t, or valid_before == 0). */
function isAfterEpoch(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  const date = Number(digits.slice(0, 8));
  return date > 19700101 || (date === 19700101 && Number(digits.slice(8) || '0') > 0);
}

/** Split `a,b="c,d",e` at commas outside double quotes; null when a quote is unbalanced. */
function splitOptions(text: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (char === '\\' && quoted) {
      current += char + (text[i + 1] ?? '');
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  if (quoted) return null;
  parts.push(current);
  return parts;
}

/** Find where the option list ends: the first space outside quotes. */
function optionsEnd(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (char === '\\' && quoted) i += 1;
    else if (char === '"') quoted = !quoted;
    else if (char === ' ' && !quoted) return i;
  }
  return -1;
}

function checkCommand(
  command: string,
  roots: DispatchRoots,
  problems: string[],
): { identity: DispatchIdentity | null } {
  if (/SSH_ORIGINAL_COMMAND/.test(command)) {
    problems.push('command must not reference SSH_ORIGINAL_COMMAND');
  }
  // The one `&&` allowed is the fixed separator inside the prefix; the rest
  // (or the whole command, when the prefix is missing) is checked as written.
  const prefix = `cd ${roots.deployRoot} && /usr/bin/env `;
  const hasPrefix = command.startsWith(prefix);
  const body = hasPrefix ? command.slice(prefix.length) : command;
  if (SHELL_META.test(body)) {
    problems.push('command contains shell metacharacters or expansion (no $SSH_ORIGINAL_COMMAND)');
  }
  // The split below only understands single spaces, so reject shell quoting
  // and every other whitespace first: `A='b C=d'` would otherwise pass as the
  // two assignments `A='b` and `C=d'` that the shell never makes.
  if (/['"]|[^\S ]/.test(body)) {
    problems.push('command must not contain quotes or whitespace other than single spaces');
  }
  if (!hasPrefix) {
    problems.push(
      `command must start with "${prefix}" (the runner reads config.json and state/ from cwd)`,
    );
    return { identity: null };
  }
  const tokens = command.slice(prefix.length).split(' ').filter(Boolean);
  const tail = tokens.splice(-3);
  const [node, script, subcommand] = tail;
  if (!node?.startsWith('/')) problems.push('node must be an absolute path');
  const expectedScript = `${roots.artifactRoot}/dist/queue-runner/crq.js`;
  if (script !== expectedScript) problems.push(`script must be ${expectedScript}`);
  if (subcommand !== 'dispatch') problems.push('the final argument must be exactly "dispatch"');

  const env = new Map<string, string>();
  for (const token of tokens) {
    const eq = token.indexOf('=');
    const name = eq > 0 ? token.slice(0, eq) : '';
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      problems.push(`unexpected token before the node path: ${token}`);
      continue;
    }
    if (env.has(name)) problems.push(`${name} is set twice`);
    env.set(name, token.slice(eq + 1));
  }
  for (const name of env.keys()) {
    if (
      name !== 'PATH' &&
      !(QUEUE_ENV as readonly string[]).includes(name) &&
      !(AUTHOR_ENV as readonly string[]).includes(name)
    ) {
      problems.push(`unexpected environment variable ${name}`);
    }
  }
  const path = env.get('PATH');
  if (!path) problems.push('PATH is required (git, gh and gitleaks must resolve)');
  else if (!path.split(':').every((dir) => dir.startsWith('/'))) {
    problems.push('PATH entries must all be absolute');
  }

  const queue = QUEUE_ENV.filter((name) => env.has(name));
  const author = AUTHOR_ENV.filter((name) => env.has(name));
  let identity: DispatchIdentity | null = null;
  if (queue.length > 0 && author.length > 0) {
    problems.push('a queue identity must not carry CRQ_AUTHOR_* settings (use a separate key)');
  } else if (queue.length > 0) {
    identity = 'queue';
    for (const name of QUEUE_ENV) if (!env.has(name)) problems.push(`${name} is required`);
  } else if (author.length > 0) {
    identity = 'author';
    for (const name of AUTHOR_ENV) if (!env.has(name)) problems.push(`${name} is required`);
  } else
    problems.push(
      'no CRQ_QUEUE_* or CRQ_AUTHOR_* settings: the dispatcher would refuse every request',
    );
  for (const name of ['CRQ_QUEUE_POLICY', 'CRQ_AUTHOR_REVIEW_POLICY']) {
    const value = env.get(name);
    if (value !== undefined && !value.startsWith('/'))
      problems.push(`${name} must be an absolute path`);
  }
  return { identity };
}

/** Check one line against the deploy root (`cd` target) and the artifact root (`crq.js`). */
export function checkDispatchAuthorizedKeysLine(
  line: string,
  roots: DispatchRoots,
): DispatchLineCheck {
  const problems: string[] = [];
  for (const [name, root] of [
    ['deployRoot', roots.deployRoot],
    ['artifactRoot', roots.artifactRoot],
  ] as const) {
    if (!root.startsWith('/') || root.endsWith('/') || /\s/.test(root) || SHELL_META.test(root))
      problems.push(
        `${name} must be absolute with no trailing slash, whitespace or metacharacters`,
      );
  }
  if (/[\n\r]/.test(line.trimEnd())) problems.push('exactly one line expected');
  const text = line.trim();
  const end = optionsEnd(text);
  if (end < 0)
    return { ok: false, identity: null, problems: [...problems, 'no options before the key'] };
  const parts = splitOptions(text.slice(0, end));
  if (!parts)
    return { ok: false, identity: null, problems: [...problems, 'unbalanced quote in options'] };
  const rest = text
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  if (!KEY_TYPE.test(rest[0] ?? '') || !rest[1])
    problems.push('a public key (type and blob) must follow the options');

  let command: string | null = null;
  let commandSeen = false;
  let restrict = false;
  for (const part of parts) {
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (!ALLOWED_OPTIONS.has(name)) {
      problems.push(`option not allowed: ${name}`);
      continue;
    }
    if (name === 'restrict') restrict = true;
    if (name === 'command') {
      // OpenSSH rejects a second `command` clause outright, so such a line
      // can never authenticate even when the final command checks out.
      if (commandSeen) problems.push('at most one command option is allowed');
      commandSeen = true;
      const raw = part.slice(eq + 1);
      if (!/^".*"$/.test(raw)) problems.push('command must be a double-quoted string');
      else command = raw.slice(1, -1);
    }
    // OpenSSH rejects these options unless the value is a quoted string, and it
    // parses the `expiry-time` value, so a bad date would stop the key working.
    if (name === 'from' && !/^".+"$/.test(part.slice(eq + 1)))
      problems.push('from must be a double-quoted pattern list');
    if (name === 'expiry-time') {
      const raw = part.slice(eq + 1);
      if (!/^".*"$/.test(raw)) problems.push('expiry-time must be a double-quoted string');
      else if (!EXPIRY_TIME.test(raw.slice(1, -1)))
        problems.push('expiry-time must be YYYYMMDD[HHMM[SS]] with an optional Z or UTC suffix');
      else if (!isAfterEpoch(raw.slice(1, -1)))
        problems.push('expiry-time must be after 1970-01-01T00:00:00Z (OpenSSH rejects it)');
    }
  }
  if (!restrict) problems.push('restrict is required');
  if (parts[0] !== 'restrict') problems.push('restrict must be the first option');
  if (command === null) {
    problems.push('command="..." is required');
    return { ok: false, identity: null, problems };
  }
  if (command.includes('\\"')) problems.push('command must not contain escaped quotes');
  const { identity } = checkCommand(command, roots, problems);
  return { ok: problems.length === 0, identity, problems };
}
