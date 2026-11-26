/**
 * Differential for `Inbox.deliver`, `repair_transport`,
 * `configured_repair_transport` and `canonical_rounds`.
 *
 * `apps/crq-python/finding_delivery_vectors.py` drives the real Python over a
 * temporary root with a stub queue and injected scans, and records per step
 * the return or exception class, every injected-seam call, the lock/write/
 * spool order, the queue and every file the step left behind. Here the same
 * specs run through one in-memory file tree and must reproduce every fact,
 * including that nothing outside the sandbox is addressed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { LedgerIntegrityError, ledgerLoads } from '../../../src/policy/crq/ledger.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import { pythonStr } from '../../../src/policy/crq/prReviewFindings.js';
import {
  FindingDelivery,
  type FindingDeliveryFiles,
  type RetainedSnapshot,
} from '../../../src/ops/review/internal/crq/findingDelivery.js';
import {
  canonicalRounds,
  configuredRepairTransport,
  makeRepairTransport,
  type ConfiguredRuntime,
  type ConfiguredTransportContext,
  type QueueCell,
} from '../../../src/ops/review/internal/crq/repairTransport.js';
import { PythonFileNotFoundError } from '../../../src/ops/review/internal/crq/pythonValues.js';
import type { ArtifactVerifier, OutboxFiles } from '../../../src/ops/review/internal/crq/outbox.js';
import { Outbox } from '../../../src/ops/review/internal/crq/outbox.js';

const CASES_URL = new URL(
  '../../../apps/crq-python/fixtures/crq-finding-delivery/cases.json',
  import.meta.url,
);
const encoder = new TextEncoder();
const FINDINGS = 'state/backfill/findings';
const PENDING = 'state/backfill/publication/pending';
const ACK = 'state/backfill/publication/ack';
const REPAIR = 'state/repair';
const INBOX = 'state/repair/inbox';

function obj(value: JsonValue | undefined, what: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${what}: expected an object`);
  return value;
}
function arr(value: JsonValue | undefined, what: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}
function str(value: JsonValue | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what}: expected a string`);
  return value;
}
function optionalObject(value: JsonValue | undefined): JsonObject {
  return value === undefined ? new JsonObject([]) : obj(value, 'object');
}
function plain(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : value;
}

/** Sorted compact ASCII JSON, Python's `json.dumps(sort_keys, separators)`. */
function text(value: JsonValue): string {
  return pythonJsonText(value as never, {
    asciiOnly: true,
    sortKeys: true,
    spacedSeparators: false,
  });
}

/** Python's `StubError(RuntimeError)`: a transport or scan seam that refuses. */
class StubError extends Error {
  readonly pythonError = 'StubError';
}

class Trace {
  readonly entries: string[] = [];
}

const SANDBOX_ROOT = '/sandbox';

/**
 * Every path a seam addresses, resolved against the sandbox root: a path that
 * is absolute, carries a `..` segment or resolves outside the root is an escape.
 */
class ContainedFiles extends Map<string, Uint8Array> {
  readonly escapes: string[] = [];

  private check(path: string): void {
    const resolved = posix.resolve(SANDBOX_ROOT, path);
    const inside = resolved.startsWith(`${SANDBOX_ROOT}/`);
    if (posix.isAbsolute(path) || path.split('/').includes('..') || !inside) {
      this.escapes.push(path);
    }
  }

  override get(path: string): Uint8Array | undefined {
    this.check(path);
    return super.get(path);
  }

  override has(path: string): boolean {
    this.check(path);
    return super.has(path);
  }

  override set(path: string, data: Uint8Array): this {
    this.check(path);
    return super.set(path, data);
  }
}

/** One sandbox: every path is relative to it, so nothing outside can exist. */
class Sandbox {
  readonly files = new ContainedFiles();

