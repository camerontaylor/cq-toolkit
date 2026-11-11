/**
 * Effect differential for `FindingInbox.handoff` against the real Python
 * `Inbox.handoff` oracle.
 *
 * The oracle vectors come from the real Python inbox against a temporary
 * directory. Here the same operation runs through memory seams: a shared
 * recorder models the nested `outbox.lock` inside the held `findings.lock`,
 * a real `Outbox` over a memory outbox store supplies `retained` and `spool`,
 * and no real root, lock file, Git, network or provider is involved.
 */
import { describe, expect, test } from 'vitest';
import { JsonObject, toPlainJson, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { ledgerCanonicalBytes } from '../../../src/policy/crq/ledger.js';
import { sha256Hex } from '../../../src/policy/crq/pythonJson.js';
import {
  FindingInbox,
  type FindingHandoffResult,
  type FindingInboxFiles,
  type FindingPublication,
} from '../../../src/ops/review/internal/crq/findingInbox.js';
import {
  Outbox,
  type ArtifactVerifier,
  type OutboxFiles,
} from '../../../src/ops/review/internal/crq/outbox.js';
import {
  effectsFrom,
  loadFindingDeliveryVectors,
  objectField,
  optionalArrayField,
  requireObject,
  requireString,
  rowsFrom,
  stringField,
  type FindingDeliveryCase,
} from '../../policy/crq/findingDeliveryVectors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The exact Python handoff effect cases and the TypeScript boundary each owns. */
const EFFECT_EXPECTATIONS = {
  'handoff-written': { kind: 'written' },
  'handoff-already-handed-off': { kind: 'already-handed-off' },
  'handoff-stale-owner': { kind: 'refused', refusal: 'canonical-handoff-mismatch' },
  'handoff-identity-finding-mismatch': { kind: 'refused', refusal: 'canonical-handoff-mismatch' },
  'handoff-identity-origin-mismatch': { kind: 'refused', refusal: 'canonical-handoff-mismatch' },
  'handoff-recovered-after-crash': { kind: 'already-handed-off' },
  'handoff-missing-row': { kind: 'refused', refusal: 'canonical-handoff-unavailable' },
  'handoff-receipt-not-object': { kind: 'refused', refusal: 'canonical-handoff-unavailable' },
  'handoff-receipt-missing': { kind: 'refused', refusal: 'canonical-handoff-mismatch' },
} as const;

type EffectExpectation = (typeof EFFECT_EXPECTATIONS)[keyof typeof EFFECT_EXPECTATIONS];

function expectationFor(name: string): EffectExpectation {
  const expectation = (EFFECT_EXPECTATIONS as Record<string, EffectExpectation | undefined>)[name];
  if (expectation === undefined) throw new Error(`unexpected handoff effect vector ${name}`);
  return expectation;
}

/**
 * One ordered effect log shared by both seams. Python's order is
 * `findings.lock` -> row read -> `outbox.lock` -> pending write ->
 * `outbox.lock` exit -> row write -> `findings.lock` exit. The stack rejects
 * a second overlapping `findings.lock` while allowing the nested different
 * name; every lock must be closed before the test ends.
 */
class MemoryEffects {
  readonly entries: JsonObject[] = [];
  private readonly stack: string[] = [];

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.stack.includes(name)) throw new Error(`re-entrant ${name}`);
    this.stack.push(name);
    this.entries.push(
      new JsonObject([
        ['kind', 'lock'],
        ['phase', 'enter'],
        ['target', name],
      ]),
    );
    try {
      return await fn();
    } finally {
      this.stack.pop();
      this.entries.push(
        new JsonObject([
          ['kind', 'lock'],
          ['phase', 'exit'],
          ['target', name],
        ]),
      );
    }
  }

  holds(name: string): boolean {
    return this.stack.includes(name);
  }

  read(bytes: Uint8Array): void {
    this.entries.push(
      new JsonObject([
        ['kind', 'read'],
        ['sha256', sha256Hex(bytes)],
      ]),
    );
  }

  write(target: string, bytes: Uint8Array): void {
    this.entries.push(
      new JsonObject([
        ['kind', 'write'],
        ['target', target],
        ['sha256', sha256Hex(bytes)],
        ['canonical', decoder.decode(bytes)],
      ]),
    );
  }

  assertBalanced(): void {
    if (this.stack.length !== 0) throw new Error(`unclosed locks: ${this.stack.join(',')}`);
  }

  reset(): void {
    this.entries.length = 0;
  }
}

