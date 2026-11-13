// The queue-v1 capability served through the existing TypeScript queue client:
// the client builds the wire frame, the capability answers it, and the client
// parses the response. Nothing here asserts live acceptance.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { makeQueueClient } from '../../../src/ops/review/internal/queueClient.js';
import type { QueueTransport } from '../../../src/ops/review/internal/queueProtocol.js';
import {
  runQueueCapability,
  type QueueCapabilityEffects,
} from '../../../src/ops/crq/queueCapability.js';
import { runQueueCapabilityMain } from '../../../src/adapters/crq/queueCapabilityMain.js';
import {
  createQueueEffects,
  queueBytes,
  queueEffectPaths,
  verifyDeferredSource,
} from '../../../src/adapters/crq/queueEffects.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { projectInventory } from '../../../src/policy/crq/queueInventory.js';
import { ReceiptSnapshot } from '../../../src/policy/crq/queueReceipt.js';
import {
  receiptJsonDigest,
  receiptJsonText,
  sha256Hex,
} from '../../../src/policy/crq/pythonJson.js';

const REPO = 'owner/repo';
const PRINCIPAL = 'client-a';
const MERGE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const selectors = { repo: REPO, targetSelector: 'promoted-main' } as const;
/** 2026-11-13T00:00:00Z, the clock every case shares. */
const NOW_SECONDS = 1_794_528_000;
const NOW_MICROS = BigInt(NOW_SECONDS) * 1_000_000n;

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function json(value: unknown): JsonValue {
  return parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
}