  /** SHA-256 of the exact bytes of every file `tree()` lists. */
  digests(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of this.tree()) {
      const data = this.files.get(path) as Uint8Array;
      out[path] = createHash('sha256').update(data).digest('hex');
    }
    return out;
  }

  /** `Path.parent.name + "/" + Path.name`, the shape the Python trace records. */
  static traceName(path: string): string {
    const parts = path.split('/');
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  /** `sorted(directory.glob("*.json"))`: direct children ending in `.json`. */
  directJson(directory: string): string[] {
    const names: string[] = [];
    for (const path of this.files.keys()) {
      if (!path.startsWith(`${directory}/`)) continue;
      const rest = path.slice(directory.length + 1);
      if (!rest.includes('/') && rest.endsWith('.json')) names.push(rest);
    }
    return names.sort();
  }

  dirText(directory: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.directJson(directory)) {
      const data = this.files.get(`${directory}/${name}`) as Uint8Array;
      let rendered: string;
      try {
        rendered = text(ledgerLoads(data));
      } catch {
        rendered = `hex:${Buffer.from(data).toString('hex')}`;
      }
      out[name.slice(0, -'.json'.length)] = rendered;
    }
    return out;
  }

  /** Files other than lock files and temp files, in `Path` sort order. */
  tree(): string[] {
    const out = [...this.files.keys()].filter((path) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      return !name.endsWith('.lock') && !name.startsWith('tmp');
    });
    return out.sort((a, b) => {
      const left = a.split('/');
      const right = b.split('/');
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        const x = left[index] as string;
        const y = right[index] as string;
        if (x !== y) return x < y ? -1 : 1;
      }
      return left.length - right.length;
    });
  }
}

class MemoryFiles implements FindingDeliveryFiles {
  private locked = false;
  constructor(
    private readonly sandbox: Sandbox,
    private readonly trace: Trace,
  ) {}

  private write(path: string, bytes: Uint8Array): void {
    this.trace.entries.push(`write:${Sandbox.traceName(path)}`);
    this.sandbox.files.set(path, bytes);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.trace.entries.push('lock:findings.lock');
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      this.trace.entries.push('unlock:findings.lock');
    }
  }
  async readTriage(findingId: string): Promise<Uint8Array | null> {
    if (!this.locked) throw new Error('readTriage outside withLock');
    return this.sandbox.files.get(`${FINDINGS}/triage/${findingId}.json`) ?? null;
  }
  async writeTriage(findingId: string, bytes: Uint8Array): Promise<void> {
    if (!this.locked) throw new Error('writeTriage outside withLock');
    this.write(`${FINDINGS}/triage/${findingId}.json`, bytes);
  }
  async readRequest(key: string): Promise<Uint8Array | null> {
    return this.sandbox.files.get(`${FINDINGS}/delivery/${key}.json`) ?? null;
  }
  async writeRequest(key: string, bytes: Uint8Array): Promise<void> {
    this.write(`${FINDINGS}/delivery/${key}.json`, bytes);
  }
  async readReceipt(key: string): Promise<Uint8Array | null> {
    return this.sandbox.files.get(`${FINDINGS}/receipts/${key}.json`) ?? null;
  }
  async writeReceipt(key: string, bytes: Uint8Array): Promise<void> {
    this.write(`${FINDINGS}/receipts/${key}.json`, bytes);
  }
  async readRepairInbox(job: string): Promise<Uint8Array | null> {
    return this.sandbox.files.get(`${INBOX}/${job}.json`) ?? null;
  }
  async writeRepairInbox(job: string, bytes: Uint8Array): Promise<void> {
    this.write(`${INBOX}/${job}.json`, bytes);
  }
  async listRetained(job: string): Promise<readonly RetainedSnapshot[]> {
    const prefix = `${REPAIR}/${job}/`;
    const out: RetainedSnapshot[] = [];
    for (const path of this.sandbox.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const parts = path.slice(prefix.length).split('/');
      if (parts.length < 2 || parts[parts.length - 1] !== 'manifest.json') continue;
      const directory = parts.slice(0, -1);
      if (!(directory[directory.length - 1] as string).startsWith('retained-')) continue;
      out.push(this.snapshot(prefix, directory));
    }
    return out;
  }
  private snapshot(prefix: string, directory: readonly string[]): RetainedSnapshot {
    const base = `${prefix}${directory.join('/')}`;
    const sandbox = this.sandbox;
    const read = (name: string): Uint8Array => {
      const found = sandbox.files.get(`${base}/${name}`);
      if (found === undefined) throw new PythonFileNotFoundError(`${base}/${name}`);
      return found;
    };
    return {
      directory,
      async readManifest() {
        return read('manifest.json');
      },
      async patchSize(name) {
        return read(name).length;
      },
      async readPatch(name) {
        return read(name);
      },
    };
  }
}

