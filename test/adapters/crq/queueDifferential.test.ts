// Differential run: the same queue-v1 frames through Python's
// `queue_transport.handle` (the oracle, test/helpers/queueTransportOracle.py)
// and the TS capability, over the same seeded queue, policy and forge.
// Responses must be byte-equal, refusals must coincide and the final queue
// documents must agree. In-memory effects only: no network, git or lock.
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import {
  runQueueCapability,
  type QueueCapabilityEffects,
} from '../../../src/ops/crq/queueCapability.js';
import { queueBytes } from '../../../src/adapters/crq/queueEffects.js';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';

const REPO = 'owner/repo';
const MERGE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const NOW_SECONDS = 1_794_528_000;
const ORACLE = new URL('../../helpers/queueTransportOracle.py', import.meta.url).pathname;
const APPS = new URL('../../../apps/crq-python', import.meta.url).pathname;

const policy = {
  enabled: true,
  repo: REPO,
  read: ['p'],
  write: ['p'],
  targets: ['promoted-main'],
  branches: ['main'],
  transient_retries: [
    {
      principal: 'p',
      requestId: 'r-retry',
      binding: mergedBinding(7),
    },
  ],
};

function mergedBinding(pr: number): Record<string, unknown> {
  return {
    kind: 'merged-current',
    repo: REPO,
    targetSelector: 'promoted-main',
    pr,
    mergeSha: MERGE,
  };
}

function forge(pr: number): Record<string, unknown> {
  return {
    repo: REPO,
    pr,
    producer: 'author',
    head: HEAD,
    target: 'main',
    state: 'MERGED',
    mergeSha: MERGE,
  };
}

function frame(op: string, requestId: string, pr = 7): string {
  return JSON.stringify({ v: 1, op, requestId, binding: mergedBinding(pr) });
}

interface Case {
  readonly name: string;
  readonly policy?: Record<string, unknown>;
  readonly principal?: string;
  readonly frames: readonly string[];
}

const cases: readonly Case[] = [
  {
    name: 'enqueue, idempotent replay, new id and status',
    frames: [
      frame('enqueue', 'r1'),
      frame('enqueue', 'r1'),
      frame('enqueue', 'r2'),
      frame('status', 'r3'),
      frame('status', 'r4', 8),
    ],
  },
  {
    name: 'two pull requests enqueue independently',
    frames: [frame('enqueue', 'r1'), frame('enqueue', 'r2', 8), frame('status', 'r3', 8)],
  },
  {
    name: 'retry probe, granted then after enqueue',
    frames: [frame('retry-capability', 'r-retry'), frame('enqueue', 'r-retry')],
  },
  {
    name: 'forge failure and malformed frames refuse',
    frames: [frame('enqueue', 'r1', 99), '{not json', '', JSON.stringify({ v: 2, op: 'status' })],
  },
  {
    name: 'unauthorized principal',
    principal: 'stranger',
    frames: [frame('status', 'r1'), frame('enqueue', 'r2'), frame('retry-capability', 'r-retry')],
  },
  {
    name: 'disabled policy answers unsupported',
    policy: { ...policy, enabled: false },
    frames: [frame('status', 'r1'), frame('enqueue', 'r2'), frame('retry-capability', 'r-retry')],
  },
];

function json(value: unknown): JsonValue {
  return parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
}

interface Outcome {
  readonly responses: readonly (string | null)[];
  readonly queue: unknown;
}

function pythonOutcome(item: Case): Outcome {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({
      policy: item.policy ?? policy,
      principal: item.principal ?? 'p',
      queue: { items: [] },
      forge: { '7': forge(7), '8': forge(8) },
      frames: item.frames,
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

async function tsOutcome(item: Case): Promise<Outcome> {
  let queue = json({ items: [] }) as JsonObject;
  let generation = 1;
  const effects: QueueCapabilityEffects = {
    projectFixed: false,
    nowIso: () => '2026-11-13T00:00:00Z',
    nowMicros: () => BigInt(NOW_SECONDS) * 1_000_000n,
    queueGeneration: async () => json([1, 2, generation, 4]),
    loadQueue: async () => queue,
    saveQueue: async (next) => {
      queue = next;
      generation += 1;
    },
    withQueueLock: async (work) => work(),
    withReadSlot: async (work) => work(),
    readReceipt: async () => {
      throw new Error('no receipts in this corpus');
    },
    receiptSize: async () => 0,
    readJournal: async () => null,
    updateJournal: async () => {},
    withForgeCache: async (_key, check) => check(),
    reconcilePath: (key) => `/state/reconcile/${key}.json`,
    readReconcileWrapperText: async () => {
      throw new Error('no reconcile wrapper in this corpus');
    },
    verifySource: async (_repo, pr) => {
      if (pr !== 7 && pr !== 8) throw new Error('no forge metadata');
      return json(forge(pr));
    },
    runDir: (runId) => `/runs/${runId}`,
    hasExit: async () => false,
    readPidfile: async () => null,
    runLiveness: async () => 'ambiguous',
  };
  const responses: (string | null)[] = [];
  for (const raw of item.frames) {
    try {
      const out = await runQueueCapability(
        {
          raw: new TextEncoder().encode(raw),
          principal: item.principal ?? 'p',
          policy: json(item.policy ?? policy),
          runnerRepo: REPO,
        },
        effects,
      );
      responses.push(new TextDecoder().decode(out));
    } catch {
      responses.push(null);
    }
  }
  return { responses, queue: JSON.parse(queueBytes(queue)) as unknown };
}

describe('queue-v1 differential against the Python transport', () => {
  for (const item of cases) {
    test(item.name, async () => {
      const [expected, actual] = [pythonOutcome(item), await tsOutcome(item)];
      expect(actual.responses).toEqual(expected.responses);
      expect(actual.queue).toEqual(expected.queue);
    });
  }

  test('the corpus exercises both responses and refusals', () => {
    const outcomes = cases.map(pythonOutcome).flatMap((o) => o.responses);
    expect(outcomes.some((r) => r !== null)).toBe(true);
    expect(outcomes.some((r) => r === null)).toBe(true);
  });
});
