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

const WINDOW = { after: '2026-11-01T00:00:00Z', before: '2026-11-30T00:00:00Z' };
const healthBinding = { repo: REPO, targetSelector: 'promoted-main' };
const inventoryBinding = { ...healthBinding, ...WINDOW };
const grantedPolicy = {
  ...policy,
  health_reads: [{ principal: 'p', binding: healthBinding }],
  inventory_reads: [{ principal: 'p', binding: inventoryBinding }],
};
const healthQueue = {
  items: [
    { id: 'a', state: 'pending' },
    { id: 'b', state: 'blocked' },
    { id: 'c', state: 'pending' },
  ],
  client_health: { complete: false, incomplete_ticks: 4, sha: 'f'.repeat(40) },
};
const receiptDocument = {
  version: 1,
  capture: {
    target_sha: 'c'.repeat(40),
    target_tree: 'd'.repeat(40),
    paths: [{ path: 'src/a.ts', disposition: 'included' }],
  },
  classification: { counted: true, outcome: 'completed' },
  counted: true,
  outcome: 'terminal-with-findings',
  findings: [{ text: 'large finding '.repeat(900) }],
  artifacts: {},
  remediation: { enabled: false },
};

function rawFrame(body: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, ...body });
}

interface AttachReceipt {
  readonly attach_receipt: Record<string, unknown>;
}

interface Case {
  readonly name: string;
  readonly policy?: Record<string, unknown>;
  readonly principal?: string;
  readonly queue?: Record<string, unknown>;
  readonly busy?: boolean;
  readonly reconcile?: Record<string, unknown>;
  readonly frames: readonly (string | AttachReceipt)[];
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
  {
    name: 'health needs its grant, then reports counts',
    queue: healthQueue,
    frames: [
      rawFrame({ op: 'health', requestId: 'h1', binding: healthBinding }),
      rawFrame({ op: 'health', requestId: 'h1', binding: healthBinding }),
    ],
  },
  {
    name: 'health with its grant',
    policy: grantedPolicy,
    queue: healthQueue,
    frames: [
      rawFrame({ op: 'health', requestId: 'h1', binding: healthBinding }),
      rawFrame({ op: 'health', requestId: 'h2', binding: { ...healthBinding, targetSelector: 'x' } }),
      rawFrame({ op: 'health', requestId: 'h3', binding: mergedBinding(7) }),
      rawFrame({ op: 'health', requestId: 'h4', binding: healthBinding, extra: 1 }),
    ],
  },
  {
    name: 'inventory without and with its grant over the reconcile window',
    policy: grantedPolicy,
    reconcile: { ...WINDOW, prs: [7, 8, 9], merge: MERGE },
    frames: [
      frame('enqueue', 'r1'),
      ...[null, 'first'].map((c, i) =>
        rawFrame({
          op: 'inventory',
          requestId: `i${i}`,
          binding: inventoryBinding,
          cursor: c,
          limit: 1,
          states: null,
        }),
      ),
      rawFrame({
        op: 'inventory',
        requestId: 'i2',
        binding: inventoryBinding,
        cursor: null,
        limit: 10,
        states: ['missing'],
      }),
      rawFrame({
        op: 'inventory',
        requestId: 'i3',
        binding: inventoryBinding,
        cursor: null,
        limit: 11,
        states: null,
      }),
    ],
  },
  {
    name: 'inventory is refused without a grant',
    reconcile: { ...WINDOW, prs: [7], merge: MERGE },
    frames: [
      rawFrame({
        op: 'inventory',
        requestId: 'i0',
        binding: inventoryBinding,
        cursor: null,
        limit: 1,
        states: null,
      }),
    ],
  },
  {
    name: 'report pages a receipt in order and acknowledges it',
    frames: [
      frame('enqueue', 'r1'),
      { attach_receipt: receiptDocument },
      frame('status', 'r1'),
      reportFrame('r1', null),
      reportFrame('r1', '$RID:1'),
      reportFrame('r1', '$RID:0'),
      reportFrame('r1', '$RID:0'),
      reportFrame('r1', '$RID:1'),
      reportFrame('r1', '$RID:99'),
      reportFrame('r1', 'bad'),
      rawFrame({ op: 'ack', requestId: 'r1', binding: mergedBinding(7), receiptId: '$RID', sha256: '$RID', chunks: 1, bytes: 1 }),
    ],
  },
  {
    name: 'the busy answer covers writes and reads',
    busy: true,
    frames: [frame('enqueue', 'r1'), frame('status', 'r2'), frame('retry-capability', 'r-retry')],
  },
];