class MemoryOutboxFiles implements OutboxFiles {
  private locked = false;
  constructor(
    private readonly sandbox: Sandbox,
    private readonly trace: Trace,
  ) {}

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.trace.entries.push('lock:outbox.lock');
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      this.trace.entries.push('unlock:outbox.lock');
    }
  }
  async listPending(): Promise<readonly string[]> {
    return this.sandbox.directJson(PENDING).map((name) => name.slice(0, -'.json'.length));
  }
  async readPending(id: string): Promise<Uint8Array | null> {
    return this.sandbox.files.get(`${PENDING}/${id}.json`) ?? null;
  }
  async writePending(id: string, bytes: Uint8Array): Promise<void> {
    if (!this.locked) throw new Error('writePending outside outbox lock');
    this.trace.entries.push(`write:pending/${id}.json`);
    this.sandbox.files.set(`${PENDING}/${id}.json`, bytes);
  }
  async hasAck(id: string): Promise<boolean> {
    return this.sandbox.files.has(`${ACK}/${id}.json`);
  }
  async writeAck(id: string, bytes: Uint8Array): Promise<void> {
    this.sandbox.files.set(`${ACK}/${id}.json`, bytes);
  }
}

/** The vectors hold no artifacts, so every artifact reference fails to verify. */
const NO_ARTIFACTS: ArtifactVerifier = {
  async verify() {
    throw new LedgerIntegrityError('missing or corrupt retained artifact');
  },
};

/** A spec file: canonical JSON, raw bytes, or a filler of one repeated byte. */
function entryBytes(entry: JsonValue): Uint8Array {
  if (entry instanceof JsonObject) {
    const rawHex = entry.get('raw_hex');
    if (rawHex !== undefined) return Uint8Array.from(Buffer.from(str(rawHex, 'raw_hex'), 'hex'));
    const rle = entry.get('rle');
    if (rle !== undefined) {
      const chunks: number[] = [];
      for (const pair of arr(rle, 'rle')) {
        const [value, count] = arr(pair, 'rle pair').map((n) => Number(toPlainJson(n)));
        for (let index = 0; index < (count as number); index += 1) chunks.push(value as number);
      }
      return Uint8Array.from(chunks);
    }
    const fill = entry.get('fill');
    if (fill !== undefined) {
      const [value, count] = arr(fill, 'fill').map((n) => Number(toPlainJson(n)));
      return new Uint8Array(count as number).fill(value as number);
    }
  }
  return encoder.encode(text(entry));
}

function locate(sandbox: Sandbox, spec: JsonObject): void {
  const put = (path: string, entry: JsonValue) => sandbox.files.set(path, entryBytes(entry));
  for (const [fid, row] of optionalObject(spec.get('rows')).entries) {
    put(`${FINDINGS}/triage/${fid}.json`, row);
  }
  for (const [key, value] of optionalObject(spec.get('delivery')).entries) {
    put(`${FINDINGS}/delivery/${key}.json`, value);
  }
  for (const [key, value] of optionalObject(spec.get('receipts')).entries) {
    put(`${FINDINGS}/receipts/${key}.json`, value);
  }
  for (const [job, value] of optionalObject(spec.get('inbox')).entries) {
    put(`${INBOX}/${job}.json`, value);
  }
  for (const [rel, value] of optionalObject(spec.get('repair_files')).entries) {
    put(`${REPAIR}/${rel}`, value);
  }
}

interface Recorder {
  readonly calls: JsonValue[][];
  readonly queueSaves: string[];
}

interface Rig {
  readonly sandbox: Sandbox;
  readonly trace: Trace;
  readonly files: MemoryFiles;
  readonly delivery: FindingDelivery;
  readonly cell: QueueCell;
}

async function build(spec: JsonObject): Promise<Rig> {
  const sandbox = new Sandbox();
  const trace = new Trace();
  const files = new MemoryFiles(sandbox, trace);
  const outbox = new Outbox(new MemoryOutboxFiles(sandbox, trace), NO_ARTIFACTS);
  const publication = {
    async retained(): Promise<JsonValue[]> {
      trace.entries.push('retained');
      return outbox.retained();
    },
    async spool(value: JsonValue): Promise<string> {
      trace.entries.push('spool');
      return outbox.spool(value);
    },
  };
  locate(sandbox, spec);
  const retained = spec.get('retained');
  for (const event of retained === undefined ? [] : arr(retained, 'retained')) {
    await outbox.spool(event);
  }
  const queue = spec.get('queue');
  return {
    sandbox,
    trace,
    files,
    delivery: new FindingDelivery(files, publication),
    cell: { queue: queue === undefined ? new JsonObject([['items', []]]) : queue },
  };
}

