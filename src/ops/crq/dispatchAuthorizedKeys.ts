/**
 * Offline check of one `authorized_keys` line for the TypeScript `dispatch`
 * forced command. Pure: it reads no file and touches no host. The operator
 * pastes the line they intend to install; the check reports what is wrong.
 *
 * This is advice for the operator, not a gate: nothing calls it at runtime.
 * It mirrors the line shape in docs/queue-client.md "Operator activation".
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
const KEY_TYPE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)$/;

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
  root: string,
  problems: string[],
): { identity: DispatchIdentity | null } {
  if (/[$`;|<>\n\r(){}*?!#~\\]/.test(command.replace(/&&/g, ''))) {
    problems.push('command contains shell metacharacters or expansion (no $SSH_ORIGINAL_COMMAND)');
  }
  if (/SSH_ORIGINAL_COMMAND/.test(command)) {
    problems.push('command must not reference SSH_ORIGINAL_COMMAND');
  }
  const prefix = `cd ${root} && /usr/bin/env `;
  if (!command.startsWith(prefix)) {
    problems.push(`command must start with "${prefix}" (the runner reads its root from cwd)`);
    return { identity: null };
  }
  const tokens = command.slice(prefix.length).split(' ').filter(Boolean);
  const tail = tokens.splice(-3);
  const [node, script, subcommand] = tail;
  if (!node?.startsWith('/')) problems.push('node must be an absolute path');
  if (script !== `${root}/dist/queue-runner/crq.js`) {
    problems.push(`script must be ${root}/dist/queue-runner/crq.js`);
  }
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

/** Check one line; `root` is the deployed runner root (absolute, no trailing slash). */
export function checkDispatchAuthorizedKeysLine(line: string, root: string): DispatchLineCheck {
  const problems: string[] = [];
  if (!root.startsWith('/') || root.endsWith('/'))
    problems.push('root must be absolute with no trailing slash');
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
      const raw = part.slice(eq + 1);
      if (!/^".*"$/.test(raw)) problems.push('command must be a double-quoted string');
      else command = raw.slice(1, -1);
    }
  }
  if (!restrict) problems.push('restrict is required');
  if (parts[0] !== 'restrict') problems.push('restrict must be the first option');
  if (command === null) {
    problems.push('command="..." is required');
    return { ok: false, identity: null, problems };
  }
  if (command.includes('\\"')) problems.push('command must not contain escaped quotes');
  const { identity } = checkCommand(command, root, problems);
  return { ok: problems.length === 0, identity, problems };
}