class MemoryFiles implements FindingInboxFiles {
  readonly triage = new Map<string, Uint8Array>();
  writeFailures = 0;
  readFailures = 0;

  constructor(private readonly effects: MemoryEffects) {}

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.effects.withLock('findings.lock', fn);
  }

  async readTriage(findingId: string): Promise<Uint8Array | null> {
    if (!this.effects.holds('findings.lock')) throw new Error('readTriage outside findings.lock');
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error('triage read failed');
    }
    const bytes = this.triage.get(findingId);
    if (bytes === undefined) return null;
    this.effects.read(bytes);
    return bytes;
  }

  async writeTriage(findingId: string, bytes: Uint8Array): Promise<void> {
    if (!this.effects.holds('findings.lock')) throw new Error('writeTriage outside findings.lock');
    if (this.writeFailures > 0) {
      this.writeFailures -= 1;
      throw new Error('triage write failed');
    }
    this.triage.set(findingId, bytes);
    this.effects.write(findingId, bytes);
  }
}

class MemoryOutboxFiles implements OutboxFiles {
  readonly pending = new Map<string, Uint8Array>();
  readonly ack = new Map<string, Uint8Array>();

  constructor(private readonly effects: MemoryEffects) {}

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.effects.withLock('outbox.lock', fn);
  }

  async listPending(): Promise<readonly string[]> {
    return [...this.pending.keys()].sort();
  }

  async readPending(id: string): Promise<Uint8Array | null> {
    return this.pending.get(id) ?? null;
  }

  async writePending(id: string, bytes: Uint8Array): Promise<void> {
    if (!this.effects.holds('outbox.lock')) throw new Error('writePending outside outbox.lock');
    this.pending.set(id, bytes);
    this.effects.write(id, bytes);
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

/** A publication that fails if the effect reaches it too early. */
class PoisonPublication implements FindingPublication {
  retainedCalls = 0;
  spoolCalls = 0;

  async retained(): Promise<JsonValue[]> {
    this.retainedCalls += 1;
    throw new Error('retained must not be reached');
  }

  async spool(): Promise<string> {
    this.spoolCalls += 1;
    throw new Error('spool must not be reached');
  }
}

/** A deterministic failing publication for port-error boundaries. */
class FailingPublication implements FindingPublication {
  constructor(
    private readonly retainedFailure: string | undefined,
    private readonly spoolFailure: string | undefined,
  ) {}

  async retained(): Promise<JsonValue[]> {
    if (this.retainedFailure !== undefined) throw new Error(this.retainedFailure);
    return [];
  }

  async spool(): Promise<string> {
    if (this.spoolFailure !== undefined) throw new Error(this.spoolFailure);
    return 'unused';
  }
}

interface Fixture {
  readonly effects: MemoryEffects;
  readonly files: MemoryFiles;
  readonly outboxFiles: MemoryOutboxFiles;
  readonly outbox: Outbox;
}

function seed(entry: FindingDeliveryCase): Fixture {
  const effects = new MemoryEffects();
  const files = new MemoryFiles(effects);
  const outboxFiles = new MemoryOutboxFiles(effects);
  const row = entry.input.get('row');
  if (row !== undefined && row !== null) {
    files.triage.set(
      stringField(entry.input, 'finding_id'),
      encoder.encode(stringField(entry.input, 'row_canonical')),
    );
  }
  for (const event of optionalArrayField(entry.input, 'retained')) {
    const id = stringField(requireObject(event, 'retained event'), 'id');
    // Seed retained authority without recording an effect: Python's
    // `Outbox.retained` reads `pending/` outside its lock and the oracle does
    // not record those reads.
    outboxFiles.pending.set(id, ledgerCanonicalBytes(event));
  }
  return { effects, files, outboxFiles, outbox: new Outbox(outboxFiles, new MemoryArtifacts()) };
}

function inputFor(entry: FindingDeliveryCase): {
  readonly findingId: string;
  readonly previousTask: string;
  readonly preparedJobId: string;
  readonly job: JsonObject;
  readonly at: string;
} {
  return {
    findingId: stringField(entry.input, 'finding_id'),
    previousTask: stringField(entry.input, 'previous_task'),
    preparedJobId: stringField(entry.input, 'prepared_job_id'),
    job: objectField(entry.input, 'job'),
    at: stringField(entry.input, 'at'),
  };
}

interface RowBytes {
  readonly id: string;
  readonly canonical: string;
  readonly sha256: string;
}

function actualRows(files: MemoryFiles): readonly RowBytes[] {
  return [...files.triage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, bytes]) => ({
      id,
      canonical: decoder.decode(bytes),
      sha256: sha256Hex(bytes),
    }));
}