type Transport = (key: JsonValue, request: JsonValue) => Promise<JsonValue>;

function makeTransport(spec: JsonObject, rig: Rig, record: Recorder, mode: JsonObject): Transport {
  const kind = str(mode.get('mode'), 'mode');
  const saveQueue = async (value: JsonValue): Promise<void> => {
    record.calls.push(['save_queue']);
    record.queueSaves.push(text(value));
  };
  const clean = (name: string, fallback: JsonValue): JsonValue =>
    spec.has(name) ? plain(spec.get(name)) : fallback;
  if (kind === 'stub') {
    return async (key, request) => {
      record.calls.push(['transport', key, text(request)]);
      return plain(mode.get('receipt'));
    };
  }
  if (kind === 'raise') {
    return async (key, request) => {
      record.calls.push(['transport', key, text(request)]);
      throw new StubError('transport refused');
    };
  }
  if (kind === 'plain') {
    const absent = mode.get('absent') === undefined ? [] : arr(mode.get('absent'), 'absent');
    return makeRepairTransport({
      files: rig.files,
      cell: rig.cell,
      saveQueue,
      maxRoundsPerPin: mode.has('max_rounds')
        ? plain(mode.get('max_rounds'))
        : clean('max_rounds', JsonNumber.int(2)),
      async scan(target, name) {
        record.calls.push(['scan', target, name]);
        return clean('source_clean', true);
      },
      ...(absent.includes('instructions')
        ? {}
        : {
            async scanInstructions(value: JsonValue, target: JsonValue) {
              record.calls.push(['scan_instructions', value, target]);
              const verdict = clean('instructions', true);
              if (verdict === 'raise') throw new StubError('scan_instructions raised');
              return verdict;
            },
          }),
      ...(absent.includes('finding')
        ? {}
        : {
            async scanFinding(value: JsonValue, target: JsonValue, path: JsonValue) {
              record.calls.push(['scan_finding', value, target, path]);
              return clean('finding_clean', true);
            },
          }),
    });
  }
  if (kind === 'configured') {
    const marker = spec.get('deny_marker');
    const context: ConfiguredTransportContext = {
      config: spec.has('config')
        ? plain(spec.get('config'))
        : new JsonObject([['repair', new JsonObject([])]]),
      saveQueue,
      async secretScan(base, head, relpath) {
        record.calls.push(['secret_scan', base, head, relpath]);
        return spec.has('scan_return')
          ? plain(spec.get('scan_return'))
          : [clean('source_clean', true), null];
      },
      async secretScanDiff(patch, base, head, relpath) {
        record.calls.push(['secret_scan_diff', patch, base, head, relpath]);
        const key = relpath.endsWith('repair-instructions-scan.json')
          ? 'instructions_return'
          : 'diff_return';
        if (spec.has(key)) return plain(spec.get(key));
        return [!(typeof marker === 'string' && patch.includes(marker)), null];
      },
    };
    const runtime: ConfiguredRuntime = {
      async projection(repo, target, names) {
        record.calls.push(['projection', repo, target, [...names]]);
        return [`base-${pythonStr(target)}`, `head-${pythonStr(target)}`];
      },
    };
    return configuredRepairTransport(context, 'repo', rig.files, rig.cell, runtime);
  }
  throw new Error(`unknown transport mode ${kind}`);
}

interface Outcome {
  returns?: string;
  raises?: string;
  message?: string;
}

