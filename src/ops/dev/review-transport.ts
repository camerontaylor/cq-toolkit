// Dev lane — the `dev.review` author-admission transport (merged from the
// worker-transport PR, #332): the operator-configured SSH identity that
// carries one enrollment/status/fallback request to the author side and
// returns the signed decision, or the indeterminate verdict when delivery
// is unknown. This module owns the ADAPTER only; `review.ts`'s
// `makeDevReview` is the single registry op that dispatches on `action`
// (`enroll | status | fallback` here, the CodeRabbit review cycle there),
// and the wire schema lives at the registry boundary (`registry.ts`). The
// author-side environment (`CQ_AUTHOR_REPO`, `CQ_AUTHOR_SNAPSHOT_SCANNER`,
// `CQ_AUTHOR_SSH_ALIAS`) resolves once from the dispatch wiring's CqEnv
// snapshot — never the ambient environment at call time — with an explicit
// raw record as the library/test seam and the capture override winning over
// both.
//
// THE TRANSPORT CONTRACT IS UNCHANGED FROM THE MERGED PR: a separate
// operator-configured SSH identity (no command/path supplied by input),
// one request only, no timeout-based local dispatch, no automatic retry,
// no CLI start; bounded 8 KiB responses; private remote stderr never
// reflected. The crq-side invocation (`cq dev.review --action=enroll …`)
// keeps working byte-for-byte.
//
// P5 TREE SNAPSHOTS (apps/crq-python/ops/tree-snapshots.md): `--tree`
// replaces `--head` with a synthetic commit binding tree to base. Only a tree
// `enroll` sends the v2 envelope carrying the scanned object closure; a
// `--head` request and every status/fallback still send the v1 bytes above.
import { captureSnapshot, SnapshotConfigError, snapshotHead } from './internal/snapshot.js';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Op, OpResult } from '../../kernel/types.js';
import { DevTransportInputSchema, type DevTransportInput } from './registry.js';
import { assertCqEnvName } from '../../config/entry.js';
import type { CqEnv } from '../../config/env.js';
import { processEnv } from '../../config/process-env.js';

const DecisionSchema = z
  .object({
    v: z.literal(1),
    request_id: z.string(),
    binding: z
      .object({
        request_id: z.string(),
        base: z.string(),
        head: z.string(),
        target: z.string(),
        cycle: z.number(),
      })
      .strict(),
    issuer: z.enum(['waiting', 'queue', 'agent']),
    reviewer: z.string().nullable(),
    deadline_at: z.string().datetime(),
    decided_at: z.string().datetime().nullable(),
    dispatch: z.boolean(),
  })
  .strict();

export type AuthorDecision = z.infer<typeof DecisionSchema>;
export type AuthorTransport = (request: string) => Promise<string>;

/**
 * The missing-alias message, shared by the registry's admission dispatch and
 * by `makeDevReview` when its deps bind no transport (verbatim from the
 * merged PR's adapter).
 */
export const AUTHOR_TRANSPORT_HINT =
  'Configure CQ_AUTHOR_SSH_ALIAS for the separate author forced-command identity.';

/** Separate operator-configured SSH identity; no command/path supplied by input. */
export function sshAuthorTransport(alias: string): AuthorTransport {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(alias) || alias.trim() !== alias)
    throw new Error('invalid author SSH alias');
  return (request) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        'ssh',
        [
          '-T',
          '-S',
          'none',
          '-o',
          'BatchMode=yes',
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'ConnectTimeout=15',
          '-o',
          'ConnectionAttempts=1',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'RequestTTY=no',
          '--',
          alias,
          'author-v1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      let size = 0;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('author transport timeout; decision unknown'));
      }, 45_000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8192) {
          child.kill('SIGKILL');
          reject(new Error('oversized author response'));
        } else output += chunk.toString('utf8');
      });
      // Drain bounded-memory diagnostics, but never reflect private remote output.
      child.stderr.resume();
      child.stdin.on('error', () => {
        /* close/error supplies the unknown-delivery verdict */
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('author transport unavailable'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error('author transport refused or interrupted; decision unknown'));
      });
      child.stdin.end(request);
    });
}

/** The author-side environment: an entry snapshot, or an explicit raw record. */
export type AuthorEnv = CqEnv | Readonly<Record<string, string | undefined>>;

/** A parsed snapshot (has `values`/`errors`), as opposed to a raw env record. */
function isCqEnv(env: AuthorEnv): env is CqEnv {
  const candidate = env as Partial<CqEnv>;
  return (
    typeof candidate.values === 'object' &&
    candidate.values !== null &&
    Array.isArray(candidate.errors)
  );
}

/**
 * Resolve the author-side repo path and snapshot scanner from the entry
 * snapshot (or an explicit raw record), never the ambient environment at
 * call time. Raw-record injection stays a first-class seam (tests, library
 * callers); the snapshot branch additionally asserts the registry names
 * before reading, so an invalid or denied key can never fall through to the
 * built-in default.
 */
