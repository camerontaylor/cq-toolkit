/**
 * Differential for the finding-inbox dispositions (`context_error`,
 * `recovered_anchor`, `triage`, `repair_outcome`).
 *
 * `apps/crq-python/finding_disposition_vectors.py` drives the real Python
 * `Inbox` over a temporary root and records, per step, the return value or
 * exception class, the repository calls, the lock/write/spool order and the
 * final rows and pending events. Here the same specs run through memory seams
 * and must reproduce every recorded fact.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  ledgerCanonicalBytes,
  ledgerCanonicalText,
  ledgerLoads,
} from '../../../src/policy/crq/ledger.js';
import {
  FindingArtifactReadError,
  FindingDispositions,
  FindingRepoError,
  type FindingArtifactReader,
  type FindingRepo,
  type RepairOutcomeOptions,
  type TriageOptions,
} from '../../../src/ops/review/internal/crq/findingDisposition.js';
import type { ArtifactReference } from '../../../src/adapters/crq/findingStore.js';
import type { FindingInboxFiles } from '../../../src/ops/review/internal/crq/findingInbox.js';
import {
  Outbox,
  type ArtifactVerifier,
  type OutboxFiles,
} from '../../../src/ops/review/internal/crq/outbox.js';
import { LedgerIntegrityError } from '../../../src/policy/crq/ledger.js';

const CASES_URL = new URL(
  '../../../apps/crq-python/fixtures/crq-finding-disposition/cases.json',
  import.meta.url,
);
const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();
const VIRTUAL = '/fixtures/artifacts/sha256/';

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

class Trace {
  readonly entries: string[] = [];
}

class MemoryFiles implements FindingInboxFiles {
  readonly triage = new Map<string, Uint8Array>();
  private locked = false;
  constructor(private readonly trace: Trace) {}

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
    return this.triage.get(findingId) ?? null;
  }
  async writeTriage(findingId: string, bytes: Uint8Array): Promise<void> {
    if (!this.locked) throw new Error('writeTriage outside withLock');
    this.trace.entries.push(`write:triage/${findingId}.json`);
    this.triage.set(findingId, bytes);
  }
}

class MemoryOutboxFiles implements OutboxFiles {
  readonly pending = new Map<string, Uint8Array>();
  readonly ack = new Map<string, Uint8Array>();
  private locked = false;
  constructor(private readonly trace: Trace) {}

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
    return [...this.pending.keys()].sort();
  }
  async readPending(id: string): Promise<Uint8Array | null> {
    return this.pending.get(id) ?? null;
  }
  async writePending(id: string, bytes: Uint8Array): Promise<void> {
    if (!this.locked) throw new Error('writePending outside outbox lock');
    this.trace.entries.push(`write:pending/${id}.json`);
    this.pending.set(id, bytes);
  }
  async hasAck(id: string): Promise<boolean> {
    return this.ack.has(id);
  }
  async writeAck(id: string, bytes: Uint8Array): Promise<void> {
    this.ack.set(id, bytes);
  }
}

interface ArtifactEntry {
  readonly hex: string;
  readonly verify: string | null;
  readonly read: string;
  readonly swappedHex: string | null;
}

function artifactTable(table: JsonObject): Map<string, ArtifactEntry> {
  const out = new Map<string, ArtifactEntry>();
  for (const [sha, raw] of table.entries) {
    const entry = obj(raw, 'artifact');
    const verify = entry.get('verify');
    const read = entry.get('read');
    const swapped = entry.get('swapped_hex');
    out.set(sha, {
      hex: str(entry.get('hex'), 'hex'),
      verify: typeof verify === 'string' ? verify : null,
      read: typeof read === 'string' ? read : 'ok',
      swappedHex: typeof swapped === 'string' ? swapped : null,
    });
  }
  return out;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

class FixtureArtifacts implements FindingArtifactReader, ArtifactVerifier {
  constructor(private readonly table: Map<string, ArtifactEntry>) {}

  async verify(reference: JsonValue | ArtifactReference): Promise<void> {
    const sha =
      reference instanceof JsonObject
        ? reference.get('sha256')
        : (reference as { sha256?: unknown } | null)?.sha256;
    const entry = typeof sha === 'string' ? this.table.get(sha) : undefined;
    if (entry === undefined || entry.verify === 'fail') {
      throw new LedgerIntegrityError('missing or corrupt retained artifact');
    }
  }
  async read(location: string): Promise<Uint8Array> {
    const entry = location.startsWith(VIRTUAL)
      ? this.table.get(location.slice(VIRTUAL.length))
      : undefined;
    if (entry === undefined || entry.read === 'missing') {
      throw new FindingArtifactReadError(`unreadable artifact ${location}`);
    }
    return hexBytes(entry.read === 'swapped' ? (entry.swappedHex ?? '') : entry.hex);
  }
}

class FixtureRepo implements FindingRepo {
  readonly calls: (string | number[])[][] = [];
  constructor(private readonly facts: JsonObject) {}

  private fail(what: string): never {
    throw new FindingRepoError(`git ${what} failed`);
  }
  async resolve(value: string): Promise<string> {
    this.calls.push(['resolve', value]);
    const found = optionalObject(this.facts.get('resolve')).get(value);
    if (typeof found !== 'string') this.fail(`rev-parse ${value}`);
    return found;
  }
  async entries(commit: string): Promise<JsonObject> {
    this.calls.push(['entries', commit]);
    const found = optionalObject(this.facts.get('entries')).get(commit);
    if (!(found instanceof JsonObject)) this.fail(`ls-tree ${commit}`);
    return found;
  }
  async catBlob(blob: string): Promise<Uint8Array> {
    this.calls.push(['git', 'cat-file', 'blob', blob]);
    const found = optionalObject(this.facts.get('blobs')).get(blob);
    if (typeof found !== 'string') this.fail(`cat-file blob ${blob}`);
    return hexBytes(found);
  }
  async carry(
    old: string,
    next: string,
    path: string,
    lines: ReadonlySet<number>,
  ): Promise<{ name: string | null; mapped: ReadonlySet<number> }> {
    const ordered = [...lines].sort((a, b) => a - b);
    this.calls.push(['carry', old, next, path, ordered]);
    for (const raw of arr(this.facts.get('carry'), 'carry')) {
      const fact = obj(raw, 'carry fact');
      const want = JSON.stringify(toPlainJson(fact.get('lines') as JsonValue));
      if (
        fact.get('old') === old &&
        fact.get('next') === next &&
        fact.get('path') === path &&
        want === JSON.stringify(ordered)
      ) {
        const name = fact.get('name');
        const mapped = arr(fact.get('mapped'), 'mapped').map((n) => Number(toPlainJson(n)));
        return { name: typeof name === 'string' ? name : null, mapped: new Set(mapped) };
      }
    }
    throw new Error(`no carry fact for ${old} ${next} ${path} ${ordered.join(',')}`);
  }
}

interface Harness {
  readonly files: MemoryFiles;
  readonly outboxFiles: MemoryOutboxFiles;
  readonly trace: Trace;
  readonly dispositions: FindingDispositions;
  readonly publication: { retained(): Promise<JsonValue[]>; spool(v: JsonValue): Promise<string> };
}

function writeRows(files: MemoryFiles, rows: JsonObject): void {
  for (const [fid, row] of rows.entries) files.triage.set(fid, ledgerCanonicalBytes(row));
}

async function build(spec: JsonObject): Promise<Harness> {
  const trace = new Trace();
  const files = new MemoryFiles(trace);
  const outboxFiles = new MemoryOutboxFiles(trace);
  const artifacts = new FixtureArtifacts(artifactTable(optionalObject(spec.get('artifacts'))));
  const outbox = new Outbox(outboxFiles, artifacts);
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
  writeRows(files, optionalObject(spec.get('rows')));
  for (const event of spec.get('retained') === undefined
    ? []
    : arr(spec.get('retained'), 'retained')) {
    await outbox.spool(event);
  }
  return {
    files,
    outboxFiles,
    trace,
    dispositions: new FindingDispositions(files, artifacts),
    publication,
  };
}

function plain(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : value;
}

function triageOptions(kwargs: JsonObject): TriageOptions {
  const out: Record<string, JsonValue> = {};
  const map: Record<string, string> = {
    fixing_commit: 'fixingCommit',
    canonical_id: 'canonicalId',
    reviews: 'reviews',
    current_path: 'currentPath',
    current_lines: 'currentLines',
    quoted_text: 'quotedText',
    failure_class: 'failureClass',
    expected_previous_event_id: 'expectedPreviousEventId',
  };
  for (const [key, value] of kwargs.entries) {
    const name = map[key];
    if (name === undefined) throw new Error(`unknown triage kwarg ${key}`);
    out[name] = value;
  }
  return out as TriageOptions;
}

function repairOptions(kwargs: JsonObject): RepairOutcomeOptions {
  const out: Record<string, unknown> = {};
  const map: Record<string, string> = {
    fix_pr: 'fixPr',
    repair_base: 'repairBase',
    failure_class: 'failureClass',
    fixing_commit: 'fixingCommit',
    source_evidence: 'sourceEvidence',
    max_finding_retries: 'maxFindingRetries',
  };
  for (const [key, value] of kwargs.entries) {
    const name = map[key];
    if (name === undefined) throw new Error(`unknown repair_outcome kwarg ${key}`);
    out[name] = key === 'max_finding_retries' ? Number(toPlainJson(value)) : value;
  }
  return out as RepairOutcomeOptions;
}

interface Outcome {
  kind?: 'none' | 'bool' | 'json';
  returns?: string | boolean | null;
  raises?: string;
}

async function runStep(harness: Harness, repo: FixtureRepo, step: JsonObject): Promise<Outcome> {
  const method = str(step.get('method'), 'method');
  const args = arr(step.get('args'), 'args');
  const kwargs = optionalObject(step.get('kwargs'));
  const { dispositions, publication } = harness;
  try {
    if (method === 'context_error') {
      const value = await dispositions.contextError(
        args[0] as string,
        plain(args[1]),
        plain(args[2]),
      );
      return { kind: 'bool', returns: value };
    }
    if (method === 'recovered_anchor') {
      const value = await dispositions.recoveredAnchor(
        args[0] as JsonValue,
        repo,
        arr(args[1], 'reviews'),
      );
      return value === null
        ? { kind: 'none', returns: null }
        : { kind: 'json', returns: ledgerCanonicalText(value) };
    }
    if (method === 'triage') {
      const value = await dispositions.triage(
        publication,
        repo,
        args[0] as string,
        args[1] as string,
        plain(args[2]),
        plain(args[3]),
        plain(args[4]),
        args[5] as string,
        triageOptions(kwargs),
      );
      return value === null
        ? { kind: 'none', returns: null }
        : { kind: 'json', returns: ledgerCanonicalText(value) };
    }
    if (method === 'repair_outcome') {
      await dispositions.repairOutcome(
        publication,
        args[0] as string,
        args[1] as string,
        args[2] as string,
        plain(args[3]),
        args[4] as string,
        repairOptions(kwargs),
      );
      return { kind: 'none', returns: null };
    }
    throw new Error(`unknown method ${method}`);
  } catch (error) {
    const name = (error as { pythonError?: unknown }).pythonError;
    if (typeof name !== 'string') throw error;
    return { raises: name };
  }
}

function rowTexts(files: MemoryFiles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of [...files.triage.keys()].sort()) {
    out[id] = ledgerCanonicalText(ledgerLoads(files.triage.get(id) as Uint8Array));
  }
  return out;
}

function pendingTexts(files: MemoryOutboxFiles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of [...files.pending.keys()].sort()) {
    out[id] = ledgerCanonicalText(ledgerLoads(files.pending.get(id) as Uint8Array));
  }
  return out;
}

function sortedPlain(value: JsonValue | undefined): unknown {
  const plainValue = toPlainJson(plain(value)) as Record<string, unknown> | null;
  if (plainValue === null) return {};
  return Object.fromEntries(Object.entries(plainValue).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const document = obj(parseJsonValue(readFileSync(CASES_URL, 'utf-8')), 'cases');
const cases = arr(document.get('cases'), 'cases');

describe('finding disposition oracle vectors', () => {
  test('the fixture carries the expected schema and a non-trivial case count', () => {
    expect(document.get('schema')).toBe('cq.finding-disposition-vectors/v1');
    expect(cases.length).toBeGreaterThanOrEqual(150);
  });

  for (const raw of cases) {
    const entry = obj(raw, 'case');
    const name = str(entry.get('name'), 'name');
    test(name, async () => {
      const spec = obj(entry.get('spec'), 'spec');
      const expected = arr(obj(entry.get('result'), 'result').get('steps'), 'steps');
      const steps = arr(spec.get('steps'), 'spec steps');
      expect(steps.length).toBe(expected.length);
      const harness = await build(spec);
      for (let index = 0; index < steps.length; index += 1) {
        const step = obj(steps[index], 'step');
        const want = obj(expected[index], 'expected step');
        if (step.has('reset')) {
          harness.files.triage.clear();
          writeRows(harness.files, obj(step.get('reset'), 'reset'));
          expect(want.get('reset')).toBe(true);
          continue;
        }
        const repo = new FixtureRepo(optionalObject(spec.get('repo')));
        harness.trace.entries.length = 0;
        const outcome = await runStep(harness, repo, step);
        const label = `${name} step ${index}`;
        expect([label, outcome.raises ?? null]).toEqual([
          label,
          want.has('raises') ? want.get('raises') : null,
        ]);
        if (!want.has('raises')) {
          expect([label, outcome.kind, outcome.returns]).toEqual([
            label,
            want.get('kind'),
            want.get('returns') ?? null,
          ]);
        }
        expect([label, repo.calls]).toEqual([label, toPlainJson(want.get('calls') as JsonValue)]);
        expect([label, harness.trace.entries]).toEqual([
          label,
          toPlainJson(want.get('trace') as JsonValue),
        ]);
        expect([label, rowTexts(harness.files)]).toEqual([label, sortedPlain(want.get('rows'))]);
        expect([label, pendingTexts(harness.outboxFiles)]).toEqual([
          label,
          sortedPlain(want.get('pending')),
        ]);
      }
    });
  }
});

describe('port-only string guards before repo.carry', () => {
  const found = cases
    .map((raw) => obj(raw, 'case'))
    .find((entry) => entry.get('name') === 'triage-confirmed-full-carry');
  if (found === undefined) throw new Error('triage-confirmed-full-carry vector missing');
  const base = found;

  async function refuse(mutate: (row: Record<string, unknown>) => void) {
    const spec = obj(base.get('spec'), 'spec');
    const rows = toPlainJson(obj(spec.get('rows'), 'rows')) as Record<
      string,
      Record<string, unknown>
    >;
    for (const row of Object.values(rows)) mutate(row);
    const edited = new JsonObject(
      [...spec.entries].map(([key, value]) =>
        key === 'rows' ? [key, parseJsonValue(JSON.stringify(rows))] : [key, value],
      ),
    );
    const harness = await build(edited);
    const repo = new FixtureRepo(optionalObject(edited.get('repo')));
    const before = rowTexts(harness.files);
    const step = obj(arr(edited.get('steps'), 'steps')[0], 'step');
    const outcome = await runStep(harness, repo, step);
    return { outcome, repo, harness, before };
  }

  test('a non-string row target raises TypeError before carry, with no spool or row write', async () => {
    const { outcome, repo, harness, before } = await refuse((row) => {
      row.target = ['x'];
    });
    expect(outcome.raises).toBe('TypeError');
    expect(repo.calls.some((call) => call[0] === 'carry')).toBe(false);
    expect(harness.outboxFiles.pending.size).toBe(0);
    expect(rowTexts(harness.files)).toEqual(before);
  });

  test('a non-string anchor path raises TypeError before carry, with no spool or row write', async () => {
    const { outcome, repo, harness, before } = await refuse((row) => {
      (row.finding as Record<string, unknown>).path = ['src/a.ts'];
    });
    expect(outcome.raises).toBe('TypeError');
    expect(repo.calls.some((call) => call[0] === 'carry')).toBe(false);
    expect(harness.outboxFiles.pending.size).toBe(0);
    expect(rowTexts(harness.files)).toEqual(before);
  });
});

void decoder;
void encoder;
