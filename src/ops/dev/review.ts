import { captureSnapshot, SnapshotConfigError, snapshotHead } from './internal/snapshot.js';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Op } from '../../kernel/types.js';
import { DevReviewInputSchema, type DevReviewInput } from './registry.js';

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
export function makeDevReview(
  transport: AuthorTransport,
  capture = (base: string, tree: string) =>
    captureSnapshot(
      process.env['CQ_AUTHOR_REPO'] ?? process.cwd(),
      base,
      tree,
      process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'],
    ),
): Op<DevReviewInput, AuthorDecision> {
  return async (input) => {
    try {
      const i = DevReviewInputSchema.parse(input);
      let captured: Awaited<ReturnType<typeof capture>> | undefined;
      if (i.tree && i.action === 'enroll') {
        try {
          captured = await capture(i.base, i.tree);
        } catch (error) {
          if (error instanceof SnapshotConfigError) throw error;
          // Local capture or pre-upload scan failed before transport: nothing was sent.
          return {
            status: 'failed',
            error: 'Snapshot capture or pre-upload scan refused; nothing was sent to the author.',
          };
        }
      }
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
    } catch (error) {
      if (error instanceof SnapshotConfigError)
        return {
          status: 'needs-human',
          reason: 'Configure CQ_AUTHOR_SNAPSHOT_SCANNER as an absolute operator scanner path.',
        };
      return {
        status: 'indeterminate',
        detail:
          'Author admission unknown or refused; no local review or fallback is authorized. Query the same request binding; never mint a replacement on timeout.',
      };
    }
  };
}

const review: Op<DevReviewInput, AuthorDecision> = async (input) => {
  const alias = process.env['CQ_AUTHOR_SSH_ALIAS'];
  if (!alias)
    return {
      status: 'needs-human',
      reason: 'Configure CQ_AUTHOR_SSH_ALIAS for the separate author forced-command identity.',
    };
  try {
    return await makeDevReview(sshAuthorTransport(alias))(input);
  } catch {
    return { status: 'needs-human', reason: 'Invalid author transport configuration.' };
  }
};
export default review;