function object(value: unknown): JsonObject {
  const parsed = json(value);
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

function emptyQueue(): JsonObject {
  return object({ items: [], merged_current_requests: {}, queue_client_requests: {} });
}

function policy(overrides: Record<string, unknown> = {}): unknown {
  // Operator policy bytes are lossless JSON: every integer stays a Python int.
  return object({
    enabled: true,
    repo: REPO,
    read: [PRINCIPAL],
    write: [PRINCIPAL],
    targets: ['promoted-main'],
    branches: ['main'],
    health_reads: [{ principal: PRINCIPAL, binding: selectors }],
    ...overrides,
  });
}

const mergedRef = {
  requestId: 'req-merged',
  binding: {
    kind: 'merged-current',
    repo: REPO,
    targetSelector: 'promoted-main',
    pr: 7,
    mergeSha: MERGE,
  },
} as const;

interface Harness {
  readonly effects: QueueCapabilityEffects;
  readonly transport: QueueTransport;
  readonly state: {
    queue: JsonObject;
    generation: number;
    saved: JsonObject[];
    forge: Map<number, JsonValue>;
  };
  call(body: string, overrides?: { policy?: unknown; principal?: string }): Promise<unknown>;
}

function harness(options: {
  queue?: JsonObject;
  receipts?: readonly JsonObject[];
  forge?: Map<number, JsonValue>;
}): Harness {
  const receiptBytes = new Map<string, Uint8Array>();
  for (const document of options.receipts ?? []) {
    const bytes = new TextEncoder().encode(receiptJsonText(document));
    receiptBytes.set(sha256Hex(bytes), bytes);
  }
  const state = {
    queue: options.queue ?? emptyQueue(),
    generation: 1,
    saved: [] as JsonObject[],
    forge: options.forge ?? new Map<number, JsonValue>(),
  };
  const effects: QueueCapabilityEffects = {
    projectFixed: false,
    nowIso: () => '2026-11-13T00:00:00Z',
    nowMicros: () => NOW_MICROS,
    queueGeneration: async () => json([1, 2, state.generation, 4]),
    loadQueue: async () => state.queue,
    saveQueue: async (queue) => {
      state.saved.push(queue);
      state.queue = queue;
      state.generation += 1;
    },
    withQueueLock: async (work) => work(),
    withReadSlot: async (work) => work(),
    readReceipt: async (receiptId, maxBytes) => {
      const bytes = receiptBytes.get(receiptId);
      if (bytes === undefined) throw new Error('missing receipt');
      return bytes.subarray(0, maxBytes + 1);
    },
    receiptSize: async (receiptId) => receiptBytes.get(receiptId)?.length ?? 0,
    readJournal: async () => null,
    updateJournal: async () => {},
    withForgeCache: async (_key, check) => check(),
    reconcilePath: (key) => `/state/reconcile/${key}.json`,
    readReconcileWrapperText: async () => {
      throw new Error('no reconcile wrapper in this harness');
    },
    verifySource: async (_repo, pr) => {
      const value = state.forge.get(pr);
      if (value === undefined) throw new Error('no forge metadata');
      return value;
    },
    runDir: (runId) => `/runs/${runId}`,
    hasExit: async () => false,
    readPidfile: async () => null,
    runLiveness: async () => 'ambiguous',
  };
  async function call(
    body: string,
    overrides: { policy?: unknown; principal?: string } = {},
  ): Promise<unknown> {
    const response = await runQueueCapability(
      {
        raw: new TextEncoder().encode(body),
        principal: overrides.principal ?? PRINCIPAL,
        policy: overrides.policy ?? policy(),
        runnerRepo: REPO,
      },
      effects,
    );
    return new TextDecoder().decode(response);
  }
  return {
    effects,
    transport: (wire) => call(wire) as Promise<string>,
    state,
    async call(body, overrides) {
      return JSON.parse((await call(body, overrides)) as string) as unknown;
    },
  };
}

function forgeMetadata(overrides: Record<string, unknown> = {}): JsonObject {
  return object({
    repo: REPO,
    pr: 7,
    producer: 'author',
    head: HEAD,
    target: 'main',
    state: 'MERGED',
    mergeSha: MERGE,
    ...overrides,
  });
}

describe('queue-v1 capability wire', () => {
  test('health answers canonical bytes and the client parses them', async () => {
    const queue = object({
      items: [],
      client_health: {
        completed_at: '2026-11-12T23:59:00Z',
        complete: true,
        incomplete_ticks: 0,
        sha: HEAD,
      },
    });
    const h = harness({ queue });
    const healthRef = { requestId: 'health-1', binding: selectors };
    const frame = `${JSON.stringify({ v: 1, op: 'health', ...healthRef })}\n`;
    const expected =
      '{"binding":{"repo":"owner/repo","targetSelector":"promoted-main"},"requestId":"health-1","result":{"ageSeconds":60.0,"blocked":0,"deployedSha":"' +
      HEAD +
      '","discoveryComplete":true,"incompleteTicks":0,"lastCompletedTick":"2026-11-12T23:59:00Z","pending":0,"snapshot":"' +
      receiptJsonDigest({ principal: PRINCIPAL, queue: json([1, 2, 1, 4]) }) +
      '"},"v":1}\n';
    expect(await h.transport(frame)).toBe(expected);
    await expect(makeQueueClient(h.transport).health(healthRef)).resolves.toMatchObject({
      ageSeconds: 60,
      discoveryComplete: true,
      pending: 0,
      blocked: 0,
      deployedSha: HEAD,
    });
  });

  test('enqueue enrolls a merged-current item and status reports it ready', async () => {
    const forge = new Map<number, JsonValue>([[7, forgeMetadata()]]);
    const h = harness({ forge });
    const status = await makeQueueClient(h.transport).enqueue(mergedRef);
    // The bounded projection reads the enrolled item's state, not the entry label.
    expect(status).toMatchObject({
      state: 'pending',
      pr: 7,
      mergeSha: MERGE,
      enqueued: true,
      reviewed: false,
    });
    const saved = h.state.saved.at(-1) as JsonObject;
    const mapping = (saved.get('merged_current_requests') as JsonObject).get(
      'req-merged',
    ) as JsonObject;
    const itemId = mapping.get('item');
    expect(mapping.get('binding')).toBeInstanceOf(JsonObject);
    const items = saved.get('items') as JsonValue[];
    expect(items.some((item) => (item as JsonObject).get('id') === itemId)).toBe(true);
    const entry = (saved.get('queue_client_requests') as JsonObject).get(
      'req-merged',
    ) as JsonObject;
    expect(entry.get('principal')).toBe(PRINCIPAL);
    expect(entry.get('state')).toBe('ready-current');
    expect(entry.get('pr')).toBeInstanceOf(JsonNumber);
    expect(entry.get('createdAt')).toBe('2026-11-13T00:00:00Z');
  });

  test('a forge mismatch refuses enrollment and saves nothing', async () => {
    const forge = new Map<number, JsonValue>([[7, forgeMetadata({ mergeSha: 'd'.repeat(40) })]]);
    const h = harness({ forge });
    await expect(makeQueueClient(h.transport).enqueue(mergedRef)).rejects.toThrow();
    expect(h.state.saved).toEqual([]);
  });

  test('status reflects a verified terminal receipt and its bounded source', async () => {
    const subject = {
      repo: REPO,
      pr: 7,
      merge_sha: MERGE,
      target_selector: 'promoted-main',
      policy: 'affected-current-additions-v1',
    };
    const itemId = `current-${receiptJsonDigest(object(subject)).slice(0, 32)}`;
    const document = object({
      version: 1,
      request_id: 'req-merged',
      item_id: itemId,
      source: subject,
      capture: { equivalence: 'e'.repeat(64) },
      outcome: 'terminal-clean',
      counted: true,
      classification: { outcome: 'completed', counted: true },
    });
    const receiptId = sha256Hex(new TextEncoder().encode(receiptJsonText(document)));
    const queue = object({
      items: [
        {
          id: itemId,
          kind: 'merged-current',
          pr: 7,
          merge_commit: MERGE,
          subject,
          request_id: 'req-merged',
          state: 'reviewing',
          receipt_id: receiptId,
          attempts: [],
        },
      ],
      merged_current_requests: { 'req-merged': { binding: subject, item: itemId } },
      queue_client_requests: {
        'req-merged': {
          binding: mergedRef.binding,
          principal: PRINCIPAL,
          state: 'ready-current',
          pr: 7,
          mergeSha: MERGE,
          createdAt: '2026-11-13T00:00:00Z',
        },
      },
    });
    const h = harness({ queue, receipts: [document] });
    const status = await makeQueueClient(h.transport).status(mergedRef);
    expect(status).toMatchObject({
      state: 'terminal-clean',
      reviewed: true,
      consumed: false,
      fixed: false,
      receiptId,
      itemId,
      receiptSource: {
        kind: 'merged-current',
        repo: REPO,
        pr: 7,
        mergeSha: MERGE,
        targetSelector: 'promoted-main',
      },
    });
    expect(status.snapshot).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a changed queue generation answers busy instead of a stale snapshot', async () => {
    const h = harness({});
    const generation = h.effects.queueGeneration;
    let calls = 0;
    const effects: QueueCapabilityEffects = {
      ...h.effects,
      queueGeneration: async () => {
        calls += 1;
        return calls === 1 ? generation() : json([1, 2, 99, 4]);
      },
    };
    const response = await runQueueCapability(
      {
        raw: new TextEncoder().encode(
          `${JSON.stringify({ v: 1, op: 'health', requestId: 'health-1', binding: selectors })}\n`,
        ),
        principal: PRINCIPAL,
        policy: policy(),
        runnerRepo: REPO,
      },
      effects,
    );
    expect(JSON.parse(new TextDecoder().decode(response))).toMatchObject({
      result: { error: { code: 'busy', retryable: true } },
    });
  });

  test('a disabled policy answers unsupported and a denied probe answers no-permission', async () => {
    const h = harness({});
    const unsupported = await h.call(`${JSON.stringify({ v: 1, op: 'status', ...mergedRef })}\n`, {
      policy: policy({ enabled: false }),
    });
    expect(unsupported).toMatchObject({
      result: { unsupported: 'Reviewed D1C queue-v1 activation required' },
    });
    const denied = await h.call(
      `${JSON.stringify({ v: 1, op: 'retry-capability', ...mergedRef })}\n`,
      { principal: 'stranger' },
    );
    expect(denied).toMatchObject({ result: { denied: 'no-permission' } });
  });

  test('a retry-capability grant answers the retry protocol version', async () => {
    const h = harness({});
    const granted = await h.call(
      `${JSON.stringify({ v: 1, op: 'retry-capability', ...mergedRef })}\n`,
      {
        policy: policy({
          transient_retries: [
            { principal: PRINCIPAL, requestId: 'req-merged', binding: mergedRef.binding },
          ],
        }),
      },
    );
    expect(granted).toMatchObject({ result: { retry: 1 } });
  });

  test('an unknown request id is refused, not adopted', async () => {
    const h = harness({});
    await expect(makeQueueClient(h.transport).status(mergedRef)).rejects.toThrow();
    expect(h.state.saved).toEqual([]);
  });
});

describe('queue-v1 forced-command gate', () => {
  async function runnerRoot(policyDocument: unknown): Promise<{
    root: string;
    policyPath: string;
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'crq-capability-'));
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ repo: REPO, queue: { project_fixed: false } }),
    );
    const policyPath = join(dir, 'policy.json');
    await writeFile(policyPath, receiptJsonText(policyDocument as JsonValue));
    return { root: dir, policyPath };
  }

  function deps(input: {
    root: string;
    policyPath: string;
    argv?: readonly string[];
    env?: Record<string, string | undefined>;
    frame?: string;
  }): {
    argv: readonly string[];
    env: (name: string) => string | undefined;
    readStdin: () => Promise<Uint8Array>;
    stdout: (bytes: Uint8Array) => void;
    stderr: (message: string) => void;
    root: string;
  } {
    const env: Record<string, string | undefined> = {
      CRQ_QUEUE_POLICY: input.policyPath,
      CRQ_QUEUE_PRINCIPAL: PRINCIPAL,
      ...input.env,
    };
    return {
      argv: input.argv ?? [],
      env: (name) => env[name],
      readStdin: async () => new TextEncoder().encode(input.frame ?? ''),
      stdout: () => {},
      stderr: () => {},
      root: input.root,
    };
  }

  test('refuses arguments, a foreign capability, missing identity and a malformed frame', async () => {
    const { root, policyPath } = await runnerRoot(policy());
    const cases = [
      deps({ root, policyPath, argv: ['extra'] }),
      deps({ root, policyPath, env: { SSH_ORIGINAL_COMMAND: 'author-v1' } }),
      deps({ root, policyPath, env: { CRQ_QUEUE_PRINCIPAL: undefined } }),
      deps({
        root,
        policyPath,
        env: { SSH_ORIGINAL_COMMAND: 'queue-v1' },
        frame: '{not json',
      }),
    ];
    for (const item of cases) expect(await runQueueCapabilityMain(item)).toBe(2);
  });

  test('serves the allowlisted capability and writes the response bytes', async () => {
    const { root, policyPath } = await runnerRoot(
      policy({
        transient_retries: [
          { principal: PRINCIPAL, requestId: 'req-merged', binding: mergedRef.binding },
        ],
      }),
    );
    const written: Uint8Array[] = [];
    const exitCode = await runQueueCapabilityMain({
      ...deps({
        root,
        policyPath,
        env: { SSH_ORIGINAL_COMMAND: 'queue-v1' },
        frame: `${JSON.stringify({ v: 1, op: 'retry-capability', ...mergedRef })}\n`,
      }),
      stdout: (bytes) => written.push(bytes),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(written[0]))).toMatchObject({
      result: { retry: 1 },
    });
  });
});