function expectedRows(entry: FindingDeliveryCase): readonly RowBytes[] {
  return rowsFrom(entry.expect.get('after')).map((row) => ({
    id: row.id,
    canonical: row.canonical,
    sha256: row.sha256,
  }));
}

/** The untouched row the effect must leave behind when a port fails. */
function beforeRows(entry: FindingDeliveryCase): readonly RowBytes[] {
  const row = entry.input.get('row');
  if (row === undefined || row === null) return [];
  const bytes = encoder.encode(stringField(entry.input, 'row_canonical'));
  return [
    {
      id: stringField(entry.input, 'finding_id'),
      canonical: decoder.decode(bytes),
      sha256: sha256Hex(bytes),
    },
  ];
}

function expectedEffects(entry: FindingDeliveryCase): unknown[] {
  return effectsFrom(entry.expect).map((effect) => toPlainJson(effect));
}

function actualEffects(effects: MemoryEffects): unknown[] {
  return effects.entries.map((effect) => toPlainJson(effect));
}

function expectedOutboxIds(entry: FindingDeliveryCase): string[] {
  return optionalArrayField(entry.expect, 'outbox').map((value) =>
    requireString(value, 'outbox id'),
  );
}

function actualOutboxIds(outboxFiles: MemoryOutboxFiles): string[] {
  return [...outboxFiles.pending.keys()].sort();
}

function assertKind(result: FindingHandoffResult, expectation: EffectExpectation): void {
  expect(result.kind).toBe(expectation.kind);
  if (expectation.kind === 'refused') {
    if (result.kind !== 'refused') throw new Error(`expected refused, got ${result.kind}`);
    expect(result.refusal).toBe(expectation.refusal);
  }
}

const effectCases = loadFindingDeliveryVectors().filter(
  (entry) => entry.family === 'handoff' && stringField(entry.input, 'mode') === 'effect',
);