function reportFrame(requestId: string, cursor: string | null): string {
  return rawFrame({
    op: 'report',
    requestId,
    binding: mergedBinding(7),
    receiptId: '$RID',
    cursor,
  });
}

function json(value: unknown): JsonValue {
  return parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
}

interface Outcome {
  readonly responses: readonly (string | null)[];
  readonly queue: unknown;
  readonly receipts: Readonly<Record<string, string>>;
  readonly wrapper: string | null;
  readonly wrapperKey: string | null;
}

function pythonOutcome(item: Case): Outcome {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({
      policy: item.policy ?? policy,
      principal: item.principal ?? 'p',
      queue: item.queue ?? { items: [] },
      forge: { '7': forge(7), '8': forge(8) },
      frames: item.frames,
      busy: item.busy ?? false,
      reconcile: item.reconcile ?? null,
    }),
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout) as {
    responses: ({ ok: true; b64: string } | { ok: false; error: string })[];
    queue: unknown;
    receipts: Record<string, string>;
    wrapper: string | null;
    wrapperKey: string | null;
  };
  return {
    responses: parsed.responses.map((r) =>
      r.ok ? Buffer.from(r.b64, 'base64').toString('utf8') : null,
    ),
    queue: parsed.queue,
    receipts: parsed.receipts,
    wrapper: parsed.wrapper,
    wrapperKey: parsed.wrapperKey,
  };
}

async function tsOutcome(item: Case, oracle: Outcome): Promise<Outcome> {
  let queue = json(item.queue ?? { items: [] }) as JsonObject;
  const receiptBytes = new Map(
    Object.entries(oracle.receipts).map(([id, b64]) => [id, new Uint8Array(Buffer.from(b64, 'base64'))]),
  );
  const journals = new Map<string, JsonObject>();
  let lastReceipt = '';
  const effects: QueueCapabilityEffects = {
    projectFixed: false,
    nowIso: () => '2026-11-13T00:00:00Z',
    nowMicros: () => BigInt(NOW_SECONDS) * 1_000_000n,
    // The oracle's runner has no queue file, so Python hashes the queue itself.
    queueGeneration: async () => null,
    loadQueue: async () => queue,
    saveQueue: async (next) => {
      queue = next;
    },
    withQueueLock: async (work) => (item.busy === true ? null : work()),
    withReadSlot: async (work) => (item.busy === true ? null : work()),
    readReceipt: async (id) => {
      const data = receiptBytes.get(id);
      if (data === undefined) throw new Error('no such receipt');
      return data;
    },
    receiptSize: async (id) => {
      const data = receiptBytes.get(id);
      if (data === undefined) throw new Error('no such receipt');
      return data.length;
    },
    readJournal: async (key) => journals.get(key) ?? null,
    updateJournal: async (key, update) => {
      journals.set(key, update(journals.get(key) ?? null));
    },
    withForgeCache: async (_key, check) => check(),
    reconcilePath: (key) => `/state/reconcile/${key}.json`,
    readReconcileWrapperText: async (path) => {
      if (oracle.wrapper === null || path !== `/state/reconcile/${oracle.wrapperKey}.json`) {
        throw new Error('no reconcile wrapper');
      }
      return oracle.wrapper;
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
  for (const step of item.frames) {
    if (typeof step !== 'string') {
      const id = [...receiptBytes.keys()][0];
      if (id === undefined) throw new Error('oracle published no receipt');
      lastReceipt = id;
      const items = queue.get('items') as JsonValue[];
      const first = items[0] as JsonObject;
      const kept = first.entries.filter(([k]) => k !== 'state' && k !== 'receipt_id');
      items[0] = new JsonObject([...kept, ['state', 'done'], ['receipt_id', id]]);
      continue;
    }
    const raw = step.replaceAll('$RID', lastReceipt);
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
      const expected = pythonOutcome(item);
      const actual = await tsOutcome(item, expected);
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
