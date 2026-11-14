/**
 * The dedicated ledger publication transport (`crq.Spool`), realized as the
 * `PushCommit` binding `GitLedger` consumes.
 *
 * Python parity, kept exactly:
 *
 * - Configuration comes from the rollout's `publisher_spool`: `ssh_alias`
 *   (a literal `user@host`, required), `ssh_key` or `key` (required; the
 *   signer runbook calls it `.key`), and an optional directory that this
 *   transport never reads. `legacy_shell` is refused, never ignored.
 * - `-F none`: no ssh_config identities, Match/ProxyCommand or ControlMaster.
 *   A shared master opened with a general key would silently ignore `-i` and
 *   bypass the forced command. `IdentitiesOnly=yes`, `IdentityAgent=none`,
 *   `ControlMaster=no`, `ControlPath=none` pin the dedicated key as the only
 *   authentication candidate.
 * - The remote command is exactly `ledger-publish <base> <head>`; the bundle
 *   bytes are the message body on stdin. Base and head must be full 40-hex
 *   oids and the bundle must be 1..64 MiB.
 * - Any transport defect — spawn failure, non-zero exit, timeout, unreadable
 *   reply, or an acknowledgement that is not `{"published": <head>}` — throws
 *   the caller's retryable transport error text, so the publication outbox is
 *   retained and a fresh fetch reconciles. There is no fallback transport:
 *   a missing key or alias refuses outright.
 *
 * No environment is read here: the key path is resolved by the caller's
 * effects seam (`expanduser` is Python's), the ssh binary is `/usr/bin/ssh`,
 * and the process environment is inherited wholesale exactly as
 * `subprocess.run` does in Python; stdin is the bundle, never a TTY.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { LedgerTransportError } from './ledgerGit.js';
import type { PushCommit } from './ledgerGit.js';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import type { JsonValue } from '../../policy/crq/jsonValue.js';

/** Thrown before any ssh runs when the rollout's spool shape is unusable. */
export class SpoolConfigError extends Error {
  override readonly name = 'SpoolConfigError';
}

const SSH_BINARY = '/usr/bin/ssh';
const SSH_TIMEOUT_MS = 330_000; // Python's publish timeout (330 s).
const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
const OID_40 = /^[0-9a-f]{40}$/;

/** Python's `Spool` alias/host pattern (`re.fullmatch`). */
const HOST_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.:-]*$/;

/** The rollout's `publisher_spool` document, reduced to what ssh needs. */
export interface PublisherSpoolConfig {
  readonly sshAlias: string;
  /** `ssh_key`, or the signer runbook's `key` alias. Never empty. */
  readonly sshKey: string;
}

/**
 * Validate a parsed `publisher_spool` document the way Python's `Spool.__init__`
 * and `runtime.settings` do. Unknown keys (notably `legacy_shell`) refuse; the
 * key must be non-blank with no embedded newline/CR/NUL; the alias must be a
 * literal `user@host`. Returns the normalized config.
 */
export function parsePublisherSpool(value: JsonValue | undefined): PublisherSpoolConfig {
  if (!(value instanceof JsonObject)) {
    throw new SpoolConfigError('backfill rollout publisher_spool incomplete or invalid');
  }
  if (value.has('legacy_shell')) {
    throw new SpoolConfigError(
      'publisher_spool.legacy_shell is not supported: the dedicated forced-command ' +
        'key is the only transport (owner decision D4) — remove it',
    );
  }
  for (const [key] of value.entries) {
    if (key !== 'ssh_alias' && key !== 'ssh_key' && key !== 'key') {
      throw new SpoolConfigError('backfill rollout publisher_spool incomplete or invalid');
    }
  }
  const alias = value.get('ssh_alias');
  if (typeof alias !== 'string' || !HOST_PATTERN.test(alias)) {
    throw new SpoolConfigError(
      `publisher_spool.ssh_alias must be a literal user@host (ssh runs with -F none), got ${JSON.stringify(alias ?? null)}`,
    );
  }
  const key = value.get('ssh_key') ?? value.get('key');
  if (typeof key !== 'string' || key.trim() === '' || /[\n\r\0]/.test(key)) {
    throw new SpoolConfigError('backfill rollout publisher_spool incomplete or invalid');
  }
  return { sshAlias: alias, sshKey: key };
}