describe('queue effects adapter', () => {
  async function stateDir(): Promise<ReturnType<typeof queueEffectPaths>> {
    const dir = await mkdtemp(join(tmpdir(), 'crq-effects-'));
    tempDirs.push(dir);
    const paths = queueEffectPaths(dir);
    await mkdir(paths.stateRoot, { recursive: true });
    return paths;
  }

  test('loads a queue document and rewrites Python queue bytes', async () => {
    const paths = await stateDir();
    await writeFile(paths.queuePath, '{"items":[],"version":3}\n');
    const effects = createQueueEffects({ repo: REPO, ...paths, now: () => new Date(0) });
    expect(queueBytes(await effects.loadQueue())).toBe('{\n  "items": [],\n  "version": 3\n}\n');
    await effects.saveQueue(object({ items: [], version: 4 }));
    expect(await readFile(paths.queuePath, 'utf8')).toBe('{\n  "items": [],\n  "version": 4\n}\n');
    expect(await effects.queueGeneration()).toHaveLength(4);
  });

  test('refuses a queue that still needs the Python compaction pass', async () => {
    const paths = await stateDir();
    await writeFile(paths.queuePath, '{"backfill_admissions":[{"request_id":"a"}],"items":[]}\n');
    const effects = createQueueEffects({ repo: REPO, ...paths });
    await expect(effects.loadQueue()).rejects.toThrow(/Python runner/);
  });

  test('verify_deferred_source validates forge identity and maps the fields', async () => {
    const ghResult = (payload: unknown) => async () => ({
      code: 0,
      stdout: JSON.stringify(payload),
      stderr: '',
    });
    const identity = await verifyDeferredSource(
      ghResult({
        number: 7,
        state: 'closed',
        merged: true,
        merge_commit_sha: MERGE,
        base: { ref: 'main', repo: { full_name: REPO } },
        head: { sha: HEAD },
        user: { login: 'author' },
      }),
      REPO,
      7,
    );
    expect(identity.get('repo')).toBe(REPO);
    expect(identity.get('pr')).toBeInstanceOf(JsonNumber);
    expect(identity.get('producer')).toBe('author');
    expect(identity.get('head')).toBe(HEAD);
    expect(identity.get('target')).toBe('main');
    expect(identity.get('state')).toBe('MERGED');
    expect(identity.get('mergeSha')).toBe(MERGE);
    const pending = await verifyDeferredSource(
      ghResult({
        number: 7,
        state: 'open',
        merged: false,
        base: { ref: 'main', repo: { full_name: REPO } },
        head: { sha: HEAD },
        user: { login: 'author' },
      }),
      REPO,
      7,
    );
    expect(pending.get('mergeSha')).toBeNull();
    expect(pending.get('state')).toBe('OPEN');
    await expect(
      verifyDeferredSource(
        ghResult({
          number: 8,
          state: 'closed',
          merged: true,
          merge_commit_sha: MERGE,
          base: { ref: 'main', repo: { full_name: REPO } },
          head: { sha: HEAD },
          user: { login: 'author' },
        }),
        REPO,
        7,
      ),
    ).rejects.toThrow(/forge PR identity/);
  });
});

