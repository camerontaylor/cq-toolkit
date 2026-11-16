// The author-v1 forced command over its real adapter: queue persistence, the
// audit line, the regenerated status document and the opaque refusal paths.
// The fallback clock is driven through the injected adapter clock.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runAuthorCapabilityMain } from '../../../src/adapters/crq/authorCapabilityMain.js';
import { queueBytes } from '../../../src/adapters/crq/queueEffects.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const REPO = 'owner/repo';
const REVIEWER = 'reviewer-agent';
const TARGET = 'origin/main';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const NOW = new Date('2026-11-13T00:00:00Z');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function object(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

async function fixture(): Promise<{
  root: string;
  clone: string;
  env: (name: string) => string | undefined;
  call: (frame: unknown) => Promise<{ code: number; out: string; err: string }>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'cq-author-server-'));
  roots.push(root);
  const clone = join(root, 'clone');
  await mkdir(clone, { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      repo: REPO,
      clone,
      max_starts_per_hour: 12,
      merged_min_survival: 0.5,
      merged_min_surviving_lines: 10,
      error_backoff_min: 30,
    }),
  );
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(
    join(root, 'state/queue.json'),
    queueBytes(
      object({
        created_at: '2026-11-01T00:00:00Z',
        items: [],
        starts: [],
        paused: false,
        author_requests: {},
        author_observations: [],
        last_tick: '2026-11-12T00:00:00Z',
      }),
    ),
  );
  await writeFile(
    join(root, 'state/events.jsonl'),
    '{"at": "2026-11-12T00:00:00Z", "event": "tick", "detail": "ok"}\n',
  );
  await writeFile(join(root, 'policy.json'), JSON.stringify({ review: { reviewerTimeoutMin: 5 } }));
  const env = (name: string): string | undefined => {
    if (name === 'SSH_ORIGINAL_COMMAND') return 'author-v1';
    if (name === 'CRQ_AUTHOR_REVIEW_POLICY') return join(root, 'policy.json');
    if (name === 'CRQ_AUTHOR_FALLBACK_REVIEWER') return REVIEWER;
    if (name === 'CRQ_AUTHOR_TARGET') return TARGET;
    return undefined;
  };
  return {
    root,
    clone,
    env,
    async call(frame) {
      let out = '';
      let err = '';
      const code = await runAuthorCapabilityMain({
        argv: [],
        env,
        readStdin: async () => Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8'),
        stdout: (bytes) => {
          out += Buffer.from(bytes).toString('utf8');
        },
        stderr: (message) => {
          err += message;
        },
        terminate: () => undefined,
        root,
        deadlineMs: 20_000,
        now: () => NOW,
      });
      return { code, out, err };
    },
  };
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { request_id: 'req-1', base: BASE, head: HEAD, target: TARGET, cycle: 1, ...overrides };
}

describe('author-v1 forced command over the real adapter', () => {
  test('enrollment persists the lease, appends the audit line and rewrites status', async () => {
    const f = await fixture();
    const result = await f.call({ v: 1, op: 'enroll', binding: binding() });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const decision = object(JSON.parse(result.out));
    expect(decision.get('issuer')).toBe('waiting');
    expect(decision.get('request_id')).toBe('req-1');
    const queue = object(JSON.parse(await readFile(join(f.root, 'state/queue.json'), 'utf8')));
    const items = queue.get('items') as JsonObject[];
    expect(items).toHaveLength(1);
    expect(items[0]?.get('state')).toBe('pending');
    const lease = items[0]?.get('author_lease');
    expect(lease).toBeInstanceOf(JsonObject);
    expect((lease as JsonObject).get('reviewer')).toBe(REVIEWER);
    const events = await readFile(join(f.root, 'state/events.jsonl'), 'utf8');
    expect(events).toContain('"event": "author_enrolled"');
    expect(events).toContain('"request": "req-1"');
    const status = await readFile(join(f.root, 'state/status.md'), 'utf8');
    expect(status).toContain('CodeRabbit review queue');
  });

  test('status replays the waiting lease without writing the queue', async () => {
    const f = await fixture();
    await f.call({ v: 1, op: 'enroll', binding: binding() });
    const before = await readFile(join(f.root, 'state/queue.json'), 'utf8');
    const result = await f.call({ v: 1, op: 'status', binding: binding() });
    expect(result.code).toBe(0);
    expect(object(JSON.parse(result.out)).get('issuer')).toBe('waiting');
    expect(await readFile(join(f.root, 'state/queue.json'), 'utf8')).toBe(before);
  });

  test('fallback before the deadline is one opaque refusal', async () => {
    const f = await fixture();
    await f.call({ v: 1, op: 'enroll', binding: binding() });
    const result = await f.call({ v: 1, op: 'fallback', binding: binding() });
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('author capability refused; no permission');
  });

  test('a mismatched approved target is refused before any state is read', async () => {
    const f = await fixture();
    const result = await callWithTarget(f, 'origin/other');
    expect(result.code).toBe(2);
    expect(result.err).toContain('author capability refused; no permission');
  });
});

async function callWithTarget(
  f: Awaited<ReturnType<typeof fixture>>,
  target: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runAuthorCapabilityMain({
    argv: [],
    env: (name) => (name === 'CRQ_AUTHOR_TARGET' ? target : f.env(name)),
    readStdin: async () =>
      Buffer.from(`${JSON.stringify({ v: 1, op: 'status', binding: binding() })}\n`, 'utf8'),
    stdout: (bytes) => {
      out += Buffer.from(bytes).toString('utf8');
    },
    stderr: (message) => {
      err += message;
    },
    terminate: () => undefined,
    root: f.root,
    deadlineMs: 20_000,
    now: () => NOW,
  });
  return { code, out, err };
}
