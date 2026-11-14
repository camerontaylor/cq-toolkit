// The review-v1 forced command served over its real adapter: the existing
// TypeScript review client builds each frame, `runReviewCapabilityMain` answers
// it against a real Git clone and queue file, and the client parses the reply.
// A queue shaped like the Python runner's retained state is served too.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ReviewRemoteError,
  makeReviewClient,
} from '../../../src/ops/review/internal/queueClient.js';
import type { QueueTransport } from '../../../src/ops/review/internal/queueProtocol.js';
import { runReviewCapabilityMain } from '../../../src/adapters/crq/reviewCapabilityMain.js';
import { queueBytes } from '../../../src/adapters/crq/queueEffects.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';
import { receiptJsonText, sha256Hex } from '../../../src/policy/crq/pythonJson.js';

const run = promisify(execFile);
const REPO = 'owner/repo';
const PRINCIPAL = 'client-a';
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

async function commit(cwd: string, path: string, text: string, message: string): Promise<string> {
  await writeFile(join(cwd, path), text, 'utf8');
  await git(cwd, 'add', path);
  await run('git', [
    '-C',
    cwd,
    '-c',
    'user.email=cq@example.test',
    '-c',
    'user.name=CQ',
    'commit',
    '-q',
    '-m',
    message,
  ]);
  return git(cwd, 'rev-parse', 'HEAD');
}

interface Fixture {
  readonly root: string;
  readonly clone: string;
  readonly base: string;
  readonly head: string;
  readonly baseTree: string;
  readonly headTree: string;
  readonly transport: QueueTransport;
  transportCalls: number;
}

async function writeQueue(root: string, queue: JsonObject): Promise<void> {
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(join(root, 'state/queue.json'), queueBytes(queue));
}

async function fixture(queue?: JsonObject): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cq-review-server-'));
  roots.push(root);
  const clone = join(root, 'clone');
  await mkdir(clone, { recursive: true });
  await git(clone, 'init', '-q', '--initial-branch=main');
  const base = await commit(clone, 'a.txt', 'one\n', 'base');
  const head = await commit(clone, 'a.txt', 'two\n', 'head');
  const baseTree = await git(clone, 'rev-parse', `${base}^{tree}`);
  const headTree = await git(clone, 'rev-parse', `${head}^{tree}`);
  await writeQueue(
    root,
    queue ?? object({ items: [], review_requests: {}, queue_client_requests: {} }),
  );
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      repo: REPO,
      clone,
      repos: [],
      worktree_root: join(root, 'worktrees'),
      worktree_prefix: 'cq-wt-',
      local_review_profile: {
        revision: 'committed-full-diff-v1',
        flags: ['--agent', '--deep', '--committed'],
      },
    }),
  );
  await writeFile(
    join(root, 'policy.json'),
    JSON.stringify({
      enabled: true,
      repo: REPO,
      repos: [],
      read: [PRINCIPAL],
      write: [PRINCIPAL],
      targets: [],
      branches: ['main'],
    }),
  );
  const state = { transportCalls: 0 };
  const transport: QueueTransport = async (wire) => {
    state.transportCalls += 1;
    let out = '';
    let err = '';
    const code = await runReviewCapabilityMain({
      argv: [],
      env: (name) => {
        if (name === 'SSH_ORIGINAL_COMMAND') return 'review-v1';
        if (name === 'CRQ_QUEUE_POLICY') return join(root, 'policy.json');
        if (name === 'CRQ_QUEUE_PRINCIPAL') return PRINCIPAL;
        return undefined;
      },
      readStdin: async () => Buffer.from(wire, 'utf8'),
      stdout: (bytes) => {
        out += Buffer.from(bytes).toString('utf8');
      },
      stderr: (message) => {
        err += message;
      },
      terminate: () => undefined,
      root,
      deadlineMs: 20_000,
    });
    if (code !== 0) throw new Error(`forced command refused: ${err}`);
    return out;
  };
  return {
    root,
    clone,
    base,
    head,
    baseTree,
    headTree,
    transport,
    get transportCalls() {
      return state.transportCalls;
    },
  };
}

