import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  makeDevReview,
  sshAuthorTransport,
  type AuthorTransport,
} from '../../../src/ops/dev/review.js';
import { DevReviewInputSchema, registry } from '../../../src/ops/dev/registry.js';

const input = {
  action: 'enroll',
  requestId: 'worker-1',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  target: 'origin/merge-queue',
  cycle: 1,
} as const;
const binding = {
  request_id: input.requestId,
  base: input.base,
  head: input.head,
  target: input.target,
  cycle: input.cycle,
};
const waiting = {
  v: 1,
  request_id: input.requestId,
  binding,
  issuer: 'waiting',
  reviewer: null,
  deadline_at: '2026-10-17T00:25:00Z',
  decided_at: null,
  dispatch: false,
};

describe('dev.review worker admission (no local issuer)', () => {
  it('exposes the operation through the lazy registry', async () => {
    expect(registry[0]?.name).toBe('dev.review');
    expect(await registry[0]?.importer()).toBeTypeOf('function');
    expect(DevReviewInputSchema.safeParse({ ...input, spool: 'promotion' }).success).toBe(false);
    expect(DevReviewInputSchema.safeParse({ ...input, head: input.base }).success).toBe(false);
    expect(() => sshAuthorTransport('-oProxyCommand=bad')).toThrow();
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
    expect(await makeDevReview(transport)(input)).toEqual({ status: 'ok', value: waiting });
  });

  it('does not retry or dispatch after uncertain delivery', async () => {
    let calls = 0;
    const op = makeDevReview(async () => {
      calls++;
      throw new Error('timeout');
    });
    expect((await op(input)).status).toBe('indeterminate');
    expect(calls).toBe(1);
  });

  it.each([
    { ...waiting, request_id: 'other' },
    { ...waiting, binding: { ...binding, head: 'c'.repeat(40) } },
    { ...waiting, v: 2 },
    { ...waiting, dispatch: true },
    {
      ...waiting,
      issuer: 'agent',
      reviewer: 'agent:configured',
      dispatch: true,
      decided_at: '2026-10-17T00:25:00Z',
    },
  ])('refuses mismatched, unsupported or unsolicited dispatch replies', async (reply) => {
    expect((await makeDevReview(async () => JSON.stringify(reply))(input)).status).toBe(
      'indeterminate',
    );
  });

  it('returns only explicit one-shot agent permission from a fallback request', async () => {
    const reply = {
      ...waiting,
      issuer: 'agent',
      reviewer: 'agent:configured',
      dispatch: true,
      decided_at: '2026-10-17T00:25:00Z',
    };
    const op = makeDevReview(async () => JSON.stringify(reply));
    expect(await op({ ...input, action: 'fallback' })).toEqual({ status: 'ok', value: reply });
  });
});
