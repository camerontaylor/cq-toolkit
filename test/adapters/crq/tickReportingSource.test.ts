// The reporting adapter: the `DeliveryEnv` file/gh ports and the three in-process reporting
// phases (writeStatus, local_review_pr.publish, client_health.record) over a real state root.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileDeliveryEnv,
  fileReportingPhases,
  forgeTimeoutMs,
  pythonOsErrorText,
  readTextReplacing,
  stateReceiptReader,
} from '../../../src/adapters/crq/tickReportingSource.js';
import { DeliveryRuntimeError } from '../../../src/ops/crq/internal/deliverPending.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { type GhPort } from '../../../src/policy/crq/prReviewFindings.js';
import { ReceiptOsError } from '../../../src/policy/crq/receiptPrepare.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const plain = (v: JsonValue | undefined): unknown => (v === undefined ? undefined : toPlainJson(v));
const SHA = 'ab'.repeat(20);

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

const CONFIG = {
  repo: 'owner/main',
  max_starts_per_hour: 12,
  merged_min_survival: 0.5,
  merged_min_surviving_lines: 10,
  error_backoff_min: 30,
};
const QUEUE_ITEM = {
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
};
const QUEUE = {
  created_at: '2025-11-01T00:00:00Z',
  items: [QUEUE_ITEM],
  starts: [],
  paused: false,
  author_requests: {},
  author_observations: [],
  last_tick: '2025-11-13T01:00:00Z',
};

describe('pythonOsErrorText', () => {
  it('renders the errno table the way str(OSError) does', () => {
    expect(pythonOsErrorText({ code: 'ENOENT' }, '/a/b')).toBe(
      "[Errno 2] No such file or directory: '/a/b'",
    );
    expect(pythonOsErrorText({ code: 'EACCES' }, '/a')).toBe("[Errno 13] Permission denied: '/a'");
    expect(pythonOsErrorText({ code: 'EISDIR' }, '/d')).toBe("[Errno 21] Is a directory: '/d'");
  });

  it('escapes quotes in the path and falls back to the message for an unknown code', () => {
    expect(pythonOsErrorText({ code: 'ENOENT' }, "/it's")).toContain("'/it\\'s'");
    const unknown = Object.assign(new Error('weird'), { code: 'EWEIRD', errno: -5 });
    expect(pythonOsErrorText(unknown, '/p')).toBe("[Errno 5] weird: '/p'");
  });
});

describe('readTextReplacing', () => {
  it('decodes invalid UTF-8 with replacement characters, as errors="replace"', async () => {
    const dir = await tmp('crq-rep-');
    const path = join(dir, 'f');
    await writeFile(path, Buffer.from([0x61, 0xff, 0x62]));
    expect(readTextReplacing(path)).toBe('a�b');
  });
});