interface SshResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** One `/usr/bin/ssh` invocation with the bundle on stdin (no shell). */
function runSsh(
  argv: readonly string[],
  bundle: Uint8Array,
  timeoutMs: number,
): Promise<SshResult> {
  return new Promise((resolve) => {
    const child = spawn(SSH_BINARY, [...argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(bundle);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  });
}

/**
 * The exact ssh argv for one publication. Exported as the reviewed seam: the
 * unit tests pin argv construction (`-F none`, the pinned key options, the
 * literal `ledger-publish <base> <head>` remote command) without spawning a
 * process.
 */
export function publisherSshArgv(
  config: PublisherSpoolConfig,
  keyPath: string,
  base: string,
  head: string,
): string[] {
  return [
    '-F',
    'none',
    '-i',
    keyPath,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=2',
    config.sshAlias,
    `ledger-publish ${base} ${head}`,
  ];
}

/**
 * The signer reply gate: exactly `{"published": <head>}` (modulo surrounding
 * whitespace) is accepted; unreadable JSON and any other acknowledgement are
 * transport defects, matching Python's `publish_ledger` acceptance.
 */
export function parseSignerReply(reply: string, head: string): void {
  let acknowledgement: unknown;
  try {
    acknowledgement = JSON.parse(reply) as unknown;
  } catch {
    throw new LedgerTransportError('signer reply unreadable; retain publication outbox');
  }
  const exact =
    typeof acknowledgement === 'object' &&
    acknowledgement !== null &&
    !Array.isArray(acknowledgement) &&
    Object.keys(acknowledgement).length === 1 &&
    (acknowledgement as Record<string, unknown>)['published'] === head;
  if (!exact) {
    throw new LedgerTransportError('signer did not acknowledge the exact ledger commit');
  }
}

/**
 * Build the `PushCommit` for the rollout's spool config. The key path is
 * `~`-expanded (Python's `os.path.expanduser`) against the process home.
 */
export function publisherSpoolPushCommit(config: PublisherSpoolConfig): PushCommit {
  return async (base: string, head: string, bundle: Uint8Array): Promise<void> => {
    if (!HOST_PATTERN.test(config.sshAlias) || !OID_40.test(base) || !OID_40.test(head)) {
      throw new LedgerTransportError('ledger publication requires the dedicated signer transport');
    }
    if (bundle.length === 0 || bundle.length > BUNDLE_MAX_BYTES) {
      throw new LedgerTransportError('invalid ledger bundle size');
    }
    const rawKey = config.sshKey;
    const expanded =
      rawKey === '~'
        ? homedir()
        : rawKey.startsWith('~/')
          ? `${homedir()}${rawKey.slice(1)}`
          : rawKey;
    // A missing signer key must refuse before ssh runs: OpenSSH ignores an
    // inaccessible -i file and still offers default identities (~/.ssh/*),
    // which could authorize the spool host with a general-purpose key
    // (owner D4: no fallback). Python's expanduser would produce a nonexistent
    // path and ssh would then fail unreachable; refusing here is the same
    // outcome without ever offering a default identity.
    let keyPath: string;
    try {
      keyPath = await realpath(expanded);
    } catch {
      throw new LedgerTransportError('ledger signer key unavailable; retain publication outbox');
    }
    const argv = publisherSshArgv(config, keyPath, base, head);
    const result = await runSsh(argv, bundle, SSH_TIMEOUT_MS);
    if (result.code !== 0) {
      // Python maps reachability defects to an OSError("signer transport
      // unavailable; retain publication outbox"); the diagnostic is clipped,
      // not the class boundary.
      throw new LedgerTransportError(
        'ledger signer transport unavailable; retain publication outbox',
      );
    }
    parseSignerReply(result.stdout.toString('utf8'), head);
  };
}
