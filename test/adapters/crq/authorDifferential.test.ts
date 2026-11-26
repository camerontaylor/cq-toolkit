// Differential run: the same author-v1 frames through Python's
// `author_transport.handle` (the oracle, test/helpers/authorTransportOracle.py)
// and the TS forced command `runAuthorCapabilityMain`, over the same queue,
// review policy, fallback reviewer and approved target. Responses must be
// byte-equal, a refusal must coincide with a nonzero exit, and the final queue
// documents must agree. v2 snapshot installs need gitleaks and the denylist
// policy and are not exercised here; v2 refusals that fire before an install are.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runAuthorCapabilityMain } from '../../../src/adapters/crq/authorCapabilityMain.js';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';

const ORACLE = new URL('../../helpers/authorTransportOracle.py', import.meta.url).pathname;
const APPS = new URL('../../../apps/crq-python', import.meta.url).pathname;
const REVIEWER = 'fallback-reviewer';
const TARGET = 'origin/main';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const T0 = Date.parse('2026-11-13T00:00:00Z');

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cq-author-diff-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const binding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  request_id: 'req-1',
  base: BASE,
  head: HEAD,
  target: TARGET,
  cycle: 1,
  ...over,
});
const frame = (op: string, over: Record<string, unknown> = {}, v = 1): string =>
  JSON.stringify({ v, op, binding: binding(over) });

interface Case {
  readonly name: string;
  readonly frames: readonly string[];
  /** Minutes after T0 at which each frame runs; defaults to 0. */
  readonly minutes?: readonly number[];
  readonly target?: string;
  readonly reviewer?: string;
  readonly policy?: unknown;
}

const policyOf = (item: Case): unknown => item.policy ?? { review: { reviewerTimeoutMin: 10 } };

const cases: readonly Case[] = [
  {
    name: 'enroll, replay, status and an early fallback that is not yet due',
    frames: [frame('enroll'), frame('enroll'), frame('status'), frame('fallback')],
  },
  {
    name: 'a fallback after the deadline is claimed once',
    frames: [frame('enroll'), frame('fallback'), frame('fallback'), frame('status')],
    minutes: [0, 11, 12, 13],
  },
  {
    name: 'status and fallback for a request that was never enrolled',
    frames: [frame('status'), frame('fallback')],
  },
  {
    name: 'a conflicting identity for an enrolled request',
    frames: [
      frame('enroll'),
      frame('enroll', { head: 'c'.repeat(40) }),
      frame('status', { cycle: 2 }),
    ],
  },
  {
    name: 'two requests in one queue',
    frames: [
      frame('enroll'),
      frame('enroll', { request_id: 'req-2', cycle: 2 }),
      frame('status', { request_id: 'req-2', cycle: 2 }),
    ],
  },
  {
    name: 'binding refusals: ids, shas, target, cycle, whitespace',
    frames: [
      frame('enroll', { request_id: 'bad id' }),
      frame('enroll', { base: 'xyz' }),
      frame('enroll', { head: BASE }),
      frame('enroll', { target: 'origin/other' }),
      frame('enroll', { target: 'bad target' }),
      frame('enroll', { cycle: 0 }),
      frame('enroll', { cycle: true }),
      frame('enroll', { cycle: '1' }),
    ],
  },
  {
    name: 'frame refusals: not JSON, duplicate key, unknown op, fields, version',
    frames: [
      'not json',
      '[]',
      '{"v":1,"op":"status","op":"enroll","binding":{}}',
      frame('purge'),
      JSON.stringify({ v: 1, op: 'status', binding: binding(), extra: 1 }),
      JSON.stringify({ v: 1, op: 'status' }),
      JSON.stringify({ v: 3, op: 'status', binding: binding() }),
      JSON.stringify({
        v: 1,
        op: 'status',
        binding: { ...binding(), extra: 1 },
      }),
      JSON.stringify({ v: 2, op: 'status', binding: binding(), snapshot: {} }),
      JSON.stringify({ v: 2, op: 'enroll', binding: binding() }),
    ],
  },
  {
    name: 'an unapproved target is refused before any state change',
    target: 'origin/release',
    frames: [frame('enroll'), frame('status')],
  },
  {
    name: 'a missing fallback reviewer refuses',
    reviewer: '',
    frames: [frame('enroll'), frame('status')],
  },
  {
    name: 'a policy without a positive timeout refuses enrollment',
    policy: { review: { reviewerTimeoutMin: 0 } },
    frames: [frame('enroll'), frame('status')],
  },
];