async function runStep(
  spec: JsonObject,
  rig: Rig,
  record: Recorder,
  step: JsonObject,
): Promise<Outcome> {
  const method = str(step.get('method'), 'method');
  const args = arr(step.get('args'), 'args');
  try {
    const transport = makeTransport(
      spec,
      rig,
      record,
      step.has('transport')
        ? obj(step.get('transport'), 'transport')
        : new JsonObject([['mode', 'plain']]),
    );
    if (method === 'deliver') {
      const value = await rig.delivery.deliver(
        args[0] as string,
        transport as never,
        args[1] as string,
      );
      return { returns: text(value) };
    }
    if (method === 'accept') {
      return { returns: text(await transport(args[0] as JsonValue, args[1] as JsonValue)) };
    }
    if (method === 'canonical_rounds') {
      const kwargs = optionalObject(step.get('kwargs'));
      const rounds = await canonicalRounds(
        rig.files,
        rig.cell.queue,
        args[0] as JsonValue,
        args[1] as JsonValue,
        plain(kwargs.get('exclude_job')),
      );
      return { returns: String(rounds) };
    }
    throw new Error(`unknown method ${method}`);
  } catch (error) {
    const name = (error as { pythonError?: unknown }).pythonError;
    if (typeof name !== 'string') throw error;
    return { raises: name, message: (error as Error).message };
  }
}