describe('fileDeliveryEnv', () => {
  const env = (repos: unknown[] = []) =>
    fileDeliveryEnv({ config: doc({ ...CONFIG, repos }), primaryRepo: 'owner/main' });

  it('passes the primary repo through', () => {
    expect(env().primaryRepo).toBe('owner/main');
  });

  it('reads artifact bytes, with a missing file as null and other failures rethrown', async () => {
    const dir = await tmp('crq-del-');
    await writeFile(join(dir, 'a'), 'hi');
    const files = env().files;
    expect(Buffer.from(files.readBytes(join(dir, 'a')) as Uint8Array).toString()).toBe('hi');
    expect(files.readBytes(join(dir, 'missing'))).toBeNull();
    expect(files.readBytes(dir)).toBeNull(); // a directory is EISDIR
  });

  it('maps any other artifact read failure to the receipt OSError, not a raw Node error', async () => {
    const dir = await tmp('crq-del-');
    const loop = join(dir, 'loop');
    await symlink(loop, loop); // ELOOP: neither a missing file nor a directory
    expect(() => env().files.readBytes(loop)).toThrow(ReceiptOsError);
  });

  it('maps a text read failure to the receipt OSError with Python text', async () => {
    const dir = await tmp('crq-del-');
    const path = join(dir, 'nope');
    let thrown: unknown;
    try {
      env().readText(path);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReceiptOsError);
    expect((thrown as ReceiptOsError).pythonError).toBe('OSError');
    expect((thrown as ReceiptOsError).message).toBe(
      `[Errno 2] No such file or directory: '${path}'`,
    );
  });

  describe('push.repoMode', () => {
    const repos = [
      { repo: 'Other/Repo', findings: 'issue' },
      { repo: 'quiet/repo', findings: 'none' },
    ];
    it('is null for the primary and for an unconfigured repo', async () => {
      const push = env(repos).push;
      expect(await push.repoMode('owner/main')).toBeNull();
      expect(await push.repoMode('unknown/repo')).toBeNull();
      expect(await push.repoMode('')).toBeNull();
    });

    it('finds a configured repo case-insensitively and reports its findings mode', async () => {
      const push = env(repos).push;
      expect(await push.repoMode('other/repo')).toEqual({ enabled: true });
      expect(await push.repoMode('QUIET/REPO')).toEqual({ enabled: false });
    });

    it('defaults to issue findings when the entry names none', async () => {
      expect(await env([{ repo: 'x/y' }]).push.repoMode('x/y')).toEqual({ enabled: true });
    });
  });

  it('push.readFindings returns the text and maps a failure to DeliveryRuntimeError', async () => {
    const dir = await tmp('crq-del-');
    const path = join(dir, 'review.ndjson');
    await writeFile(path, '{"a":1}\n');
    const push = env().push;
    expect(await push.readFindings(path)).toBe('{"a":1}\n');
    await expect(push.readFindings(join(dir, 'missing'))).rejects.toThrow(DeliveryRuntimeError);
    await expect(push.readFindings(join(dir, 'missing'))).rejects.toThrow(/\[Errno 2\]/);
  });
});

async function roots() {
  const runnerRoot = await tmp('crq-rep-runner-');
  const stateRoot = await tmp('crq-rep-state-');
  const xdgStateHome = await tmp('crq-rep-xdg-');
  await mkdir(join(stateRoot, 'receipts'), { recursive: true });
  await writeFile(join(runnerRoot, 'config.json'), `${JSON.stringify(CONFIG)}\n`);
  await writeFile(join(stateRoot, 'queue.json'), `${JSON.stringify(QUEUE)}\n`);
  await writeFile(join(stateRoot, 'events.jsonl'), '');
  return { runnerRoot, stateRoot, xdgStateHome, home: '/unused-home' };
}

const NOW_MS = 1_763_000_000_000;
const silentGh: GhPort = (argv) => ({
  returncode: JsonNumber.int(0),
  stdout: argv.join(' ') === 'gh api user --jq .login' ? 'bot\n' : '',
  stderr: '',
});

async function phases(extra: { gh?: GhPort; runnerRoot?: string } = {}) {
  const r = await roots();
  const clone = await tmp('crq-rep-clone-');
  return {
    r,
    phases: fileReportingPhases({
      roots: r,
      config: doc(CONFIG),
      primaryRepo: 'owner/main',
      clone,
      runnerRoot: extra.runnerRoot ?? r.runnerRoot,
      gh: extra.gh ?? silentGh,
      now: () => NOW_MS,
    }),
  };
}