// Decode and schema refusals carry library-specific text on stderr in neither
// implementation (the wire carries nothing), so only success bytes compare.
interface Outcome {
  readonly responses: readonly (string | null)[];
  readonly queue: unknown;
}

const emptyQueue = {
  created_at: '2026-11-01T00:00:00Z',
  items: [],
  starts: [],
  paused: false,
  author_requests: {},
  author_observations: [],
  last_tick: '2026-11-12T00:00:00Z',
};
const NOW_ISO = (minutes: number): string =>
  new Date(T0 + minutes * 60_000).toISOString().slice(0, 19) + 'Z';

async function setup(item: Case): Promise<string> {
  const dir = await mkdtemp(join(root, 'case-'));
  await mkdir(join(dir, 'state'), { recursive: true });
  await writeFile(join(dir, 'policy.json'), JSON.stringify(policyOf(item)));
  return dir;
}

function pythonOutcome(item: Case, policyPath: string): Outcome {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({
      queue: emptyQueue,
      policy_path: policyPath,
      reviewer: item.reviewer ?? REVIEWER,
      approved_target: item.target ?? TARGET,
      frames: item.frames,
      times: item.frames.map((_, i) => NOW_ISO(item.minutes?.[i] ?? 0)),
    }),
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout) as {
    responses: ({ ok: true; b64: string } | { ok: false; error: string })[];
    queue: unknown;
  };
  return {
    responses: parsed.responses.map((r) =>
      r.ok ? Buffer.from(r.b64, 'base64').toString('utf8') : null,
    ),
    queue: parsed.queue,
  };
}

async function tsOutcome(item: Case, dir: string): Promise<Outcome> {
  await writeFile(join(dir, 'state/queue.json'), JSON.stringify(emptyQueue));
  await writeFile(
    join(dir, 'state/events.jsonl'),
    '{"at": "2026-11-12T00:00:00Z", "event": "tick", "detail": "ok"}\n',
  );
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      repo: 'owner/repo',
      clone: join(dir, 'clone'),
      max_starts_per_hour: 12,
      merged_min_survival: 0.5,
      merged_min_surviving_lines: 10,
      error_backoff_min: 30,
    }),
  );
  const pool = new GitPool();
  const responses: (string | null)[] = [];
  try {
    for (const [index, wire] of item.frames.entries()) {
      let out = '';
      const code = await runAuthorCapabilityMain({
        argv: [],
        env: (name) => {
          if (name === 'SSH_ORIGINAL_COMMAND') return 'author-v1';
          if (name === 'CRQ_AUTHOR_REVIEW_POLICY') return join(dir, 'policy.json');
          if (name === 'CRQ_AUTHOR_FALLBACK_REVIEWER') return item.reviewer ?? REVIEWER;
          if (name === 'CRQ_AUTHOR_TARGET') return item.target ?? TARGET;
          return undefined;
        },
        readStdin: async () => Buffer.from(wire, 'utf8'),
        stdout: (bytes) => {
          out += Buffer.from(bytes).toString('utf8');
        },
        stderr: () => undefined,
        terminate: () => undefined,
        root: dir,
        deadlineMs: 30_000,
        now: () => new Date(T0 + (item.minutes?.[index] ?? 0) * 60_000),
        pool,
      });
      responses.push(code === 0 ? out : null);
    }
    return {
      responses,
      queue: JSON.parse(await readFile(join(dir, 'state/queue.json'), 'utf8')) as unknown,
    };
  } finally {
    pool.killAll();
  }
}

describe('author-v1 differential against the Python transport', () => {
  for (const item of cases) {
    test(item.name, async () => {
      const dir = await setup(item);
      const expected = pythonOutcome(item, join(dir, 'policy.json'));
      const actual = await tsOutcome(item, dir);
      expect(actual.responses).toEqual(expected.responses);
      expect(actual.queue).toEqual(expected.queue);
    });
  }
});