describe('queue-v1 interval inventory projection', () => {
  const subject = {
    repo: REPO,
    pr: 7,
    merge_sha: MERGE,
    target_selector: 'promoted-main',
    policy: 'affected-current-additions-v1',
  };
  const itemId = `current-${receiptJsonDigest(object(subject)).slice(0, 32)}`;
  const document = object({
    version: 1,
    request_id: 'req-merged',
    item_id: itemId,
    source: subject,
    capture: { equivalence: 'e'.repeat(64) },
    outcome: 'terminal-clean',
    counted: true,
    classification: { outcome: 'completed', counted: true },
  });
  const bytes = new TextEncoder().encode(receiptJsonText(document));
  const receiptId = sha256Hex(bytes);
  const binding = {
    repo: REPO,
    targetSelector: 'promoted-main',
    after: '2026-01-01T00:00:00Z',
    before: '2026-11-13T00:00:00Z',
  } as const;

  function state(consumed: boolean): JsonObject {
    return object({
      items: [
        {
          id: itemId,
          kind: 'merged-current',
          pr: 7,
          merge_commit: MERGE,
          subject,
          request_id: 'req-merged',
          state: 'reviewing',
          receipt_id: receiptId,
          attempts: [],
        },
      ],
      merged_current_requests: { 'req-merged': { binding: subject, item: itemId } },
      queue_client_requests: {
        'req-merged': {
          binding: mergedRef.binding,
          principal: PRINCIPAL,
          state: 'ready-current',
          pr: 7,
          mergeSha: MERGE,
          createdAt: '2026-11-13T00:00:00Z',
          ...(consumed ? { consumed: receiptId } : {}),
        },
      },
    });
  }

  const checkpoint = object({
    complete: true,
    dry_run: false,
    digest: 'f'.repeat(64),
    before: '2026-11-13T00:00:00Z',
    inventory: [{ pr: 7, merge_sha: MERGE }],
  });

  function projection(queue: JsonObject, projectFixed: boolean, cursor: string | null = null) {
    return projectInventory({
      queue,
      checkpoint,
      binding,
      principal: PRINCIPAL,
      states: null,
      cursor,
      limit: 10,
      projectFixed,
      effects: {
        statSize: async () => bytes.length,
        snapshot: async (id, maxBytes) => new ReceiptSnapshot(id, bytes, maxBytes),
      },
    });
  }

  test('projects a consumed receipt row and its proof', async () => {
    const result = await projection(state(true), false);
    const entries = result.get('entries') as unknown as Record<string, JsonValue>[];
    expect(entries).toHaveLength(1);
    const row = entries[0] as Record<string, JsonValue>;
    expect(row.state).toBe('consumed');
    expect(row.requestId).toBe('req-merged');
    expect(row.itemId).toBe(itemId);
    expect(result.get('terminal')).toBe(true);
    expect(result.get('nextCursor')).toBeNull();
    const proof = result.get('proof') as JsonObject;
    expect(proof.get('completeThrough')).toBe('2026-11-13T00:00:00Z');
    expect(proof.get('intervalConvention')).toBe('(after,before]');
    expect(proof.get('selectedCount')).toBeInstanceOf(JsonNumber);
  });

  test('a project_fixed projection adds the review and repair facts', async () => {
    const result = await projection(state(true), true);
    const row = (result.get('entries') as unknown as Record<string, JsonValue>[])[0] as Record<
      string,
      JsonValue
    >;
    expect(row.reviewed).toBe(true);
    expect(row.consumed).toBe(true);
    expect(row.fixed).toBe(false);
    expect(row.state).toBe('consumed');
  });

  test('a cursor from another snapshot is refused as stale', async () => {
    const result = await projection(state(true), false, `${'a'.repeat(64)}:0`);
    const error = result.get('error') as JsonObject;
    expect(error.get('code')).toBe('stale-cursor');
    expect(error.get('retryable')).toBe(false);
    expect(error.get('restart')).toBe(true);
  });
});
