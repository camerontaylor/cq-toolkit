import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DevReviewInputSchema, registry } from '../../../src/ops/dev/registry.js';
import { sshAuthorTransport, type AuthorTransport } from '../../../src/ops/dev/review-transport.js';
import {
  admissionBinding,
  admissionInput,
  admissionReview,
  waitingDecision,
} from './reviewTestKit.js';
// ---------------------------------------------------------------------------
// The author-admission branch (the merged worker-transport suite — every
// assertion carried over verbatim, routed through the composed op).
// ---------------------------------------------------------------------------

describe('dev.review worker admission (no local issuer)', () => {
  it('exposes the operation through the lazy registry', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    expect(entry?.name).toBe('dev.review');
    expect(await entry?.importer()).toBeTypeOf('function');
    expect(DevReviewInputSchema.safeParse({ ...admissionInput, spool: 'promotion' }).success).toBe(
      false,
    );
    expect(
      DevReviewInputSchema.safeParse({ ...admissionInput, head: admissionInput.base }).success,
    ).toBe(false);
    expect(() => sshAuthorTransport('-oProxyCommand=bad')).toThrow();
  });

  it('disables SSH sharing and unrelated agent keys for the author identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-author-ssh-'));
    try {
      await writeFile(
        join(root, 'ssh'),
        [
          '#!/bin/sh',
          '[ "$1" = "-T" ] || exit 20',
          '[ "$2" = "-S" ] && [ "$3" = "none" ] || exit 21',
          'identity_only=no; connect_timeout=no; attempts=no',
          'for arg do [ "$arg" != "IdentitiesOnly=yes" ] || identity_only=yes; done',
          'for arg do [ "$arg" != "ConnectTimeout=15" ] || connect_timeout=yes; done',
          'for arg do [ "$arg" != "ConnectionAttempts=1" ] || attempts=yes; done',
          '[ "$identity_only" = yes ] || exit 22',
          '[ "$connect_timeout" = yes ] && [ "$attempts" = yes ] || exit 23',
          'cat >/dev/null',
          `printf '%s\\n' '${JSON.stringify(waitingDecision)}'`,
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      vi.stubEnv('PATH', root + ':' + process.env['PATH']);
      const reply = await admissionReview(sshAuthorTransport('fixture-author'))(admissionInput);
      expect(reply).toEqual({ status: 'ok', value: waitingDecision });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-trips the real Python versioned wire encoder/decoder at this SHA', async () => {
    const transport: AuthorTransport = (request) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          'python3',
          ['-B', '-c', 'from test_author_transport import fixture_main; fixture_main()'],
          {
            cwd: fileURLToPath(new URL('../../../apps/crq-python/', import.meta.url)),
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let output = '';
        let error = '';
        child.stdout.on('data', (s: Buffer) => {
          output += s.toString();
        });
        child.stderr.on('data', (s: Buffer) => {
          error += s.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(error))));
        child.stdin.end(request);
      });
    expect(await admissionReview(transport)(admissionInput)).toEqual({
      status: 'ok',
      value: waitingDecision,
    });
  });

  it('does not retry or dispatch after uncertain delivery', async () => {
    let calls = 0;
    const op = admissionReview(async () => {
      calls++;
      throw new Error('timeout');
    });
    expect((await op(admissionInput)).status).toBe('indeterminate');
    expect(calls).toBe(1);
  });

  it.each([
    { ...waitingDecision, request_id: 'other' },
    { ...waitingDecision, binding: { ...admissionBinding, head: 'c'.repeat(40) } },
    { ...waitingDecision, v: 2 },
    { ...waitingDecision, dispatch: true },
    {
      ...waitingDecision,
      issuer: 'agent',
      reviewer: 'agent:configured',
      dispatch: true,
      decided_at: '2026-10-17T00:25:00Z',
    },
  ])('refuses mismatched, unsupported or unsolicited dispatch replies', async (reply) => {
    expect((await admissionReview(async () => JSON.stringify(reply))(admissionInput)).status).toBe(
      'indeterminate',
    );
  });

  it('returns only explicit one-shot agent permission from a fallback request', async () => {
    const reply = {
      ...waitingDecision,
      issuer: 'agent',
      reviewer: 'agent:configured',
      dispatch: true,
      decided_at: '2026-10-17T00:25:00Z',
    };
    const op = admissionReview(async () => JSON.stringify(reply));
    expect(await op({ ...admissionInput, action: 'fallback' })).toEqual({
      status: 'ok',
      value: reply,
    });
  });
});