export function resolveAuthorEnv(env: AuthorEnv): {
  repo: string | undefined;
  scanner: string | undefined;
} {
  if (isCqEnv(env)) {
    assertCqEnvName(env, 'dev.review', 'CQ_AUTHOR_REPO');
    assertCqEnvName(env, 'dev.review', 'CQ_AUTHOR_SNAPSHOT_SCANNER');
    const repo = env.values['CQ_AUTHOR_REPO'];
    const scanner = env.values['CQ_AUTHOR_SNAPSHOT_SCANNER'];
    return {
      repo: typeof repo === 'string' ? repo : undefined,
      scanner: typeof scanner === 'string' ? scanner : undefined,
    };
  }
  const repo = env['CQ_AUTHOR_REPO'];
  const scanner = env['CQ_AUTHOR_SNAPSHOT_SCANNER'];
  return {
    repo: repo === '' ? undefined : repo,
    scanner: scanner === '' ? undefined : scanner,
  };
}

/** One request only. No timeout-based local dispatch, automatic retry or CLI start. */
export function makeAuthorAdmission(
  transport: AuthorTransport,
  capture?: (base: string, tree: string) => Promise<{ head: string; snapshot: object }>,
  env: AuthorEnv = processEnv(),
): Op<DevTransportInput, AuthorDecision> {
  return async (input) => {
    let i: DevTransportInput;
    let binding: AuthorDecision['binding'];
    let request: string;
    // Everything before transport is local, so a failure here is definitive for this call:
    // it sent nothing. It is no evidence about an earlier call with the same binding.
    try {
      i = DevTransportInputSchema.parse(input);
      const head = i.tree ? snapshotHead(i.base, i.tree) : i.head!;
      binding = { request_id: i.requestId, base: i.base, head, target: i.target, cycle: i.cycle };
      let envelope: object = { v: 1, op: i.action, binding };
      if (i.tree && i.action === 'enroll') {
        const resolved = resolveAuthorEnv(env);
        const doCapture =
          capture ??
          ((base: string, tree: string) =>
            captureSnapshot(resolved.repo ?? process.cwd(), base, tree, resolved.scanner));
        const captured = await doCapture(i.base, i.tree);
        if (captured.head !== head) throw new Error('snapshot identity mismatch');
        envelope = { v: 2, op: i.action, binding, snapshot: captured.snapshot };
      }
      request = JSON.stringify(envelope) + '\n';
    } catch (error) {
      if (error instanceof SnapshotConfigError)
        return {
          status: 'needs-human',
          reason: 'Configure CQ_AUTHOR_SNAPSHOT_SCANNER as an absolute operator scanner path.',
        };
      return {
        status: 'failed',
        error:
          'Not sent: invalid input, or snapshot capture or pre-upload scan refused. This call sent nothing to the author.',
      };
    }
    try {
      const raw = await transport(request);
      if (Buffer.byteLength(raw) > 8192) throw new Error('oversized author response');
      const decision = DecisionSchema.parse(JSON.parse(raw));
      if (
        decision.request_id !== binding.request_id ||
        Object.entries(binding).some(
          ([key, value]) => decision.binding[key as keyof typeof binding] !== value,
        )
      )
        throw new Error('author response binding mismatch');
      if (
        decision.dispatch &&
        (i.action !== 'fallback' ||
          decision.issuer !== 'agent' ||
          !decision.reviewer ||
          !decision.decided_at)
      )
        throw new Error('invalid fallback permission');
      if (decision.issuer !== 'agent' && decision.reviewer !== null)
        throw new Error('invalid reviewer assignment');
      return { status: 'ok', value: decision };
    } catch {
      return {
        status: 'indeterminate',
        detail:
          'Author admission unknown or refused; no local review or fallback is authorized. Query the same request binding; never mint a replacement on timeout.',
      };
    }
  };
}

/**
 * The registry dispatch's admission binding: the operator-configured SSH
 * identity names the author-side forced command (verbatim messages kept
 * from the merged PR's registry adapter — a missing alias is a
 * needs-human configuration gap, an invalid alias a configuration fault).
 * The alias resolves from the dispatch wiring's snapshot (or the explicit
 * record); the ambient environment is the default only.
 */
export function envAuthorAdmission(
  input: DevTransportInput,
  env: AuthorEnv = processEnv(),
): Promise<OpResult<AuthorDecision> | { status: 'needs-human'; reason: string }> {
  if (isCqEnv(env)) {
    assertCqEnvName(env, 'dev.review', 'CQ_AUTHOR_SSH_ALIAS');
  }
  const alias = isCqEnv(env) ? env.values['CQ_AUTHOR_SSH_ALIAS'] : env['CQ_AUTHOR_SSH_ALIAS'];
  if (typeof alias !== 'string' || alias === '')
    return Promise.resolve({ status: 'needs-human', reason: AUTHOR_TRANSPORT_HINT });
  try {
    return makeAuthorAdmission(sshAuthorTransport(alias), undefined, env)(input);
  } catch {
    return Promise.resolve({
      status: 'needs-human',
      reason: 'Invalid author transport configuration.',
    });
  }
}