function caseNamed(name: string): FindingDeliveryCase {
  const found = effectCases.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing handoff effect vector ${name}`);
  return found;
}

describe('canonical handoff effect vectors', () => {
  test('the Python handoff effect oracle contains exactly the expected cases', () => {
    expect(effectCases.map((entry) => entry.name).sort()).toEqual(
      Object.keys(EFFECT_EXPECTATIONS).sort(),
    );
  });

  test.each(effectCases)('$name matches raw row bytes, effects and retained ids', async (entry) => {
    const fixture = seed(entry);
    const inbox = new FindingInbox(fixture.files);
    const result = await inbox.handoff(fixture.outbox, inputFor(entry));

    assertKind(result, expectationFor(entry.name));
    expect(actualRows(fixture.files), `${entry.name}: rows`).toEqual(expectedRows(entry));
    expect(actualEffects(fixture.effects), `${entry.name}: effects`).toEqual(
      expectedEffects(entry),
    );
    expect(actualOutboxIds(fixture.outboxFiles), `${entry.name}: outbox`).toEqual(
      expectedOutboxIds(entry),
    );
    fixture.effects.assertBalanced();
  });

  test('the documented Python classes stay distinct from the typed refusals', () => {
    const divergences = [
      ['handoff-missing-row', 'FileNotFoundError', 'canonical-handoff-unavailable'],
      ['handoff-receipt-not-object', 'AttributeError', 'canonical-handoff-unavailable'],
      ['handoff-receipt-missing', 'IntegrityError', 'canonical-handoff-mismatch'],
      ['handoff-stale-owner', 'IntegrityError', 'canonical-handoff-mismatch'],
    ] as const;
    for (const [name, pythonClass, refusal] of divergences) {
      const entry = caseNamed(name);
      expect(stringField(entry.expect, 'error'), name).toBe(pythonClass);
      const expectation = expectationFor(name);
      expect(expectation.kind, name).toBe('refused');
      if (expectation.kind !== 'refused') throw new Error(`${name}: expected refused`);
      expect(expectation.refusal, name).toBe(refusal);
    }
  });

  test('an identity mismatch refuses before retained, lock, read or spool', async () => {
    const entry = caseNamed('handoff-identity-finding-mismatch');
    const fixture = seed(entry);
    const publication = new PoisonPublication();
    const inbox = new FindingInbox(fixture.files);

    const result = await inbox.handoff(publication, inputFor(entry));

    assertKind(result, expectationFor(entry.name));
    expect(publication.retainedCalls).toBe(0);
    expect(publication.spoolCalls).toBe(0);
    expect(actualEffects(fixture.effects)).toEqual([]);
    expect(actualRows(fixture.files)).toEqual(expectedRows(entry));
    fixture.effects.assertBalanced();
  });

  test('a missing row is a typed refusal with no write or spool', async () => {
    const entry = caseNamed('handoff-missing-row');
    const fixture = seed(entry);
    const inbox = new FindingInbox(fixture.files);

    const result = await inbox.handoff(fixture.outbox, inputFor(entry));

    assertKind(result, expectationFor(entry.name));
    expect(actualOutboxIds(fixture.outboxFiles)).toEqual([]);
    const writes = fixture.effects.entries.filter((effect) => effect.get('kind') === 'write');
    expect(writes).toEqual([]);
    fixture.effects.assertBalanced();
  });

  test('an undecodable row is a typed unavailable refusal, not a write', async () => {
    const entry = caseNamed('handoff-written');
    const fixture = seed(entry);
    fixture.files.triage.set(
      stringField(entry.input, 'finding_id'),
      new Uint8Array([0x7b, 0xff, 0x7d]),
    );
    fixture.effects.reset();
    const inbox = new FindingInbox(fixture.files);

    const result = await inbox.handoff(fixture.outbox, inputFor(entry));

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error(`expected refused, got ${result.kind}`);
    expect(result.refusal).toBe('canonical-handoff-unavailable');
    expect(actualOutboxIds(fixture.outboxFiles)).toEqual([]);
    const kinds = fixture.effects.entries.map((effect) => effect.get('kind'));
    expect(kinds).toEqual(['lock', 'lock', 'lock', 'read', 'lock']);
    fixture.effects.assertBalanced();
  });

  test('a non-object row is a typed unavailable refusal', async () => {
    const entry = caseNamed('handoff-written');
    const fixture = seed(entry);
    fixture.files.triage.set(stringField(entry.input, 'finding_id'), encoder.encode('[]'));
    fixture.effects.reset();
    const inbox = new FindingInbox(fixture.files);

    const result = await inbox.handoff(fixture.outbox, inputFor(entry));

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error(`expected refused, got ${result.kind}`);
    expect(result.refusal).toBe('canonical-handoff-unavailable');
    expect(actualOutboxIds(fixture.outboxFiles)).toEqual([]);
    fixture.effects.assertBalanced();
  });

  test('a spool failure propagates and leaves the row untouched', async () => {
    const entry = caseNamed('handoff-written');
    const fixture = seed(entry);
    const inbox = new FindingInbox(fixture.files);
    const publication = new FailingPublication(undefined, 'spool failed');

    await expect(inbox.handoff(publication, inputFor(entry))).rejects.toThrow('spool failed');

    expect(actualRows(fixture.files)).toEqual(beforeRows(entry));
    expect(actualOutboxIds(fixture.outboxFiles)).toEqual([]);
    const writes = fixture.effects.entries.filter((effect) => effect.get('kind') === 'write');
    expect(writes).toEqual([]);
    fixture.effects.assertBalanced();
  });

  test('a retained failure propagates before any lock', async () => {
    const entry = caseNamed('handoff-written');
    const fixture = seed(entry);
    const inbox = new FindingInbox(fixture.files);
    const publication = new FailingPublication('retained failed', undefined);

    await expect(inbox.handoff(publication, inputFor(entry))).rejects.toThrow('retained failed');

    expect(actualEffects(fixture.effects)).toEqual([]);
    expect(actualRows(fixture.files)).toEqual(beforeRows(entry));
    fixture.effects.assertBalanced();
  });

  test('a triage read failure propagates after the recover lock closes', async () => {
    const entry = caseNamed('handoff-written');
    const fixture = seed(entry);
    fixture.effects.reset();
    fixture.files.readFailures = 1;
    const inbox = new FindingInbox(fixture.files);

    await expect(inbox.handoff(fixture.outbox, inputFor(entry))).rejects.toThrow(
      'triage read failed',
    );

    expect(actualOutboxIds(fixture.outboxFiles)).toEqual([]);
    expect(actualRows(fixture.files)).toEqual(beforeRows(entry));
    fixture.effects.assertBalanced();
  });

  test('a row write failure leaves the event retained; retry recovers then is idempotent', async () => {
    const written = caseNamed('handoff-written');
    const recovered = caseNamed('handoff-recovered-after-crash');
    const fixture = seed(written);
    const findingId = stringField(written.input, 'finding_id');
    fixture.files.writeFailures = 1;
    const inbox = new FindingInbox(fixture.files);

    await expect(inbox.handoff(fixture.outbox, inputFor(written))).rejects.toThrow(
      'triage write failed',
    );
    // Durable event exists before the local row transition.
    expect(actualOutboxIds(fixture.outboxFiles)).toEqual(expectedOutboxIds(written));
    expect(decoder.decode(fixture.files.triage.get(findingId))).toBe(
      stringField(written.input, 'row_canonical'),
    );
    fixture.effects.assertBalanced();

    fixture.effects.reset();
    const retry = await inbox.handoff(fixture.outbox, inputFor(written));

    expect(retry.kind).toBe('already-handed-off');
    expect(actualRows(fixture.files), 'recovered row').toEqual(expectedRows(recovered));
    expect(actualEffects(fixture.effects), 'retry effects').toEqual(expectedEffects(recovered));
    expect(actualOutboxIds(fixture.outboxFiles), 'no second event').toEqual(
      expectedOutboxIds(recovered),
    );
    fixture.effects.assertBalanced();
  });

  test('repeated handoff after success spools nothing and writes nothing', async () => {
    const entry = caseNamed('handoff-written');
    const fixture = seed(entry);
    const inbox = new FindingInbox(fixture.files);

    const first = await inbox.handoff(fixture.outbox, inputFor(entry));
    expect(first.kind).toBe('written');
    const afterFirst = actualRows(fixture.files);
    const outboxAfterFirst = actualOutboxIds(fixture.outboxFiles);
    expect(outboxAfterFirst).toHaveLength(1);
    fixture.effects.assertBalanced();

    fixture.effects.reset();
    const second = await inbox.handoff(fixture.outbox, inputFor(entry));

    expect(second.kind).toBe('already-handed-off');
    expect(actualRows(fixture.files)).toEqual(afterFirst);
    expect(actualOutboxIds(fixture.outboxFiles)).toEqual(outboxAfterFirst);
    const writes = fixture.effects.entries.filter((effect) => effect.get('kind') === 'write');
    expect(writes).toEqual([]);
    fixture.effects.assertBalanced();
  });

  test('the injected inbox exposes handoff alongside ingest and recover', () => {
    const inbox = new FindingInbox(new MemoryFiles(new MemoryEffects()));
    expect(typeof inbox.handoff).toBe('function');
    expect(typeof inbox.ingest).toBe('function');
    expect(typeof inbox.recover).toBe('function');
  });
});
