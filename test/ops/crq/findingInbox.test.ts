/**
 * Effect-order differential for the injected finding inbox.
 *
 * The oracle vectors come from the real Python `Inbox` against a temporary
 * directory. Here the same operations run through a memory seam that records
 * one lock enter/exit, each existing-row read and each row write. No real root,
 * outbox, Git or transport is involved.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { JsonObject, toPlainJson, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerKeyError,
  LedgerTypeError,
} from '../../../src/policy/crq/ledger.js';
import { sha256Hex } from '../../../src/policy/crq/pythonJson.js';
import { FindingDeliveryAttributeError } from '../../../src/policy/crq/findingDelivery.js';
import {
  FindingInbox,
  type FindingInboxFiles,
  type IngestEvidence,
  type RecoverEvidence,
} from '../../../src/ops/review/internal/crq/findingInbox.js';
import {
  Outbox,
  type ArtifactVerifier,
  type OutboxFiles,
} from '../../../src/ops/review/internal/crq/outbox.js';
import {
  arrayField,
  effectsFrom,
  loadFindingDeliveryVectors,
  numberField,
  objectField,
  optionalArrayField,
  requireObject,
  rowsFrom,
  stringField,
  type FindingDeliveryCase,
} from '../../policy/crq/findingDeliveryVectors.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function pythonErrorClass(error: unknown): string {
  if (error instanceof FindingDeliveryAttributeError) return error.pythonError;
  if (error instanceof LedgerTypeError) return error.pythonError;
  if (error instanceof LedgerKeyError) return error.pythonError;
  if (error instanceof LedgerIntegrityError) return error.pythonError;
  if (error instanceof LedgerJsonDecodeError) return error.pythonError;
  return error instanceof Error ? error.name : 'UnknownError';
}

class MemoryFiles implements FindingInboxFiles {
  readonly triage = new Map<string, Uint8Array>();
  readonly effects: JsonObject[] = [];
  lockEnters = 0;
  private locked = false;

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.lockEnters += 1;
    this.locked = true;
    this.effects.push(
      new JsonObject([
        ['kind', 'lock'],
        ['phase', 'enter'],
        ['target', 'findings.lock'],
      ]),
    );
    try {
      return await fn();
    } finally {
      this.locked = false;
      this.effects.push(
        new JsonObject([
          ['kind', 'lock'],
          ['phase', 'exit'],
          ['target', 'findings.lock'],
        ]),
      );
    }
  }

  async readTriage(findingId: string): Promise<Uint8Array | null> {
    if (!this.locked) throw new Error('readTriage outside withLock');
    const bytes = this.triage.get(findingId);
    if (bytes === undefined) return null;
    this.effects.push(
      new JsonObject([
        ['kind', 'read'],
        ['sha256', sha256Hex(bytes)],
      ]),
    );
    return bytes;
  }

  async writeTriage(findingId: string, bytes: Uint8Array): Promise<void> {
    if (!this.locked) throw new Error('writeTriage outside withLock');
    this.triage.set(findingId, bytes);
    this.effects.push(
      new JsonObject([
        ['kind', 'write'],
        ['target', findingId],
        ['sha256', sha256Hex(bytes)],
        ['canonical', decoder.decode(bytes)],
      ]),
    );
  }
}

class MemoryOutboxFiles implements OutboxFiles {
  readonly pending = new Map<string, Uint8Array>();
  readonly ack = new Map<string, Uint8Array>();
  private locked = false;

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
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
    this.pending.set(id, bytes);
  }

  async hasAck(id: string): Promise<boolean> {
    return this.ack.has(id);
  }

  async writeAck(id: string, bytes: Uint8Array): Promise<void> {
    this.ack.set(id, bytes);
  }
}

class MemoryArtifacts implements ArtifactVerifier {
  async verify(): Promise<void> {}
}

function seedRows(files: MemoryFiles, entry: FindingDeliveryCase): void {
  for (const value of optionalArrayField(entry.input, 'seed')) {
    const row = requireObject(value, 'seed row');
    files.triage.set(stringField(row, 'id'), encoder.encode(stringField(row, 'canonical')));
  }
}

interface RowText {
  id: string;
  canonical: string;
  sha256: string;
}

function actualRows(files: MemoryFiles): readonly RowText[] {
  return [...files.triage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, bytes]) => ({
      id,
      canonical: decoder.decode(bytes),
      sha256: sha256Hex(bytes),
    }));
}

function actualEffects(files: MemoryFiles): unknown {
  return files.effects.map((effect) => toPlainJson(effect));
}

async function retainedEvents(entry: FindingDeliveryCase): Promise<readonly JsonValue[]> {
  const events = optionalArrayField(entry.input, 'events');
  if (entry.input.get('acknowledged') !== true) return events;
  const outbox = new Outbox(new MemoryOutboxFiles(), new MemoryArtifacts());
  const ids = new Set(events.map((value) => stringField(requireObject(value, 'event'), 'id')));
  for (const value of events) {
    await outbox.spool(value);
    await outbox.acknowledge(value, ids);
  }
  return outbox.retained();
}

async function runCase(entry: FindingDeliveryCase): Promise<{
  readonly files: MemoryFiles;
  readonly caught: unknown;
  readonly evidence: IngestEvidence | RecoverEvidence | null;
}> {
  const files = new MemoryFiles();
  seedRows(files, entry);
  const inbox = new FindingInbox(files);
  const repeat = entry.input.has('repeat') ? numberField(entry.input, 'repeat') : 1;
  let caught: unknown = null;
  let evidence: IngestEvidence | RecoverEvidence | null = null;
  try {
    for (let index = 0; index < repeat; index += 1) {
      if (entry.family === 'ingest') {
        evidence = await inbox.ingest(entry.input.get('review') as JsonValue);
      } else {
        evidence = await inbox.recover(await retainedEvents(entry));
      }
    }
  } catch (error) {
    caught = error;
  }
  return { files, caught, evidence };
}

const vectors = loadFindingDeliveryVectors().filter(
  (entry) => entry.family === 'ingest' || entry.family === 'recover',
);

function requiredCase(name: string): FindingDeliveryCase {
  const found = vectors.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing vector ${name}`);
  return found;
}

describe('finding inbox effect vectors', () => {
  test('every oracle ingest and recover case is present', () => {
    const families = new Set(vectors.map((entry) => entry.family));
    expect([...families].sort()).toEqual(['ingest', 'recover']);
    expect(vectors.filter((entry) => entry.family === 'ingest').length).toBeGreaterThan(5);
    expect(vectors.filter((entry) => entry.family === 'recover').length).toBeGreaterThan(8);
  });

  test.each(vectors)('$family/$name matches row bytes, effects and refusals', async (entry) => {
    const { files, caught } = await runCase(entry);
    const expectedOk = entry.expect.get('ok') === true;
    if (expectedOk) {
      expect(caught, `${entry.name}: unexpected refusal`).toBeNull();
    } else {
      expect(
        caught,
        `${entry.name}: expected ${stringField(entry.expect, 'error')}`,
      ).not.toBeNull();
      expect(pythonErrorClass(caught), entry.name).toBe(stringField(entry.expect, 'error'));
      const message = entry.expect.get('message');
      if (typeof message === 'string') {
        expect(caught instanceof Error ? caught.message : String(caught), entry.name).toBe(message);
      }
    }
    expect(actualRows(files), `${entry.name}: rows`).toEqual(rowsFrom(entry.expect.get('after')));
    expect(actualEffects(files), `${entry.name}: effects`).toEqual(
      effectsFrom(entry.expect).map((effect) => toPlainJson(effect)),
    );
  });

  test('ingest locks once per finding and recover locks once per call', async () => {
    const ingest = vectors.find((entry) => entry.name === 'ingest-multiple-order');
    const recover = vectors.find((entry) => entry.name === 'recover-reverse-order-chain');
    if (ingest === undefined || recover === undefined) throw new Error('lock vectors missing');
    const ingestRun = await runCase(ingest);
    const recoverRun = await runCase(recover);
    expect(ingestRun.files.lockEnters).toBe(2);
    expect(recoverRun.files.lockEnters).toBe(1);
  });

  test('a later-finding conflict preserves the earlier write', async () => {
    const entry = vectors.find((candidate) => candidate.name === 'ingest-later-conflict');
    if (entry === undefined) throw new Error('ingest-later-conflict vector missing');
    const { files, caught } = await runCase(entry);
    expect(pythonErrorClass(caught)).toBe('IntegrityError');
    expect(files.triage.size).toBe(2);
    const first = vectors.find((candidate) => candidate.name === 'ingest-multiple-order');
    if (first === undefined) throw new Error('ingest-multiple-order vector missing');
    const firstRun = await runCase(first);
    const seeded = requireObject(optionalArrayField(entry.input, 'seed')[0], 'seed row');
    const seededId = stringField(seeded, 'id');
    expect(actualRows(files).filter((row) => row.id !== seededId)).toEqual(
      actualRows(firstRun.files).filter((row) => row.id !== seededId),
    );
  });

  test('a partial replay writes the first row before refusing the second', async () => {
    const entry = vectors.find(
      (candidate) => candidate.name === 'recover-partial-write-before-refusal',
    );
    if (entry === undefined) throw new Error('partial replay vector missing');
    const { files, caught } = await runCase(entry);
    expect(pythonErrorClass(caught)).toBe('KeyError');
    const written = files.effects.filter((effect) => effect.get('kind') === 'write');
    expect(written.length).toBe(1);
    expect(files.triage.size).toBe(1);
  });

  test('a second ingest and a second recover write nothing', async () => {
    const ingest = vectors.find((entry) => entry.name === 'ingest-replay');
    const recover = vectors.find((entry) => entry.name === 'recover-idempotent-second-pass');
    if (ingest === undefined || recover === undefined) throw new Error('replay vectors missing');
    for (const entry of [ingest, recover]) {
      const { files, caught } = await runCase(entry);
      expect(caught, entry.name).toBeNull();
      const writes = files.effects.filter((effect) => effect.get('kind') === 'write');
      expect(writes.length, entry.name).toBe(1);
    }
  });

  test('operation evidence names the written, existing, applied and pending ids', async () => {
    const fresh = requiredCase('ingest-fresh');
    const replay = requiredCase('ingest-replay');
    const applied = requiredCase('recover-already-applied');
    const mismatch = requiredCase('recover-predecessor-mismatch');
    const reverse = requiredCase('recover-reverse-order-chain');

    const findingId = stringField(
      requireObject(
        arrayField(
          objectField(requireObject(fresh.input.get('review'), 'review'), 'payload'),
          'findings',
        )[0],
        'finding',
      ),
      'id',
    );
    const freshRun = await runCase(fresh);
    expect(freshRun.evidence).toEqual({ written: [findingId], existing: [] });
    const replayRun = await runCase(replay);
    expect(replayRun.evidence).toEqual({ written: [], existing: [findingId] });

    const appliedIds = optionalArrayField(applied.input, 'events').map((value) =>
      stringField(requireObject(value, 'event'), 'id'),
    );
    const appliedRun = await runCase(applied);
    expect(appliedRun.evidence).toEqual({
      written: [],
      alreadyApplied: [appliedIds[0]],
      pending: [],
    });

    const mismatchRun = await runCase(mismatch);
    expect(mismatchRun.evidence).toEqual({
      written: [],
      alreadyApplied: [],
      pending: optionalArrayField(mismatch.input, 'events'),
    });

    const reverseIds = optionalArrayField(reverse.input, 'events').map((value) =>
      stringField(requireObject(value, 'event'), 'id'),
    );
    const reverseRun = await runCase(reverse);
    expect(reverseRun.evidence).toEqual({
      written: [reverseIds[1], reverseIds[0]],
      alreadyApplied: [],
      pending: [],
    });
  });

  test('the public surface exposes only ingest and recover', () => {
    const inbox = new FindingInbox(new MemoryFiles());
    expect(typeof inbox.ingest).toBe('function');
    expect(typeof inbox.recover).toBe('function');
    expect((inbox as unknown as Record<string, unknown>).recoverEvent).toBeUndefined();
  });

  test('the module imports no filesystem, process, clock or outbox seam', () => {
    const source = readFileSync(
      new URL('../../../src/ops/review/internal/crq/findingInbox.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/node:child_process|node:fs|process\.env|new Date|Date\(/);
    expect(source).not.toMatch(/\bOutbox\b/);
  });
});
