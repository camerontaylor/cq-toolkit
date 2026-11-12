/**
 * Real-filesystem tests for the finding store adapter.
 *
 * Every test binds a temporary directory: the inbox lock is a real persistent
 * flock, triage and pending writes are atomic, and artifacts live in their own
 * durable root. Oracle parity is checked with the committed repair-harvest
 * fixture, not with a hand-written expectation.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  fileArtifactStore,
  fileFindingInbox,
  fileFindingPublication,
  fileFindingStore,
} from '../../../src/adapters/crq/findingStore.js';
import { FindingInbox } from '../../../src/ops/review/internal/crq/findingInbox.js';
import { withLock } from '../../../src/adapters/crq/lock.js';
import {
  ledgerCanonicalBytes,
  ledgerDigestOf,
  ledgerEvent,
  ledgerLoads,
  ledgerValueEqual,
} from '../../../src/policy/crq/ledger.js';
import { JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';

const FIXTURE = new URL(
  '../../../apps/crq-python/fixtures/repair-harvest/cases.json',
  import.meta.url,
);
const AT = '2026-11-12T00:00:00Z';
const SHA = 'a'.repeat(40);

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'crq-finding-store-'));
  temporary.push(path);
  return path;
}

function object(value: JsonValue | undefined, what: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${what} is not an object`);
  return value;
}

function array(value: JsonValue | undefined, what: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}

function text(value: JsonValue | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}

function fixture(): JsonObject {
  return object(ledgerLoads(readFileSync(FIXTURE, 'utf8')), 'fixture');
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

function parsed(value: unknown): JsonValue {
  return ledgerLoads(JSON.stringify(value));
}

function namedCase(key: 'mark_cases' | 'harvest_cases', name: string): JsonObject {
  const found = array(fixture().get(key), key).find(
    (value) => value instanceof JsonObject && value.get('name') === name,
  );
  return object(found, name);
}

describe('artifact store', () => {
  test('puts, replays, verifies and refuses corruption or escape', async () => {
    const root = await tempRoot();
    const store = fileArtifactStore(join(root, 'durable'));
    const data = Buffer.from('retained artifact\n');
    const reference = await store.put(data);
    expect(reference.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(reference.location).toBe(join(root, 'durable', 'sha256', reference.sha256));

    await expect(store.verify(reference)).resolves.toBeUndefined();
    await expect(store.put(data)).resolves.toEqual(reference);

    const other = await store.put(Buffer.from('other artifact\n'));
    expect(other.sha256).not.toBe(reference.sha256);

    await writeFile(reference.location, 'corrupt\n');
    await expect(store.verify(reference)).rejects.toThrow('missing or corrupt retained artifact');
    await expect(store.put(data)).rejects.toThrow('artifact store corruption');

    await unlink(reference.location);
    await expect(store.verify(reference)).rejects.toThrow('missing or corrupt retained artifact');
    await expect(
      store.verify({ ...reference, location: join(root, 'outside', reference.sha256) }),
    ).rejects.toThrow('artifact outside configured durable store');
  });
});

describe('finding inbox', () => {
  test('applies the fixture transition with byte-identical canonical rows', async () => {
    const root = await tempRoot();
    const chosen = namedCase('mark_cases', 'merged-fixed-writes-fixed');
    const findingId = text(
      object(chosen.get('row_before'), 'row_before').get('canonical_id'),
      'id',
    );
    const event = object(array(chosen.get('events_added'), 'events_added')[0], 'added event');

    const files = fileFindingInbox(join(root, 'backfill', 'findings'));
    const publication = fileFindingPublication({
      root: join(root, 'backfill', 'publication'),
      artifacts: fileArtifactStore(join(root, 'durable')),
    });
    await files.writeTriage(
      findingId,
      ledgerCanonicalBytes(object(chosen.get('row_before'), 'row')),
    );
    await publication.spool(event);

    const recovery = await new FindingInbox(files).recover(await publication.retained());
    expect(recovery.written).toEqual([text(event.get('id'), 'event id')]);
    expect(recovery.pending).toEqual([]);

    const row = await files.readTriage(findingId);
    expect(row).not.toBeNull();
    expect(Buffer.from(row as Uint8Array)).toEqual(
      Buffer.from(ledgerCanonicalBytes(object(chosen.get('row_after'), 'row_after'))),
    );
    expect(
      ledgerValueEqual(ledgerLoads(row as Uint8Array), chosen.get('row_after') as JsonValue),
    ).toBe(true);
  });

  test('retains pending events in filename order regardless of spool order', async () => {
    const root = await tempRoot();
    const chosen = namedCase('harvest_cases', 'retry-bound-reached');
    const retained = array(chosen.get('retained_before'), 'retained_before');
    const publication = fileFindingPublication({
      root: join(root, 'publication'),
      artifacts: fileArtifactStore(join(root, 'durable')),
    });

    for (const index of retained.map((_, position) => position).reverse()) {
      await publication.spool(retained[index] as JsonValue);
    }

    const values = await publication.retained();
    const ids = values.map((value) => text(object(value, 'event').get('id'), 'event id'));
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(retained.length);
    const names = (await readdir(join(root, 'publication', 'pending'))).sort();
    expect(names).toEqual(ids.map((id) => `${id}.json`));
    for (const value of retained) {
      expect(values.some((candidate) => ledgerValueEqual(candidate, value as JsonValue))).toBe(
        true,
      );
    }
  });

  test('holds findings.lock for the whole callback', async () => {
    const root = await tempRoot();
    const files = fileFindingInbox(join(root, 'findings'));
    const entered = deferred();
    const release = deferred();
    const first = files.withLock(async () => {
      entered.resolve();
      await release.promise;
      return 'first';
    });
    await entered.promise;

    let secondEntered = false;
    const second = files.withLock(async () => {
      secondEntered = true;
      return 'second';
    });
    await delay(50);
    const blocked = secondEntered;
    release.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(blocked).toBe(false);
    expect(secondEntered).toBe(true);
    expect(await readFile(join(root, 'findings', 'findings.lock'))).toEqual(Buffer.alloc(0));
  });
});

describe('finding publication', () => {
  test('holds outbox.lock across the replay check and pending write', async () => {
    const root = await tempRoot();
    const publicationRoot = join(root, 'publication');
    const event = object(
      array(namedCase('mark_cases', 'merged-fixed-writes-fixed').get('events_added'), 'events')[0],
      'event',
    );
    const publication = fileFindingPublication({
      root: publicationRoot,
      artifacts: fileArtifactStore(join(root, 'durable')),
    });

    await mkdir(publicationRoot, { recursive: true });
    const entered = deferred();
    const release = deferred();
    const holding = withLock(join(publicationRoot, 'outbox.lock'), { wait: true }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const spooling = publication.spool(event);
    let settled = false;
    spooling
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await delay(50);
    const blocked = !settled;
    release.resolve();
    await holding;
    await expect(spooling).resolves.toBe(text(event.get('id'), 'event id'));
    expect(blocked).toBe(true);
    expect(await readdir(join(publicationRoot, 'pending'))).toEqual([
      `${text(event.get('id'), 'event id')}.json`,
    ]);
  });

  test('accepts replay and refuses different bytes at the same event id', async () => {
    const root = await tempRoot();
    const publication = fileFindingPublication({
      root: join(root, 'publication'),
      artifacts: fileArtifactStore(join(root, 'durable')),
    });
    const caseValue = namedCase('mark_cases', 'merged-fixed-writes-fixed');
    const event = object(array(caseValue.get('events_added'), 'events')[0], 'event');
    const payload = object(event.get('payload'), 'payload');
    const id = await publication.spool(event);
    await expect(publication.spool(event)).resolves.toBe(id);

    const different = ledgerEvent(
      'finding-event',
      text(event.get('source_key'), 'source key'),
      text(event.get('occurred_at'), 'occurred_at'),
      parsed({
        action: 'fixed',
        actor: 'crq-repair',
        evidence: {
          failure_class: 'exhausted',
          fix_pr: 8,
          fixing_commit: 'd'.repeat(40),
          reason: 'verified merge',
          repair_base: 'c'.repeat(40),
          repair_task: 'crq-repair-F1',
          verification: 'verified merge',
        },
        finding_id: text(payload.get('finding_id'), 'finding id'),
        previous_event_id: text(payload.get('previous_event_id'), 'previous id'),
        review_id: text(payload.get('review_id'), 'review id'),
      }),
    );
    expect(text(different.get('id'), 'different id')).not.toBe(id);
    await writeFile(
      join(root, 'publication', 'pending', `${id}.json`),
      ledgerCanonicalBytes(different),
    );
    await expect(publication.spool(event)).rejects.toThrow('outbox replay conflict');
  });

  test('refuses an event whose retained artifact is missing', async () => {
    const root = await tempRoot();
    const durable = join(root, 'durable');
    const artifacts = fileArtifactStore(durable);
    const data = Buffer.from('review artifact\n');
    const reference = await artifacts.put(data);
    const rows = [{ path: 'src/a.ts', blob: SHA, intervals: [[1, 2]] }];
    const scope = parsed(rows);
    const reviewPayload = (artifact: { sha256: string; location: string }): JsonValue =>
      parsed({
        repo: 'camerontaylor/cq-toolkit',
        subject_id: 'subject',
        job_id: 'subject:0',
        attempt_id: 'subject:0:1',
        source: {
          repo: 'camerontaylor/cq-toolkit',
          producer: 'crq-runner-app',
          type: 'crq-run',
          id: 'run-1',
          authenticated: true,
        },
        base: SHA,
        head: SHA,
        head_tree: SHA,
        target: SHA,
        target_tree: SHA,
        policy_digest: 'b'.repeat(64),
        scope_digest: ledgerDigestOf(scope),
        paths: [
          {
            path: 'src/a.ts',
            blob: SHA,
            mode: '100644',
            disposition: 'included',
            reason: 'verified',
            baseline: {},
          },
        ],
        requested_scope: rows,
        input_scope: rows,
        reviewed_scope: rows,
        completion: {
          terminal: true,
          skipped: false,
          scope_verified: true,
          exit_code: 0,
          errors: [],
        },
        outcome: 'completed',
        artifacts: [artifact],
        findings: [],
      });
    const key = 'camerontaylor/cq-toolkit:crq-runner-app:run-1';
    const accepted = ledgerEvent('review', key, AT, reviewPayload(reference));
    const publication = fileFindingPublication({ root: join(root, 'publication'), artifacts });
    await expect(publication.spool(accepted)).resolves.toBe(text(accepted.get('id'), 'id'));

    const missing = ledgerEvent(
      'review',
      key,
      AT,
      reviewPayload({ sha256: 'f'.repeat(64), location: join(durable, 'sha256', 'f'.repeat(64)) }),
    );
    await expect(publication.spool(missing)).rejects.toThrow(
      'missing or corrupt retained artifact',
    );
  });
});

test('composes the documented state and durable roots', async () => {
  const root = await tempRoot();
  const store = fileFindingStore({
    stateRoot: join(root, 'state'),
    durableArtifactRoot: join(root, 'durable'),
  });
  expect(await store.publication.retained()).toEqual([]);
  expect(await store.files.readTriage('a'.repeat(64))).toBeNull();
  expect(await readdir(join(root, 'durable')).catch(() => [])).toEqual([]);
});