describe('fileReportingPhases', () => {
  it('writeStatus renders the in-memory queue, not the queue.json on disk', async () => {
    const { r, phases: p } = await phases();
    const inMemory = doc({
      ...QUEUE,
      items: [QUEUE_ITEM, { ...QUEUE_ITEM, id: 'pr202', pr: 202, order: 1 }],
    });
    await p.writeStatus(inMemory);
    const markdown = await readFile(join(r.stateRoot, 'status.md'), 'utf8');
    expect(markdown).toContain('| pr202 |');
    expect(markdown).toContain('| pr101 |');
    const status = JSON.parse(await readFile(join(r.stateRoot, 'status.json'), 'utf8')) as unknown;
    expect(status).toBeTypeOf('object');
  });

  it('publishLocalReviewPr saves an observed queue and returns it', async () => {
    const { r, phases: p } = await phases();
    const queue = doc({
      ...QUEUE,
      review_pr_links: {
        k1: { item: 'pr101', repo: 'o/r', pr: 5, head: 'a'.repeat(40), base: 'b'.repeat(40) },
      },
    });
    const next = await p.publishLocalReviewPr(queue);
    const outbox = plain(next.get('review_pr_outbox')) as Record<string, Record<string, unknown>>;
    expect(outbox.k1).toMatchObject({ pending: false, error: null, attempts: 1 });
    const saved = JSON.parse(await readFile(join(r.stateRoot, 'queue.json'), 'utf8')) as {
      review_pr_outbox: Record<string, { pending: boolean }>;
    };
    expect(saved.review_pr_outbox.k1?.pending).toBe(false);
  });

  it('rounds the advisory forge timeout up to a positive integer of milliseconds', () => {
    expect(forgeTimeoutMs(2.5)).toBe(2500);
    expect(forgeTimeoutMs(1.0004)).toBe(1001); // a monotonic-clock remainder is fractional
    expect(forgeTimeoutMs(0.0001)).toBe(1);
    expect(Number.isInteger(forgeTimeoutMs(7.123456789))).toBe(true);
  });

  it('the default receipt reader verifies the content address before returning bytes', async () => {
    const stateRoot = await tmp('crq-rcpt-');
    await mkdir(join(stateRoot, 'receipts'));
    const body = Buffer.from('{"v":1}');
    const id = createHash('sha256').update(body).digest('hex');
    await writeFile(join(stateRoot, 'receipts', `${id}.json`), body);
    const wrong = 'e'.repeat(64);
    await writeFile(join(stateRoot, 'receipts', `${wrong}.json`), body);
    const read = stateReceiptReader(stateRoot);
    expect(Buffer.from(await read(id)).toString()).toBe('{"v":1}');
    await expect(read(wrong)).rejects.toThrow('receipt digest mismatch');
    await expect(read('../x')).rejects.toThrow('invalid receipt id');
    await expect(read('f'.repeat(64))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishLocalReviewPr reads the retained receipt through the injected reader', async () => {
    const r = await roots();
    const clone = await tmp('crq-rep-clone-');
    const requested: string[] = [];
    const p = fileReportingPhases({
      roots: r,
      config: doc(CONFIG),
      primaryRepo: 'owner/main',
      clone,
      runnerRoot: r.runnerRoot,
      gh: silentGh,
      now: () => NOW_MS,
      readReceipt: (id) => {
        requested.push(id);
        return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      },
    });
    const queue = doc({
      ...QUEUE,
      items: [
        {
          ...QUEUE_ITEM,
          state: 'done',
          outcome: 'findings',
          scope_adequate: true,
          receipt_id: 'c'.repeat(64),
        },
      ],
      review_pr_links: {
        k1: { item: 'pr101', repo: 'o/r', pr: 5, head: 'a'.repeat(40), base: 'b'.repeat(40) },
      },
    });
    const next = await p.publishLocalReviewPr(queue);
    const outbox = plain(next.get('review_pr_outbox')) as Record<string, Record<string, unknown>>;
    // No usable retained receipt: the row stays pending with a recorded error, never delivered.
    expect(outbox.k1?.pending).toBe(true);
    expect(outbox.k1?.error).toBeTypeOf('string');
    // The row is adequate, so the failure is the reader's, not an earlier skip.
    expect(requested).toEqual(['c'.repeat(64)]);
  });

  it('recordClientHealth saves the observation with the runner checkout sha', async () => {
    const runner = await tmp('crq-rep-git-');
    await mkdir(join(runner, '.git'), { recursive: true });
    await writeFile(join(runner, '.git', 'HEAD'), `${SHA}\n`);
    const { r, phases: p } = await phases({ runnerRoot: runner });
    const result = await p.recordClientHealth(doc(QUEUE), false);
    expect(result.log).toEqual(['health advisory skipped: discovery not run']);
    const health = plain(result.queue.get('client_health')) as Record<string, unknown>;
    expect(health.sha).toBe(SHA);
    expect(health.completed_at).toBe('2025-11-13T02:13:20Z');
    // Discovery was skipped: the observation is returned for the tick to save, not saved here.
    const disk = JSON.parse(await readFile(join(r.stateRoot, 'queue.json'), 'utf8')) as object;
    expect('client_health' in disk).toBe(false);
  });
});
