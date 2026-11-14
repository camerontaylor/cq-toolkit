// Real-filesystem tests for the crq.write_status adapter: strict reads,
// plain writes for status.md/status.json, the paseo schedule probe through
// the injected command port, the summary publish through the shared A1
// pipeline, and the summary_failed event isolation.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { runStatusWriter } from '../../../src/adapters/crq/statusWriter.js';
import { fileStatusWriterEffects } from '../../../src/adapters/crq/statusWriter.js';
import { resolveComposerSeams } from '../../../src/adapters/crq/statusWriter.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  toPlainJsonRetainingNumbers,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  parseConfig,
  validateQueue,
  validateQueueExact,
  writeStatusForDocuments,
} from '../../../src/ops/crq/statusWriter.js';
import { mergedCurrent } from '../../../src/policy/crq/statusSummary.js';
import { parseCrqState } from '../../../src/policy/crq/state.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';

/** JSON text for a lossless queue record: numbers render through JsonNumber. */
function toQueueText(queue: Record<string, unknown>): string {
  return pythonJsonText(queue, {
    asciiOnly: true,
    sortKeys: false,
    keyOrder: 'insertion',
    indent: 2,
    trailingNewline: true,
  });
}

const NOW = 1_763_000_000;
const NOW_STAMP = '2025-11-13T02:13:20Z';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRoots(): Promise<{
  runnerRoot: string;
  stateRoot: string;
  xdgStateHome: string;
  home: string;
}> {
  const runnerRoot = await mkdtemp(join(tmpdir(), 'crq-status-runner-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'crq-status-state-'));
  const xdgStateHome = await mkdtemp(join(tmpdir(), 'crq-status-xdg-'));
  cleanups.push(runnerRoot, stateRoot, xdgStateHome);
  await mkdir(join(stateRoot, 'receipts'), { recursive: true });
  return { runnerRoot, stateRoot, xdgStateHome, home: '/unused-home' };
}

const CONFIG = {
  repo: 'owner/main',
  max_starts_per_hour: 12,
  merged_min_survival: 0.5,
  merged_min_surviving_lines: 10,
  error_backoff_min: 30,
};

const QUEUE = {
  created_at: '2025-11-01T00:00:00Z',
  items: [
    {
      id: 'pr101',
      pr: 101,
      kind: 'open',
      tier: 1,
      order: 0,
      prior_cycles: 0,
      state: 'pending',
      cycles: [],
      attempts: [],
      notes: [],
    },
  ],
  starts: [],
  paused: false,
  author_requests: {},
  author_observations: [],
  last_tick: '2025-11-13T01:00:00Z',
};

async function seedRoots(stateRoot: string, runnerRoot: string): Promise<void> {
  await writeFile(join(stateRoot, 'queue.json'), `${JSON.stringify(QUEUE, null, 2)}\n`);
  await writeFile(join(runnerRoot, 'config.json'), `${JSON.stringify(CONFIG, null, 2)}\n`);
  await writeFile(
    join(stateRoot, 'events.jsonl'),
    `{"at": "2025-11-13T01:00:10Z", "event": "tick", "detail": "ok"}\n`,
  );
}

describe('runStatusWriter over a real state root', () => {
  it('writes status.md and a schema-valid status.json, then prints the markdown', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runStatusWriter(
      roots,
      {
        write: (text) => stdout.push(text),
        error: (text) => stderr.push(text),
      },
      () => NOW,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const markdown = stdout.join('');
    expect(markdown).toContain(`# CodeRabbit review queue — status (${NOW_STAMP})`);
    expect(markdown).toContain('- queue: active');
    expect(markdown).toContain('- open-PR CLI reviews still owed: 1');
    expect(markdown).toContain('| pr101 |  | open t1 | pending | 0/1 |');
    expect(markdown).toContain('- last tick: 2025-11-13T01:00:00Z');

    const writtenMarkdown = await readFile(join(roots.stateRoot, 'status.md'), 'utf8');
    // Python `"\n".join(md)`: exactly one trailing newline (the assembly's
    // final empty element), never two.
    expect(writtenMarkdown).toBe(markdown);
    expect(writtenMarkdown.endsWith('\n\n')).toBe(false);

    const statusText = await readFile(join(roots.stateRoot, 'status.json'), 'utf8');
    expect(statusText.endsWith('\n')).toBe(true);
    const accepted = parseCrqState('status.schema.json', statusText);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      const document = accepted.value as Record<string, unknown>;
      expect(document['generated_at']).toBe(NOW_STAMP);
      expect(document['paused']).toBe(false);
      const items = document['items'] as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0]!['id']).toBe('pr101');
      expect(items[0]!['repo']).toBe('owner/main');
      // RAW kind: the table row above renders the decorated `open t1`, but
      // Python copies `i.get("kind")` into status.json, so the projection
      // must publish `open` (fails with `open t1` on the pre-fix code).
      expect(items[0]!['kind']).toBe('open');
    }
  });

  it('publishes the summary through the shared pipeline with schema_version 2', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const exitCode = await runStatusWriter(roots, { write: () => {}, error: () => {} }, () => NOW);
    expect(exitCode).toBe(0);
    const summaryPath = join(roots.xdgStateHome, 'crq', 'summary.json');
    const summaryText = await readFile(summaryPath, 'utf8');
    expect(summaryText.endsWith('\n')).toBe(true);
    const summary = JSON.parse(summaryText) as Record<string, unknown>;
    expect(summary['schema_version']).toBe(2);
    expect(summary['generated_at']).toBe(NOW_STAMP);
    expect(summary['last_tick']).toBe('2025-11-13T01:00:00Z');
    expect(summary['schedule']).toEqual({ id: 'crq-tick.timer', state: 'systemd' });
  });

  it('isolates a publish failure into the summary_failed event', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    // A queue without a last tick makes the summary composer refuse (the
    // producer's ValueError path) while the status writes still succeed.
    const unticked = { ...QUEUE, last_tick: undefined };
    await writeFile(join(roots.stateRoot, 'queue.json'), `${JSON.stringify(unticked)}\n`);
    const exitCode = await runStatusWriter(roots, { write: () => {}, error: () => {} }, () => NOW);
    expect(exitCode).toBe(0);
    const events = await readFile(join(roots.stateRoot, 'events.jsonl'), 'utf8');
    const lines = events.trimEnd().split('\n');
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(last['event']).toBe('summary_failed');
    expect(typeof last['error']).toBe('string');
    // The status artifacts still exist: the failure is publish-local.
    await expect(readFile(join(roots.stateRoot, 'status.md'), 'utf8')).resolves.toContain(
      '# CodeRabbit review queue',
    );
  });

  it('refuses a corrupt queue with the schema message and exit 1', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    await writeFile(join(roots.stateRoot, 'queue.json'), '{"items": "not-a-list"}');
    const stderr: string[] = [];
    const exitCode = await runStatusWriter(
      roots,
      { write: () => {}, error: (text) => stderr.push(text) },
      () => NOW,
    );
    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('status-writer:');
    expect(stderr.join('')).toContain('rejected');
  });

  it('passes queue.json and events.jsonl bytes through unmodified on success', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const beforeQueue = await readFile(join(roots.stateRoot, 'queue.json'), 'utf8');
    const beforeEvents = await readFile(join(roots.stateRoot, 'events.jsonl'), 'utf8');
    await runStatusWriter(roots, { write: () => {}, error: () => {} }, () => NOW);
    expect(await readFile(join(roots.stateRoot, 'queue.json'), 'utf8')).toBe(beforeQueue);
    expect(await readFile(join(roots.stateRoot, 'events.jsonl'), 'utf8')).toBe(beforeEvents);
  });

  it('binds the paseo schedule probe through the injected command port', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    await writeFile(
      join(roots.runnerRoot, 'config.json'),
      `${JSON.stringify({ ...CONFIG, schedule_id: 'crq-tick' }, null, 2)}\n`,
    );
    const effects = fileStatusWriterEffects(
      roots,
      async (argv) => (argv[1] === 'schedule' ? '{"status":"active","nextRunAt":"soon"}' : null),
      () => NOW,
    );
    const seams = await resolveComposerSeams(
      roots.stateRoot,
      JSON.parse(await readFile(join(roots.stateRoot, 'queue.json'), 'utf8')) as unknown,
    );
    const { writeStatus } = await import('../../../src/ops/crq/statusWriter.js');
    const result = await writeStatus({ ...effects, composerSeams: seams });
    expect(result.markdown).toContain(
      '- schedule: `crq-tick` active · next run soon · last run None',
    );
    // The live probe dict reaches the publish seam: state is the probe's,
    // never a hardcoded systemd default.
    const summaryText = await readFile(join(roots.xdgStateHome, 'crq', 'summary.json'), 'utf8');
    const summary = JSON.parse(summaryText) as Record<string, unknown>;
    expect(summary['schedule']).toEqual({ id: 'crq-tick', state: 'active' });
  });

  it('captures drainable repair stems so the digest reads their bytes', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    await mkdir(join(roots.stateRoot, 'repair', 'inbox'), { recursive: true });
    // Valid JSON: the digest parses the job content inline (a plain string
    // would be the producer's JSONDecodeError refusal, a different path).
    await writeFile(join(roots.stateRoot, 'repair', 'inbox', 'crq-fix.json'), '{"job": "crq-fix"}');
    const queue = {
      ...QUEUE,
      items: [
        ...QUEUE.items,
        {
          id: 'rep1',
          kind: 'merged',
          state: 'pending',
          repair_runs: { 'crq-fix': { state: 'queued', jobs: ['crq-fix'] } },
          cycles: [],
          attempts: [],
          notes: [],
        },
      ],
    };
    await writeFile(join(roots.stateRoot, 'queue.json'), `${JSON.stringify(queue, null, 2)}\n`);
    const seams = await resolveComposerSeams(roots.stateRoot, queue);
    const entry = seams.inbox.entries.find((candidate) => candidate.stem === 'crq-fix');
    expect(entry).toBeDefined();
    expect(entry?.jobBytes).not.toBeNull();
    expect(new TextDecoder().decode(entry?.jobBytes ?? new Uint8Array())).toBe(
      '{"job": "crq-fix"}',
    );

    // The production wiring regression: runStatusWriter itself (not the
    // caller) must feed the lenient queue read to resolveComposerSeams, so
    // a queued repair job captures its job bytes without any explicit queue
    // argument. Without the wiring, repairDigest's job-content gate raises
    // where Python opens the file inline, and the whole run refuses.
    await runStatusWriter(roots, { write: () => {}, error: () => {} }, () => NOW);
    const markdown = await readFile(join(roots.stateRoot, 'status.md'), 'utf8');
    expect(markdown).toContain('## Repair and utilization');
    expect(markdown).not.toContain('OSError');
  });

  it('selects the drainable stems from the same queue revision the route runs', async () => {
    // Round-3 P2 regression: the seam stem selection and the route must
    // share one queue read. If the adapter read queue.json twice (a lenient
    // read for the seams, the route's own strict read after), a concurrent
    // tick swapping queue.json between the reads would select stems from
    // the old revision while the route digests the new one, and a newly
    // queued repair job's bytes would never be captured: repairDigest
    // refuses with a spurious OSError where Python, which reads queue.json
    // once and opens the job inline over that same q, succeeds.
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    await mkdir(join(roots.stateRoot, 'repair', 'inbox'), { recursive: true });
    await writeFile(join(roots.stateRoot, 'repair', 'inbox', 'crq-fix.json'), '{"job": "crq-fix"}');
    const tickedQueue = {
      ...QUEUE,
      items: [
        ...QUEUE.items,
        {
          id: 'rep1',
          kind: 'merged',
          state: 'pending',
          repair_runs: { 'crq-fix': { state: 'queued', jobs: ['crq-fix'] } },
          cycles: [],
          attempts: [],
          notes: [],
        },
      ],
    };
    const tickedBytes = toQueueText(tickedQueue);
    // Race injection at the filesystem layer: the first queue read sees the
    // pre-tick revision (seedRoots bytes), and every later read sees the
    // post-tick revision, exactly as if a tick swapped queue.json between
    // the adapter's two reads. Only the one-read wiring passes both
    // consumers the same bytes, so the seams capture the job bytes the
    // post-tick route digest needs and the run succeeds.
    let queueReads = 0;
    const effects = fileStatusWriterEffects(
      roots,
      async () => null,
      () => NOW,
    );
    const racingEffects = {
      ...effects,
      readQueue: async (): Promise<string> => {
        queueReads += 1;
        if (queueReads === 1) {
          await writeFile(join(roots.stateRoot, 'queue.json'), tickedBytes);
          return await readFile(join(roots.stateRoot, 'queue.json'), 'utf8');
        }
        return await readFile(join(roots.stateRoot, 'queue.json'), 'utf8');
      },
    };
    const queueText = await racingEffects.readQueue();
    expect(queueReads).toBe(1);
    const documents = {
      queue: validateQueue(queueText),
      config: parseConfig(await racingEffects.readConfig()),
      queueExact: validateQueueExact(queueText),
    };
    // Old shape: the pre-tick first read selects no stems (the pre-tick
    // queue references no jobs), so the entry would carry jobBytes null and
    // the post-tick digest would refuse with OSError.
    const seams = await resolveComposerSeams(roots.stateRoot, documents.queue);
    const entry = seams.inbox.entries.find((candidate) => candidate.stem === 'crq-fix');
    expect(entry?.jobBytes).not.toBeNull();
    const result = await writeStatusForDocuments(
      { ...racingEffects, composerSeams: seams },
      documents,
    );
    expect(result.markdown).toContain('## Repair and utilization');
    expect(result.markdown).not.toContain('OSError');
  });

  it('refuses a queue with invalid UTF-8 like Python read_text, not U+FFFD', async () => {
    // The shared snapshot must come from effects.readQueue, whose strict
    // decoder rejects invalid UTF-8 exactly as Python's Path.read_text()
    // raises. A direct readFile('utf8') would silently replace the bad
    // bytes with U+FFFD and publish altered ids/paths instead of refusing.
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const corrupt = Buffer.from(await readFile(join(roots.stateRoot, 'queue.json')));
    corrupt[corrupt.indexOf(0x22, corrupt.indexOf('id'))] = 0xff;
    await writeFile(join(roots.stateRoot, 'queue.json'), corrupt);
    const stderr: string[] = [];
    const exitCode = await runStatusWriter(
      roots,
      { write: () => {}, error: (text) => stderr.push(text) },
      () => NOW,
    );
    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('status-writer:');
    expect(stderr.join('')).not.toContain('\ufffd');
  });

  it('keeps the composer seam reads on the state root', async () => {
    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    const seams = await resolveComposerSeams(roots.stateRoot);
    expect(seams.triageRows).toEqual([]);
    expect(seams.inbox.entries).toEqual([]);
  });

  it('publishes float-lexeme queue paths as verified, not unverified', async () => {
    // Round-2 P2 regression: the summary pipeline hashes capture paths
    // through receiptJsonDigest, which distinguishes the float lexeme 5.0
    // from the int 5. The materialised documents.queue collapses that
    // lexeme, so the adapter must feed publishSummary the exact queue
    // (documents.queueExact). Without it a valid receipt reads
    // `unverified` where Python publishes `proven_terminal`.
    const fixture = parseJsonValue(
      readFileSync('apps/crq-python/fixtures/a1-status/passthrough-receipt.json', 'utf8'),
    );
    if (!(fixture instanceof JsonObject)) throw new Error('fixture root is not an object');
    const cases = fixture.get('cases');
    if (!Array.isArray(cases) || !(cases[0] instanceof JsonObject)) {
      throw new Error('fixture has no case 0');
    }
    const input = cases[0].get('input');
    if (!(input instanceof JsonObject)) throw new Error('fixture case has no input');
    // The exact queue: every number lossless (the fixture loader's pattern).
    const exactQueue = toPlainJsonRetainingNumbers(input.get('queue') as JsonValue) as Record<
      string,
      unknown
    >;
    // The same queue fully materialised: `bytes: 5.0` collapsed to `5`.
    const materializedQueue = toPlainJson(input.get('queue') as JsonValue) as Record<
      string,
      unknown
    >;
    const receiptBytes = new Map<string, Uint8Array>();
    const encoded = input.get('receipt_bytes');
    if (encoded instanceof JsonObject) {
      for (const [id, base64] of encoded.entries) {
        if (typeof base64 !== 'string') throw new Error('receipt bytes not text');
        receiptBytes.set(id, new Uint8Array(Buffer.from(base64, 'base64')));
      }
    }
    const readReceipt = (receiptId: string) => receiptBytes.get(receiptId) ?? null;

    const roots = await makeRoots();
    await seedRoots(roots.stateRoot, roots.runnerRoot);
    await mkdir(join(roots.stateRoot, 'receipts'), { recursive: true });
    for (const [id, bytes] of receiptBytes) {
      await writeFile(join(roots.stateRoot, 'receipts', `${id}.json`), bytes);
    }
    // The fixture's items-only receipt document rides on the seeded queue;
    // the fixture item carries no id (the vector strips it), so give it the
    // id Python's live queue rows always carry. Re-encode losslessly:
    // JsonNumber bigint values are not valid JSON.stringify input, but the
    // fixture only carries safe integers (subject.pr = 1).
    const mergedItem = (exactQueue['items'] as Record<string, unknown>[]).map((item, index) => ({
      ...item,
      id: `mc${index}`,
      order: index,
    }));
    const queue = {
      ...QUEUE,
      items: [...QUEUE.items, ...mergedItem],
    };
    const queueText = toQueueText(queue);
    await writeFile(join(roots.stateRoot, 'queue.json'), queueText);

    const stderr: string[] = [];
    const exitCode = await runStatusWriter(
      roots,
      { write: () => {}, error: (text) => stderr.push(text) },
      () => NOW,
    );
    expect(`exit=${exitCode} stderr=${stderr.join('').slice(0, 240)}`).toBe('exit=0 stderr=');
    const summaryText = await readFile(join(roots.xdgStateHome, 'crq', 'summary.json'), 'utf8');
    const counts = /"receipts":\{[^}]*\}/.exec(summaryText)?.[0] ?? 'missing';
    // With the exact queue the receipt verifies (Python parity). The
    // materialised-only probe below pins the divergence this guards
    // against: identical bytes, collapsed `5.0` -> `5` -> `unverified`.
    expect(counts).toContain('"proven_terminal":1');
    expect(counts).toContain('"unverified":0');

    // Pin the mechanism: identical bytes, materialised queue only -> the
    // scope digest differs from the retained receipt capture and the item
    // falls to `unverified`.
    const materializedView = mergedCurrent(materializedQueue, readReceipt);
    expect(materializedView.receipts['proven_terminal']).toBe(0);
    expect(materializedView.receipts['unverified']).toBe(1);
  });
});