function object(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

function pythonShapedQueue(f: Fixture): JsonObject {
  const identity = 'a'.repeat(64);
  return object({
    items: [
      {
        id: 'lr-python-g1',
        kind: 'local-review',
        repo: REPO,
        identity,
        target: 'main',
        identity_inputs: {
          v: 1,
          repo: REPO,
          base_commit: f.base,
          head_commit: f.head,
          base_tree: f.baseTree,
          head_tree: f.headTree,
          projection: 'committed',
          scope: 'full-diff',
          config_digest: 'c'.repeat(64),
          profile: {
            adapter: 'coderabbit-cli',
            revision: 'committed-full-diff-v1',
          },
        },
        profile: {
          adapter: 'coderabbit-cli',
          revision: 'committed-full-diff-v1',
        },
        generation: 1,
        repeat_requested: false,
        ancestry_repeat: false,
        observers: ['req-py'],
        notify: [],
        state: 'reviewing',
        pr: null,
        created_at: '2026-11-12T00:00:00Z',
        order: 1,
        cycles: [],
        attempts: [],
        failures: 0,
        depends_on: [],
        task: 'python-fixture',
        branch: 'feat/python-fixture',
      },
    ],
    review_requests: {
      'req-py': {
        v: 1,
        key_digest: 'd'.repeat(64),
        identity,
        created_at: '2026-11-12T00:00:00Z',
        item: 'lr-python-g1',
        principal: PRINCIPAL,
        admission_action: 'created',
        task: 'python-fixture',
        branch: 'feat/python-fixture',
      },
    },
    queue_client_requests: {},
  });
}

describe('review-v1 forced command over the TypeScript client', () => {
  test('a deadline returns the typed retryable unavailable response', async () => {
    let out = '';
    let err = '';
    let terminated = false;
    const code = await runReviewCapabilityMain({
      argv: [],
      env: (name) => {
        if (name === 'SSH_ORIGINAL_COMMAND') return 'review-v1';
        if (name === 'CRQ_QUEUE_POLICY') return '/policy.json';
        if (name === 'CRQ_QUEUE_PRINCIPAL') return PRINCIPAL;
        return undefined;
      },
      readStdin: () => new Promise<Uint8Array>(() => undefined),
      stdout: (bytes) => {
        out += Buffer.from(bytes).toString('utf8');
      },
      stderr: (message) => {
        err += message;
      },
      terminate: () => {
        terminated = true;
      },
      root: '/tmp/missing-review-root',
      deadlineMs: 5,
    });
    expect(code).toBe(0);
    expect(terminated).toBe(true);
    expect(err).toBe('');
    expect(JSON.parse(out)).toMatchObject({
      v: 1,
      error: {
        code: 'unavailable',
        retryable: true,
        message: 'review worker outcome unavailable; retry the same request id',
      },
    });
  });

  test('capabilities, submit, replay, status and cancel round-trip', async () => {
    const f = await fixture();
    const client = makeReviewClient(f.transport);
    const capabilities = await client.capabilities();
    expect(capabilities.command).toBe('review-v1');
    expect(capabilities.operations).toContain('submit');
    const inputs = {
      repo: REPO,
      base_commit: f.base,
      head_commit: f.head,
      base_tree: f.baseTree,
      head_tree: f.headTree,
      projection: 'committed',
      target: 'main',
    };
    const created = await client.request({
      v: 1,
      op: 'submit',
      request_id: 'req-1',
      inputs,
    });
    expect(created).toMatchObject({
      v: 1,
      request_id: 'req-1',
      action: 'created',
      state: 'queued',
    });
    const item = 'item' in created ? created.item : null;
    expect(item).toBeTypeOf('string');

    const replay = await client.request({
      v: 1,
      op: 'submit',
      request_id: 'req-1',
      inputs,
    });
    expect(replay).toMatchObject({ request_id: 'req-1', item });
    expect('action' in replay ? replay.action : null).toBe('observed');

    const status = await client.request({ v: 1, op: 'status', request_id: 'req-1' });
    expect(status).toMatchObject({ request_id: 'req-1', item });
    expect('history' in status).toBe(true);

    const cancelled = await client.request({ v: 1, op: 'cancel', request_id: 'req-1' });
    expect('state' in cancelled ? cancelled.state : null).toBe('cancelled');
    expect(f.transportCalls).toBe(5);
  });

  test('a policy refusal crosses as the typed remote error', async () => {
    const f = await fixture();
    const client = makeReviewClient(f.transport);
    await expect(
      client.request({
        v: 1,
        op: 'submit',
        request_id: 'req-denied',
        inputs: {
          repo: REPO,
          base_commit: f.base,
          head_commit: f.head,
          base_tree: f.baseTree,
          head_tree: f.headTree,
          projection: 'committed',
          target: 'release',
        },
      }),
    ).rejects.toMatchObject({ remote: { code: 'invalid-input', retryable: false } });
    await expect(
      client.request({
        v: 1,
        op: 'submit',
        request_id: 'req-denied',
        inputs: {
          repo: REPO,
          base_commit: f.base,
          head_commit: f.head,
          base_tree: f.baseTree,
          head_tree: f.headTree,
          projection: 'committed',
          target: 'release',
        },
      }),
    ).rejects.toBeInstanceOf(ReviewRemoteError);
  });

  test('a Python-shaped retained queue is served without migration', async () => {
    const f = await fixture();
    await writeQueue(f.root, pythonShapedQueue(f));
    const client = makeReviewClient(f.transport);
    const status = await client.request({ v: 1, op: 'status', request_id: 'req-py' });
    expect(status).toMatchObject({
      request_id: 'req-py',
      item: 'lr-python-g1',
      state: 'running',
    });
    const history = await client.request({
      v: 1,
      op: 'review-history',
      limit: 20,
      cursor: 0,
      repo: REPO,
      target: 'main',
      head_commit: f.head,
      head_tree: f.headTree,
    });
    expect(history).toHaveProperty('digest');
    expect(history).toHaveProperty('status');
  });

  test('a missing receipt is the typed result-unavailable refusal', async () => {
    const f = await fixture();
    const queue = pythonShapedQueue(f);
    const items = (queue.get('items') as JsonObject[]).map((item) =>
      withObjectKeys(item, [
        ['state', 'done'],
        ['receipt_id', 'e'.repeat(64)],
      ]),
    );
    await writeQueue(f.root, withObjectKeys(queue, [['items', items]]));
    const client = makeReviewClient(f.transport);
    await expect(
      client.request({ v: 1, op: 'result', request_id: 'req-py' }),
    ).rejects.toMatchObject({ remote: { code: 'result-unavailable' } });
  });

  test('a stored receipt serves a verified chunk', async () => {
    const f = await fixture();
    const receipt = Buffer.from(
      receiptJsonText(
        object({
          v: 1,
          kind: 'review',
          identity: 'a'.repeat(64),
          identity_inputs: { repo: REPO, base_commit: f.base, head_commit: f.head },
          scope_adequate: true,
          outcome: 'clean',
          generated_at: '2026-11-12T00:00:00Z',
        }),
      ),
      'utf8',
    );
    const receiptId = sha256Hex(receipt);
    const queue = pythonShapedQueue(f);
    const items = (queue.get('items') as JsonObject[]).map((item) =>
      withObjectKeys(item, [
        ['state', 'done'],
        ['receipt_id', receiptId],
      ]),
    );
    await writeQueue(f.root, withObjectKeys(queue, [['items', items]]));
    await mkdir(join(f.root, 'state/receipts'), { recursive: true });
    await writeFile(join(f.root, 'state/receipts', `${receiptId}.json`), receipt);
    const client = makeReviewClient(f.transport);
    const chunk = await client.request({ v: 1, op: 'result', request_id: 'req-py' });
    expect(chunk).toMatchObject({
      receipt_id: receiptId,
      bytes: receipt.length,
      chunks: 1,
      index: 0,
      next_index: null,
    });
    if ('data' in chunk) {
      expect(Buffer.from(chunk.data, 'base64').toString('utf8')).toBe(receipt.toString('utf8'));
    }
  });
});
