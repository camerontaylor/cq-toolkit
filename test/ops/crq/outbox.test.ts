import { describe, expect, test } from 'vitest';
import { parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { LedgerIntegrityError, ledgerCanonicalBytes } from '../../../src/policy/crq/ledger.js';
import { sha256Hex } from '../../../src/policy/crq/pythonJson.js';
import {
  Outbox,
  type ArtifactVerifier,
  type OutboxFiles,
} from '../../../src/ops/review/internal/crq/outbox.js';
import {
  arrayAt,
  artifactSha,
  batchEvidence,
  evidenceList,
  idsAt,
  loadPublisherVectors,
  requireObject,
  stringAt,
  type PublisherVectorCase,
  type RecordEvidence,
} from '../../policy/crq/publisherVectors.js';

class MemoryFiles implements OutboxFiles {
  readonly pending = new Map<string, Uint8Array>();
  readonly ack = new Map<string, Uint8Array>();
  lockCalls = 0;
  private locked = false;

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.lockCalls++;
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
  readonly refused = new Set<string>();

  async verify(reference: JsonValue): Promise<void> {
    if (this.refused.has(artifactSha(reference))) {
      throw new LedgerIntegrityError('missing or corrupt retained artifact');
    }
  }
}

const vectors = loadPublisherVectors();
const outboxCases = vectors.filter((entry) => entry.family === 'outbox');

function caseNamed(name: string): PublisherVectorCase {
  const found = outboxCases.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing outbox vector ${name}`);
  return found;
}

function expectedValue(caseEntry: PublisherVectorCase): ReturnType<typeof requireObject> {
  return requireObject(caseEntry.expect.get('value'), 'expected value');
}

function valueOf(caseEntry: PublisherVectorCase): JsonValue {
  const value = caseEntry.input.get('value');
  if (value === undefined) throw new Error('missing value input');
  return value;
}

function settings(): { files: MemoryFiles; artifacts: MemoryArtifacts; outbox: Outbox } {
  const files = new MemoryFiles();
  const artifacts = new MemoryArtifacts();
  return { files, artifacts, outbox: new Outbox(files, artifacts) };
}

describe('outbox against the Python oracle', () => {
  test('spool is an idempotent canonical replay', async () => {
    const caseEntry = caseNamed('spool-idempotent-replay');
    const { files, outbox } = settings();
    const value = valueOf(caseEntry);
    const first = await outbox.spool(value);
    const second = await outbox.spool(value);
    const expected = expectedValue(caseEntry);
    expect([first, second]).toEqual(idsAt(expected, 'ids'));
    expect(batchEvidence([await outbox.pending()])[0]).toEqual(
      evidenceList(expected.get('pending')) as RecordEvidence[],
    );
    expect(
      (await outbox.retained()).map((entry) => requireObject(entry, 'retained').get('id')),
    ).toEqual(idsAt(expected, 'retained'));
    expect(files.pending.get(first)).toEqual(ledgerCanonicalBytes(value));
    expect(files.lockCalls).toBe(2);
  });

  test('a Python-equal replay is accepted and canonicalised', async () => {
    const caseEntry = caseNamed('spool-semantic-replay');
    const { files, outbox } = settings();
    const value = valueOf(caseEntry);
    const reordered = caseEntry.input.get('reordered');
    if (reordered === undefined) throw new Error('missing reordered input');
    const id = await outbox.spool(value);
    files.pending.set(id, ledgerCanonicalBytes(reordered));
    const before = files.pending.get(id);
    if (before === undefined) throw new Error('missing reordered retained bytes');

    const second = await outbox.spool(value);
    const expected = expectedValue(caseEntry);
    expect(idsAt(expected, 'ids')).toEqual([second]);
    const after = files.pending.get(id);
    if (after === undefined) throw new Error('missing canonical retained bytes');
    expect(after).toEqual(ledgerCanonicalBytes(value));
    expect(batchEvidence([await outbox.pending()])[0]).toEqual(
      evidenceList(expected.get('pending')) as RecordEvidence[],
    );
    expect(sha256Hex(before)).toBe(stringAt(expected, 'pre_sha256'));
    expect(sha256Hex(after)).toBe(stringAt(expected, 'post_sha256'));
    expect(sha256Hex(before)).not.toBe(sha256Hex(after));
  });

  test('a different record under the same id is a replay conflict', async () => {
    const caseEntry = caseNamed('spool-replay-conflict');
    const { files, outbox } = settings();
    const value = valueOf(caseEntry);
    const conflicting = caseEntry.input.get('conflicting');
    if (conflicting === undefined) throw new Error('missing conflicting input');
    await outbox.spool(value);
    const id = stringAt(requireObject(value, 'value'), 'id');
    files.pending.set(id, ledgerCanonicalBytes(conflicting));
    await expect(outbox.spool(value)).rejects.toThrow(stringAt(caseEntry.expect, 'message'));
  });

  test('spool verifies artifacts before writing', async () => {
    const caseEntry = caseNamed('spool-verifies-artifact');
    const { files, artifacts, outbox } = settings();
    const value = valueOf(caseEntry);
    const payload = requireObject(requireObject(value, 'value').get('payload'), 'payload');
    const artifactsInput = payload.get('artifacts');
    if (!Array.isArray(artifactsInput)) throw new Error('missing artifacts');
    for (const reference of artifactsInput) artifacts.refused.add(artifactSha(reference));
    await expect(outbox.spool(value)).rejects.toThrow(stringAt(caseEntry.expect, 'message'));
    expect(files.pending.size).toBe(0);
    expect(files.lockCalls).toBe(0);
  });

  test('an acknowledgement requires a remote id', async () => {
    const caseEntry = caseNamed('acknowledge-requires-remote');
    const { outbox } = settings();
    const value = valueOf(caseEntry);
    await outbox.spool(value);
    await expect(outbox.acknowledge(value, new Set())).rejects.toThrow(
      stringAt(caseEntry.expect, 'message'),
    );
  });

  test('pending excludes an acknowledged record while retained keeps it', async () => {
    const caseEntry = caseNamed('pending-excludes-ack');
    const { files, outbox } = settings();
    const value = valueOf(caseEntry);
    const id = await outbox.spool(value);
    await outbox.acknowledge(value, new Set([id]));
    const expected = expectedValue(caseEntry);
    expect(await outbox.pending()).toEqual(arrayAt(expected, 'pending'));
    expect(
      (await outbox.retained()).map((entry) => requireObject(entry, 'retained').get('id')),
    ).toEqual(idsAt(expected, 'retained'));
    expect(files.ack.get(id)).toEqual(ledgerCanonicalBytes(parseJsonValue(JSON.stringify({ id }))));
  });
});
