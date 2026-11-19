// Differential run: the same review-v1 frames through Python's
// `review_transport.safe_handle` (the oracle, test/helpers/reviewTransportOracle.py)
// and the TS forced command `runReviewCapabilityMain`, over the same real Git
// clone, config, policy and queue. Responses must be byte-equal, a refusal must
// coincide with a nonzero exit, and the final queue documents must agree.
// No network and no fetch: every commit the corpus names exists in the clone.
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runReviewCapabilityMain } from '../../../src/adapters/crq/reviewCapabilityMain.js';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';

const run = promisify(execFile);
const REPO = 'owner/repo';
const PRINCIPAL = 'client-a';
const ORACLE = new URL('../../helpers/reviewTransportOracle.py', import.meta.url).pathname;
const APPS = new URL('../../../apps/crq-python', import.meta.url).pathname;
const NOW = new Date('2026-11-13T00:00:00Z');

interface Repo {
  root: string;
  clone: string;
  base: string;
  head: string;
  baseTree: string;
  headTree: string;
}

let repo: Repo;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', [
    '-C',
    cwd,
    '-c',
    'user.email=cq@example.test',
    '-c',
    'user.name=CQ',
    ...args,
  ]);
  return stdout.trim();
}

async function commit(cwd: string, text: string, message: string): Promise<string> {
  await writeFile(join(cwd, 'a.txt'), text, 'utf8');
  await git(cwd, 'add', 'a.txt');
  await git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-review-diff-'));
  const clone = join(root, 'clone');
  await mkdir(clone, { recursive: true });
  await git(clone, 'init', '-q', '--initial-branch=main');
  const base = await commit(clone, 'one\n', 'base');
  const head = await commit(clone, 'two\n', 'head');
  repo = {
    root,
    clone,
    base,
    head,
    baseTree: await git(clone, 'rev-parse', `${base}^{tree}`),
    headTree: await git(clone, 'rev-parse', `${head}^{tree}`),
  };
});

afterAll(async () => {
  await rm(repo.root, { recursive: true, force: true });
});

const basePolicy = {
  enabled: true,
  repo: REPO,
  repos: [],
  read: [PRINCIPAL],
  write: [PRINCIPAL],
  targets: [],
  branches: ['main'],
};

function frame(body: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, ...body }) + '\n';
}

function inputs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: REPO,
    base_commit: repo.base,
    head_commit: repo.head,
    base_tree: repo.baseTree,
    head_tree: repo.headTree,
    projection: 'committed',
    target: 'main',
    ...over,
  };
}

const submit = (id: string, over: Record<string, unknown> = {}, extra = {}): string =>
  frame({ op: 'submit', request_id: id, inputs: inputs(over), ...extra });

interface Case {
  readonly name: string;
  readonly policy?: Record<string, unknown>;
  readonly principal?: string;
  readonly frames: () => readonly string[];
}

const cases: readonly Case[] = [
  {
    name: 'capabilities answer before anything else',
    frames: () => [frame({ op: 'capabilities' })],
  },
  {
    name: 'a disabled policy answers unsupported but still lists capabilities',
    policy: { ...basePolicy, enabled: false },
    frames: () => [frame({ op: 'capabilities' }), submit('r1'), frame({ op: 'status', request_id: 'r1' })],
  },
  {
    name: 'a principal without write access is refused',
    principal: 'stranger',
    frames: () => [frame({ op: 'capabilities' }), submit('r1')],
  },
  {
    name: 'submit, replay, status, history and cancel',
    frames: () => [
      submit('r1', {}, { task: 't1', branch: 'feat/x' }),
      submit('r1', {}, { task: 't1', branch: 'feat/x' }),
      frame({ op: 'status', request_id: 'r1' }),
      frame({ op: 'review-history', request_id: 'r1' }),
      frame({ op: 'review-history', repo: REPO, target: 'main', head_commit: repo.head, head_tree: repo.headTree, limit: 5, cursor: 0 }),
      frame({ op: 'review-history', repo: REPO }),
      frame({ op: 'cancel', request_id: 'r1' }),
      frame({ op: 'status', request_id: 'r1' }),
      frame({ op: 'cancel', request_id: 'r1' }),
    ],
  },
  {
    name: 'a second request for the same head joins, an explicit repeat is a new generation',
    frames: () => [
      submit('r1'),
      submit('r2'),
      submit('r3', {}, { repeat: true }),
      frame({ op: 'status', request_id: 'r3' }),
    ],
  },
  {
    name: 'submit refusals: target, repository, trees, projection and request id',
    frames: () => [
      submit('r1', { target: 'release' }),
      submit('r2', { repo: 'other/repo' }),
      submit('r3', { head_tree: repo.baseTree }),
      submit('bad id'),
      submit('r5', { projection: 'working-tree' }),
    ],
  },
  {
    name: 'frame refusals: not JSON, duplicate key, unknown op, unknown field',
    frames: () => [
      'not json\n',
      '{"v":1,"op":"capabilities","op":"status"}\n',
      frame({ op: 'purge' }),
      frame({ op: 'status', request_id: 'r1', extra: 1 }),
      frame({ op: 'status' }),
      '[]\n',
    ],
  },
  {
    name: 'read ops on an unknown request',
    frames: () => [
      frame({ op: 'status', request_id: 'nope' }),
      frame({ op: 'result', request_id: 'nope' }),
      frame({ op: 'review-history', request_id: 'nope' }),
      frame({ op: 'notify-update', request_id: 'nope', notify: null }),
    ],
  },
  {
    name: 'a pending request has no result to page',
    frames: () => [submit('r1'), frame({ op: 'result', request_id: 'r1' }), frame({ op: 'result', request_id: 'r1', index: 3 })],
  },
  {
    name: 'record refuses an unallowed repository before touching state',
    frames: () => [
      frame({ op: 'record', request_id: 'rec1', repo: 'other/repo' }),
      frame({ op: 'record', request_id: 'rec2' }),
    ],
  },
];

