// Dev lane — the `dev.review` author-admission transport (merged from the
// worker-transport PR, #332): the operator-configured SSH identity that
// carries one enrollment/status/fallback request to the author side and
// returns the signed decision, or the indeterminate verdict when delivery
// is unknown. This module owns the ADAPTER only; `review.ts`'s
// `makeDevReview` is the single registry op that dispatches on `action`
// (`enroll | status | fallback` here, the CodeRabbit review cycle there),
// and the wire schema lives at the registry boundary (`registry.ts`).
//
// THE TRANSPORT CONTRACT IS UNCHANGED FROM THE MERGED PR: a separate
// operator-configured SSH identity (no command/path supplied by input),
// one request only, no timeout-based local dispatch, no automatic retry,
// no CLI start; bounded 8 KiB responses; private remote stderr never
// reflected. The crq-side invocation (`cq dev.review --action=enroll …`)
// keeps working byte-for-byte.
import { captureSnapshot, snapshotHead } from './snapshot.js';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Op, OpResult } from '../../kernel/types.js';
import { DevTransportInputSchema, type DevTransportInput } from './registry.js';

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

/** One request only. No timeout-based local dispatch, automatic retry or CLI start. */
export function makeAuthorAdmission(
  transport: AuthorTransport,
  capture = (base: string, tree: string) =>
    captureSnapshot(
      process.env['CQ_AUTHOR_REPO'] ?? process.cwd(),
      base,
      tree,
      process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'],
    ),
): Op<DevTransportInput, AuthorDecision> {
  return async (input) => {
    try {
      const i = DevTransportInputSchema.parse(input);
      const captured = i.tree && i.action === 'enroll' ? await capture(i.base, i.tree) : undefined;
      const head = i.tree ? snapshotHead(i.base, i.tree) : i.head!;
      if (captured && captured.head !== head) throw new Error('snapshot identity mismatch');
      const binding = {
        request_id: i.requestId,
        base: i.base,
        head,
        target: i.target,
        cycle: i.cycle,
      };
      const envelope = captured
        ? { v: 2, op: i.action, binding, snapshot: captured.snapshot }
        : { v: 1, op: i.action, binding };
      const raw = await transport(JSON.stringify(envelope) + '\n');
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
 * The registry dispatch's admission binding: the CQ_AUTHOR_SSH_ALIAS
 * environment variable names the operator-configured identity (verbatim
 * messages kept from the merged PR's registry adapter — a missing alias is
 * a needs-human configuration gap, an invalid alias a configuration fault).
 */
export function envAuthorAdmission(
  input: DevTransportInput,
): Promise<OpResult<AuthorDecision> | { status: 'needs-human'; reason: string }> {
  const alias = process.env['CQ_AUTHOR_SSH_ALIAS'];
  if (!alias) return Promise.resolve({ status: 'needs-human', reason: AUTHOR_TRANSPORT_HINT });
  try {
    return makeAuthorAdmission(sshAuthorTransport(alias))(input);
  } catch {
    return Promise.resolve({
      status: 'needs-human',
      reason: 'Invalid author transport configuration.',
    });
  }
}