function sortedPlain(value: JsonValue | undefined): unknown {
  const plainValue = toPlainJson(plain(value)) as Record<string, unknown> | null;
  if (plainValue === null) return {};
  return Object.fromEntries(Object.entries(plainValue).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const document = obj(parseJsonValue(readFileSync(CASES_URL, 'utf-8')), 'cases');
const cases = arr(document.get('cases'), 'cases');

describe('finding delivery oracle vectors', () => {
  test('the fixture carries the expected schema and a non-trivial case count', () => {
    expect(document.get('schema')).toBe('cq.finding-delivery-vectors/v1');
    expect(cases.length).toBeGreaterThanOrEqual(300);
  });

  for (const raw of cases) {
    const entry = obj(raw, 'case');
    const name = str(entry.get('name'), 'name');
    test(name, async () => {
      const spec = obj(entry.get('spec'), 'spec');
      const expected = arr(obj(entry.get('result'), 'result').get('steps'), 'steps');
      const steps = arr(spec.get('steps'), 'spec steps');
      expect(steps.length).toBe(expected.length);
      const rig = await build(spec);
      for (let index = 0; index < steps.length; index += 1) {
        const step = obj(steps[index], 'step');
        const want = obj(expected[index], 'expected step');
        const record: Recorder = { calls: [], queueSaves: [] };
        rig.trace.entries.length = 0;
        for (const [fid, row] of optionalObject(step.get('seed_rows')).entries) {
          rig.sandbox.files.set(`${FINDINGS}/triage/${fid}.json`, entryBytes(row));
        }
        const outcome = await runStep(spec, rig, record, step);
        const label = `${name} step ${index}`;
        expect([label, outcome.raises ?? null]).toEqual([
          label,
          want.has('raises') ? want.get('raises') : null,
        ]);
        if (!want.has('raises')) {
          expect([label, outcome.returns]).toEqual([label, want.get('returns')]);
        }
        expect([label, toPlainJson(record.calls as never)]).toEqual([
          label,
          toPlainJson(want.get('calls') as JsonValue),
        ]);
        expect([label, record.queueSaves]).toEqual([
          label,
          toPlainJson(want.get('queue_saves') as JsonValue),
        ]);
        expect([label, rig.trace.entries]).toEqual([
          label,
          toPlainJson(want.get('trace') as JsonValue),
        ]);
        expect([label, text(rig.cell.queue)]).toEqual([label, want.get('queue')]);
        expect([label, rig.sandbox.dirText(`${FINDINGS}/triage`)]).toEqual([
          label,
          sortedPlain(want.get('rows')),
        ]);
        expect([label, rig.sandbox.dirText(`${FINDINGS}/delivery`)]).toEqual([
          label,
          sortedPlain(want.get('delivery')),
        ]);
        expect([label, rig.sandbox.dirText(`${FINDINGS}/receipts`)]).toEqual([
          label,
          sortedPlain(want.get('receipts')),
        ]);
        expect([label, rig.sandbox.dirText(INBOX)]).toEqual([
          label,
          sortedPlain(want.get('repair_inbox')),
        ]);
        expect([label, rig.sandbox.dirText(PENDING)]).toEqual([
          label,
          sortedPlain(want.get('pending')),
        ]);
        expect([label, rig.sandbox.tree()]).toEqual([
          label,
          toPlainJson(want.get('tree') as JsonValue),
        ]);
        // The exact bytes of every file must match, not a parsed re-render.
        expect([label, rig.sandbox.digests()]).toEqual([
          label,
          toPlainJson(want.get('digests') as JsonValue),
        ]);
        // Every path any seam addressed resolved inside the sandbox root, and
        // the recorded sentinel beside the Python sandbox stayed untouched.
        expect([label, rig.sandbox.files.escapes]).toEqual([label, []]);
        expect(want.get('outside_untouched')).toBe(true);
      }
    });
  }
});

describe('repair transport seams', () => {
  function caseSpec(name: string): JsonObject {
    const found = cases.map((raw) => obj(raw, 'case')).find((entry) => entry.get('name') === name);
    if (found === undefined) throw new Error(`missing case ${name}`);
    return obj(found.get('spec'), 'spec');
  }

  test('concurrent accepts are serialized so the ceiling holds across enqueue', async () => {
    const source = caseSpec('accept-ceiling-custom-one');
    const spec = new JsonObject([
      ...source.entries.filter(([key]) => key !== 'queue'),
      ['queue', new JsonObject([['items', []]])],
    ]);
    const rig = await build(spec);
    const step = obj(arr(spec.get('steps'), 'steps')[0], 'step');
    const [key, request] = arr(step.get('args'), 'args') as [JsonValue, JsonValue];
    const mode = obj(step.get('transport'), 'transport');
    const record: Recorder = { calls: [], queueSaves: [] };
    const accept = makeTransport(spec, rig, record, mode);
    // One round of headroom per pin: Python runs two accepts one after the
    // other, so exactly one may enqueue and the other must hit the ceiling.
    const results = await Promise.allSettled([
      accept('a'.repeat(64), request),
      accept(key, request),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect((rejected.reason as { pythonError?: string }).pythonError).toBe('RepairRoundCeiling');
  });

  test('the configured transport saves the queue through its context, not a detached method', async () => {
    const source = caseSpec('accept-ceiling-custom-one');
    const spec = new JsonObject([
      ...source.entries.filter(([key]) => key !== 'queue'),
      ['queue', new JsonObject([['items', []]])],
    ]);
    const rig = await build(spec);
    const saved: string[] = [];
    class Context implements ConfiguredTransportContext {
      readonly config: JsonValue = new JsonObject([['repair', new JsonObject([])]]);
      readonly label = 'bound';
      async saveQueue(value: JsonValue): Promise<void> {
        saved.push(`${this.label}:${text(value)}`);
      }
      async secretScan(): Promise<JsonValue> {
        return [true, null];
      }
      async secretScanDiff(): Promise<JsonValue> {
        return [true, null];
      }
    }
    const runtime: ConfiguredRuntime = {
      async projection(_repo, target) {
        return [`base-${pythonStr(target)}`, `head-${pythonStr(target)}`];
      },
    };
    const transport = configuredRepairTransport(
      new Context(),
      'repo',
      rig.files,
      rig.cell,
      runtime,
    );
    const step = obj(arr(spec.get('steps'), 'steps')[0], 'step');
    const args = arr(step.get('args'), 'args');
    await transport(args[0] as JsonValue, args[1] as JsonValue);
    expect(saved.length).toBe(1);
    expect(saved[0]?.startsWith('bound:')).toBe(true);
  });

  test('one refused accept does not latch the serialization chain for later accepts', async () => {
    const spec = caseSpec('accept-ceiling-custom-one');
    const rig = await build(
      new JsonObject([
        ...spec.entries.filter(([key]) => key !== 'queue'),
        ['queue', new JsonObject([['items', []]])],
      ]),
    );
    const step = obj(arr(spec.get('steps'), 'steps')[0], 'step');
    const [key, request] = arr(step.get('args'), 'args') as [JsonValue, JsonValue];
    let clean = false;
    const accept = makeRepairTransport({
      files: rig.files,
      cell: rig.cell,
      async saveQueue() {},
      maxRoundsPerPin: JsonNumber.int(5),
      async scan() {
        return clean;
      },
      async scanFinding() {
        return true;
      },
    });
    const refused = await accept(key, request).catch((error: unknown) => error);
    expect((refused as Error).message).toBe('repair source secret scan rejected');
    clean = true;
    const done = await accept(key, request);
    expect(done).toBeInstanceOf(JsonObject);
  });
});