// Decode and schema refusals are the same typed `invalid-input` answer, but the
// message text is a library artefact on each side (Python's `json` and schema
// validator against the TS parser and Zod). Both sides are folded to one marker
// so the code, retryability and every other message still compare exactly.
const DECODE_MESSAGES = new Set([
  'event does not match one schema variant',
  'duplicate JSON key',
  'invalid JSON request',
  'invalid review request',
]);

function normalise(response: string | null): string | null {
  if (response === null) return null;
  const doc = JSON.parse(response) as { error?: { message?: string } };
  const message = doc.error?.message;
  const decode =
    message !== undefined &&
    (DECODE_MESSAGES.has(message) || /^(Expecting|Extra data|Unterminated|Invalid )/.test(message));
  return decode ? response.replace(JSON.stringify(message).slice(1, -1), '<decode refusal>') : response;
}

interface Outcome {
  readonly responses: readonly (string | null)[];
  readonly queue: unknown;
}

const config = (r: Repo): Record<string, unknown> => ({
  repo: REPO,
  clone: r.clone,
  repos: [],
  worktree_root: join(r.root, 'worktrees'),
  worktree_prefix: 'cq-wt-',
  local_review_profile: { revision: 'committed-full-diff-v1', flags: ['--agent', '--deep', '--committed'] },
});

const emptyQueue = { items: [], review_requests: {}, queue_client_requests: {} };

function pythonOutcome(item: Case): Outcome {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({
      config: config(repo),
      policy: item.policy ?? basePolicy,
      principal: item.principal ?? PRINCIPAL,
      queue: emptyQueue,
      frames: item.frames(),
      clone: repo.clone,
    }),
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout) as {
    responses: ({ ok: true; b64: string } | { ok: false; error: string })[];
    queue: unknown;
  };
  return {
    responses: parsed.responses.map((r) => (r.ok ? Buffer.from(r.b64, 'base64').toString('utf8') : null)),
    queue: parsed.queue,
  };
}

async function tsOutcome(item: Case): Promise<Outcome> {
  const root = await mkdtemp(join(repo.root, 'ts-'));
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(join(root, 'state/queue.json'), JSON.stringify(emptyQueue));
  await writeFile(join(root, 'config.json'), JSON.stringify(config(repo)));
  await writeFile(join(root, 'policy.json'), JSON.stringify(item.policy ?? basePolicy));
  const pool = new GitPool();
  const responses: (string | null)[] = [];
  try {
    for (const wire of item.frames()) {
      let out = '';
      const code = await runReviewCapabilityMain({
        argv: [],
        env: (name) => {
          if (name === 'SSH_ORIGINAL_COMMAND') return 'review-v1';
          if (name === 'CRQ_QUEUE_POLICY') return join(root, 'policy.json');
          if (name === 'CRQ_QUEUE_PRINCIPAL') return item.principal ?? PRINCIPAL;
          return undefined;
        },
        readStdin: async () => Buffer.from(wire, 'utf8'),
        stdout: (bytes) => {
          out += Buffer.from(bytes).toString('utf8');
        },
        stderr: () => undefined,
        terminate: () => undefined,
        root,
        deadlineMs: 30_000,
        now: () => NOW,
        pool,
      });
      responses.push(code === 0 ? out : null);
    }
    return { responses, queue: JSON.parse(await readFile(join(root, 'state/queue.json'), 'utf8')) as unknown };
  } finally {
    pool.killAll();
  }
}

describe('review-v1 differential against the Python transport', () => {
  for (const item of cases) {
    test(item.name, async () => {
      const expected = pythonOutcome(item);
      const actual = await tsOutcome(item);
      expect(actual.responses.map(normalise)).toEqual(expected.responses.map(normalise));
      expect(actual.queue).toEqual(expected.queue);
    });
  }

  // Known divergences, pinned so a change on either side is noticed. In each,
  // the TypeScript answer is the stricter one and is not changed here.
  test('divergence: cancel is owner-checked in TypeScript only (PR 1713)', async () => {
    const item: Case = {
      name: 'cancel',
      frames: () => [frame({ op: 'cancel', request_id: 'nope' })],
    };
    const [python, ts] = [pythonOutcome(item), await tsOutcome(item)];
    expect(python.responses[0]).toContain('unknown review request');
    expect(ts.responses[0]).toContain('cancel request owner denied');
  });

  test('divergence: a frame without its trailing newline is refused only by TypeScript', async () => {
    const item: Case = {
      name: 'no newline',
      frames: () => [JSON.stringify({ v: 1, op: 'capabilities' })],
    };
    const [python, ts] = [pythonOutcome(item), await tsOutcome(item)];
    expect(python.responses[0]).toContain('"command":"review-v1"');
    expect(ts.responses[0]).toContain('invalid JSON request');
  });
});
