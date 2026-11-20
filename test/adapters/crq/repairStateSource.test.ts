import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonNumber, JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  fileRepairStateEffects,
  RepairQueueUnreadableError,
  RepairResultUnreadableError,
  workerLimit,
  type RepairStateEffects,
} from '../../../src/adapters/crq/repairStateSource.js';

const config = (text: string): JsonObject => parseJsonValue(text) as JsonObject;
const object = (text: string): JsonObject => parseJsonValue(text) as JsonObject;

let root: string;
let effects: RepairStateEffects;
let stamps: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crq-repair-state-'));
  stamps = ['2026-11-21T00:00:01Z', '2026-11-21T00:00:02Z'];
  effects = fileRepairStateEffects({ stateRoot: root, utc: () => stamps.shift() ?? 'EXHAUSTED' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const inbox = (name: string): string => join(root, 'repair', 'inbox', name);
const resultFile = (job: string): string => join(root, 'repair', job, 'result.json');

async function putResult(job: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(join(root, 'repair', job), { recursive: true });
  await writeFile(resultFile(job), bytes);
}

describe('workerLimit', () => {
  it('defaults to one and accepts exactly the integers 1..10', () => {
    expect(workerLimit(config('{"repair": {}}'))).toBe(1);
    for (const n of [1, 2, 10]) {
      expect(workerLimit(config(`{"repair": {"max_concurrent_items": ${n}}}`))).toBe(n);
    }
  });

  it.each(['0', '11', '-1', 'true', 'false', '2.0', '3.5', 'null', '"3"', '[]', '{}', '1e1'])(
    'refuses %s',
    (value) => {
      expect(() => workerLimit(config(`{"repair": {"max_concurrent_items": ${value}}}`))).toThrow(
        'repair.max_concurrent_items must be an integer from 1 to 10',
      );
    },
  );

  it('refuses an integer beyond the safe range rather than rounding it', () => {
    expect(() =>
      workerLimit(config('{"repair": {"max_concurrent_items": 100000000000000000001}}')),
    ).toThrow('from 1 to 10');
  });

  it.each(['{}', '{"repair": null}', '{"repair": []}', '[]', 'null'])(
    'raises for a config with no object repair section: %s',
    (text) => {
      expect(() => workerLimit(parseJsonValue(text))).toThrow(TypeError);
    },
  );
});

describe('inboxOrder / inboxItem', () => {
  const touch = async (name: string, seconds: number, body = '{}'): Promise<void> => {
    await mkdir(join(root, 'repair', 'inbox'), { recursive: true });
    await writeFile(inbox(name), body);
    await utimes(inbox(name), seconds, seconds);
  };

  it('is empty for an absent inbox', async () => {
    expect(await effects.inboxOrder()).toEqual([]);
  });

  it('sorts oldest file first, ties by name, and drops odd names and symlinks', async () => {
    await touch('crq-new.json', 3000);
    await touch('crq-b.json', 2000);
    await touch('crq-a.json', 2000);
    await touch('crq-old.json', 1000);
    await touch('crq-notes.txt', 500);
    await touch('other.json', 500);
    await touch('crq-bad name.json', 500);
    await touch('.json', 500);
    await mkdir(inbox('crq-dir.json'));
    await utimes(inbox('crq-dir.json'), 1500, 1500);
    await symlink(inbox('crq-old.json'), inbox('crq-link.json'));
    await symlink(join(root, 'does-not-exist'), inbox('crq-dangling.json'));
    expect(await effects.inboxOrder()).toEqual(['crq-old', 'crq-dir', 'crq-a', 'crq-b', 'crq-new']);
  });

  it('orders by sub-second mtime, which a whole-second compare would tie', async () => {
    // All four share second 2000; only the fractional part separates them, and
    // name order (a < b < c < d) is the reverse of mtime order.
    await touch('crq-a.json', 2000.75);
    await touch('crq-b.json', 2000.5);
    await touch('crq-c.json', 2000.25);
    await touch('crq-d.json', 2000.125);
    expect(await effects.inboxOrder()).toEqual(['crq-d', 'crq-c', 'crq-b', 'crq-a']);
  });

  it('breaks an exact mtime tie by name, after the sub-second compare', async () => {
    await touch('crq-z.json', 2000.5);
    await touch('crq-y.json', 2000.5);
    await touch('crq-x.json', 2000.75);
    expect(await effects.inboxOrder()).toEqual(['crq-y', 'crq-z', 'crq-x']);
  });

  it('reads the job item, and nothing for unreadable or non-object job files', async () => {
    await touch('crq-ok.json', 1, '{"job": "crq-ok", "item": "pr-7"}');
    await touch('crq-num.json', 1, '{"item": 7}');
    await touch('crq-noitem.json', 1, '{"job": "x"}');
    await touch('crq-list.json', 1, '[1]');
    await touch('crq-bad.json', 1, '{');
    expect(await effects.inboxItem('crq-ok')).toBe('pr-7');
    expect(await effects.inboxItem('crq-num')).toBeInstanceOf(JsonNumber);
    for (const job of ['crq-noitem', 'crq-list', 'crq-bad', 'crq-missing']) {
      expect(await effects.inboxItem(job)).toBeUndefined();
    }
    await expect(effects.inboxItem('../queue')).rejects.toThrow('invalid repair job id');
  });
});

describe('readQueue / readBacklog', () => {
  it('returns {items: []} for an absent queue', async () => {
    const queue = (await effects.readQueue()) as JsonObject;
    expect(queue.get('items')).toEqual([]);
  });

  it('reads like json.loads: duplicate keys keep the last value, ints stay ints', async () => {
    await writeFile(
      join(root, 'queue.json'),
      '{"items": [], "items": [{"id": 1}], "n": 10, "f": 1.0, "backfill_admissions": {}}',
    );
    const queue = (await effects.readQueue()) as JsonObject;
    expect((queue.get('items') as unknown[]).length).toBe(1);
    expect((queue.get('n') as JsonNumber).kind).toBe('int');
    expect((queue.get('f') as JsonNumber).kind).toBe('float');
    // No compaction refusal: the drain's read has none.
    expect(queue.has('backfill_admissions')).toBe(true);
  });

  it('accepts the non-finite constants json.loads accepts', async () => {
    await writeFile(join(root, 'queue.json'), '{"items": [], "x": [NaN, Infinity, -Infinity]}');
    const queue = (await effects.readQueue()) as JsonObject;
    expect((queue.get('x') as JsonNumber[]).map((n) => n.kind)).toEqual([
      'float',
      'float',
      'float',
    ]);
  });

  it('returns any JSON value as read; the caller decides what a non-object means', async () => {
    await writeFile(join(root, 'queue.json'), '[1]');
    expect(await effects.readQueue()).toEqual([expect.any(JsonNumber)]);
  });

  it.each([
    ['truncated JSON', '{"items": ['],
    ['empty file', ''],
    ['a BOM', '﻿{"items": []}'],
    ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
  ])('raises the typed unreadable error for %s', async (_label, body) => {
    await writeFile(join(root, 'queue.json'), body);
    await expect(effects.readQueue()).rejects.toBeInstanceOf(RepairQueueUnreadableError);
  });

  it('raises the typed unreadable error when queue.json is a directory', async () => {
    await mkdir(join(root, 'queue.json'));
    await expect(effects.readQueue()).rejects.toBeInstanceOf(RepairQueueUnreadableError);
  });

  it('bounds the surfaced reason to 300 characters', async () => {
    await writeFile(join(root, 'queue.json'), `{"k": ${'x'.repeat(2000)}}`);
    const error = await effects.readQueue().catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(RepairQueueUnreadableError);
    expect((error as Error).message.length).toBeLessThanOrEqual(300);
  });

  it('reads the backlog, and yields undefined for missing or unreadable files', async () => {
    expect(await effects.readBacklog()).toBeUndefined();
    await mkdir(join(root, 'repair'), { recursive: true });
    const path = join(root, 'repair', 'fix-pr-backlog.json');
    await writeFile(path, '{"at": "2026-11-21T00:00:00Z", "open": 3, "limit": 5}');
    const backlog = (await effects.readBacklog()) as JsonObject;
    expect((backlog.get('open') as JsonNumber).integer).toBe(3n);
    for (const bad of ['{', '', '﻿{}']) {
      await writeFile(path, bad);
      expect(await effects.readBacklog()).toBeUndefined();
    }
    await writeFile(path, new Uint8Array([0xc3, 0x28]));
    expect(await effects.readBacklog()).toBeUndefined();
    // A non-object parses; Python's caller then trips TypeError/KeyError and treats it as unknown.
    await writeFile(path, '[]');
    expect(await effects.readBacklog()).toEqual([]);
  });
});

describe('result matrix: pending / unreadableResult', () => {
  // [label, bytes, unreadable, pending]
  const terminal: Array<[string, string]> = [
    ['no retry_after key', '{"verdict": "FIXED"}'],
    ['retry_after null', '{"retry_after": null}'],
    ['retry_after empty string', '{"retry_after": ""}'],
    ['retry_after 0', '{"retry_after": 0}'],
    ['retry_after 0.0', '{"retry_after": 0.0}'],
    ['retry_after false', '{"retry_after": false}'],
    ['retry_after empty list', '{"retry_after": []}'],
    ['retry_after empty object', '{"retry_after": {}}'],
    ['empty object', '{}'],
  ];
  const deferred: Array<[string, string]> = [
    ['retry_after timestamp', '{"retry_after": "2026-11-21T00:00:00Z"}'],
    ['retry_after 1', '{"retry_after": 1}'],
    ['retry_after 0.5', '{"retry_after": 0.5}'],
    ['retry_after true', '{"retry_after": true}'],
    ['retry_after NaN', '{"retry_after": NaN}'],
    ['retry_after non-empty list', '{"retry_after": [0]}'],
    ['retry_after non-empty object', '{"retry_after": {"a": 0}}'],
    ['duplicate key, last wins', '{"retry_after": 0, "retry_after": "x"}'],
  ];
  const malformed: Array<[string, string | Uint8Array]> = [
    ['truncated JSON', '{"retry_after": '],
    ['empty file', ''],
    ['top-level list', '[]'],
    ['top-level null', 'null'],
    ['top-level string', '"x"'],
    ['top-level number', '3'],
    ['BOM', '﻿{}'],
    ['invalid UTF-8', new Uint8Array([0x7b, 0x80, 0x7d])],
    ['trailing garbage', '{} x'],
  ];

  it('treats a missing result as pending and not unreadable', async () => {
    expect(await effects.unreadableResult('crq-r-F1')).toBe(false);
    expect(await effects.pending('crq-r-F1')).toBe(true);
  });

  it.each(terminal)('terminal: %s', async (_label, body) => {
    await putResult('crq-r-F1', body);
    expect(await effects.unreadableResult('crq-r-F1')).toBe(false);
    expect(await effects.pending('crq-r-F1')).toBe(false);
  });

  it.each(deferred)('deferred: %s', async (_label, body) => {
    await putResult('crq-r-F1', body);
    expect(await effects.unreadableResult('crq-r-F1')).toBe(false);
    expect(await effects.pending('crq-r-F1')).toBe(true);
  });

  it.each(malformed)('malformed: %s is unreadable, and pending raises', async (_label, body) => {
    await putResult('crq-r-F1', body);
    expect(await effects.unreadableResult('crq-r-F1')).toBe(true);
    await expect(effects.pending('crq-r-F1')).rejects.toBeInstanceOf(RepairResultUnreadableError);
  });

  it('treats a result.json directory as unreadable (it exists but cannot be read)', async () => {
    await mkdir(resultFile('crq-r-F1'), { recursive: true });
    expect(await effects.unreadableResult('crq-r-F1')).toBe(true);
    await expect(effects.pending('crq-r-F1')).rejects.toBeInstanceOf(RepairResultUnreadableError);
  });

  it('treats a dangling result symlink as missing, as Path.exists() does', async () => {
    await mkdir(join(root, 'repair', 'crq-r-F1'), { recursive: true });
    await symlink(join(root, 'nowhere'), resultFile('crq-r-F1'));
    expect(await effects.unreadableResult('crq-r-F1')).toBe(false);
    expect(await effects.pending('crq-r-F1')).toBe(true);
  });

  it('follows a result symlink to its target', async () => {
    await putResult('crq-r-F2', '{"retry_after": "later"}');
    await mkdir(join(root, 'repair', 'crq-r-F1'), { recursive: true });
    await symlink(resultFile('crq-r-F2'), resultFile('crq-r-F1'));
    expect(await effects.pending('crq-r-F1')).toBe(true);
  });

  it('refuses a job id that is not one inbox job name, never touching a path', async () => {
    for (const bad of ['', '..', '../x', 'crq-a/b', 'not-crq', 'crq-a\n']) {
      await expect(effects.pending(bad)).rejects.toThrow('invalid repair job id');
      await expect(effects.unreadableResult(bad)).rejects.toThrow('invalid repair job id');
    }
  });
});

describe('Python integer digit limit (4300)', () => {
  const digits = (n: number, sign = ''): string => `${sign}${'1'.repeat(n)}`;

  it('accepts 4300 digits and refuses 4301, for either sign', async () => {
    await putResult('crq-r-F1', `{"retry_after": ${digits(4300)}}`);
    expect(await effects.unreadableResult('crq-r-F1')).toBe(false);
    expect(await effects.pending('crq-r-F1')).toBe(true);
    await putResult('crq-r-F1', `{"retry_after": ${digits(4300, '-')}}`);
    expect(await effects.unreadableResult('crq-r-F1')).toBe(false);
    for (const literal of [digits(4301), digits(4301, '-'), digits(5000)]) {
      await putResult('crq-r-F1', `{"retry_after": ${literal}}`);
      expect(await effects.unreadableResult('crq-r-F1')).toBe(true);
      await expect(effects.pending('crq-r-F1')).rejects.toBeInstanceOf(RepairResultUnreadableError);
    }
  });

  it('refuses an oversized integer even when a later duplicate key overwrites it', async () => {
    await putResult('crq-r-F1', `{"retry_after": ${digits(5000)}, "retry_after": 0}`);
    expect(await effects.unreadableResult('crq-r-F1')).toBe(true);
  });

  it('exempts floats, exponents and string contents, as CPython does', async () => {
    for (const literal of [`${digits(5000)}.5`, `${digits(5000)}e1`, `"${digits(5000)}"`]) {
      await putResult('crq-r-F1', `{"retry_after": ${literal}}`);
      expect(await effects.unreadableResult('crq-r-F1')).toBe(false);
    }
  });

  it('makes an oversized queue integer a typed unreadable error', async () => {
    await writeFile(join(root, 'queue.json'), `{"items": [{"n": ${digits(5000)}}]}`);
    await expect(effects.readQueue()).rejects.toBeInstanceOf(RepairQueueUnreadableError);
  });

  it('makes an oversized backlog or job integer unreadable', async () => {
    await mkdir(join(root, 'repair', 'inbox'), { recursive: true });
    await writeFile(join(root, 'repair', 'fix-pr-backlog.json'), `{"open": ${digits(5000)}}`);
    expect(await effects.readBacklog()).toBeUndefined();
    await writeFile(inbox('crq-big.json'), `{"item": ${digits(5000)}}`);
    expect(await effects.inboxItem('crq-big')).toBeUndefined();
  });
});

// EACCES: Python 3.14 Path.exists() is False on a stat failure, but open() on an
// existing unreadable file raises PermissionError (an OSError). Root bypasses mode bits.
describe.skipIf(process.getuid?.() === 0)('EACCES (mode-000 paths)', () => {
  it('treats an unreadable result.json as unreadable, and pending raises', async () => {
    await putResult('crq-r-F1', '{}');
    await chmod(resultFile('crq-r-F1'), 0o000);
    try {
      expect(await effects.unreadableResult('crq-r-F1')).toBe(true);
      await expect(effects.pending('crq-r-F1')).rejects.toBeInstanceOf(RepairResultUnreadableError);
    } finally {
      await chmod(resultFile('crq-r-F1'), 0o600);
    }
  });

  it('treats a result under an unsearchable job directory as missing (exists() is False)', async () => {
    await putResult('crq-r-F1', '{"retry_after": 0}');
    const dir = join(root, 'repair', 'crq-r-F1');
    await chmod(dir, 0o000);
    try {
      expect(await effects.unreadableResult('crq-r-F1')).toBe(false);
      expect(await effects.pending('crq-r-F1')).toBe(true);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('raises the typed error for an unreadable queue.json', async () => {
    await writeFile(join(root, 'queue.json'), '{"items": []}');
    await chmod(join(root, 'queue.json'), 0o000);
    try {
      await expect(effects.readQueue()).rejects.toBeInstanceOf(RepairQueueUnreadableError);
    } finally {
      await chmod(join(root, 'queue.json'), 0o600);
    }
  });

  it('yields undefined for an unreadable backlog or job file', async () => {
    await mkdir(join(root, 'repair', 'inbox'), { recursive: true });
    const backlog = join(root, 'repair', 'fix-pr-backlog.json');
    await writeFile(backlog, '{}');
    await writeFile(inbox('crq-job.json'), '{"item": "x"}');
    await chmod(backlog, 0o000);
    await chmod(inbox('crq-job.json'), 0o000);
    try {
      expect(await effects.readBacklog()).toBeUndefined();
      expect(await effects.inboxItem('crq-job')).toBeUndefined();
    } finally {
      await chmod(backlog, 0o600);
      await chmod(inbox('crq-job.json'), 0o600);
    }
  });

  it('treats an unlistable inbox as empty (glob swallows the scandir error)', async () => {
    await mkdir(join(root, 'repair', 'inbox'), { recursive: true });
    await writeFile(inbox('crq-a.json'), '{}');
    await chmod(join(root, 'repair', 'inbox'), 0o000);
    try {
      expect(await effects.inboxOrder()).toEqual([]);
    } finally {
      await chmod(join(root, 'repair', 'inbox'), 0o700);
    }
  });
});

describe('markStale', () => {
  const stale = (text: string): JsonObject => object(text);

  it('writes the exact bytes crq_repair.atomic writes for a STALE record', async () => {
    const job = stale(
      JSON.stringify({
        job: 'crq-run1-F1',
        item: 'pr-7',
        repair_base: 'a'.repeat(40),
        source_sha: 'b'.repeat(40),
        finding_sha256: 'c'.repeat(64),
        origin_job: null,
        finding: { severity: 'major' },
      }),
    );
    stamps = ['T0', 'T1'];
    await effects.markStale(job, 'superseded é \u{1F600} "q"');
    // Generated by `json.dumps(record, indent=2) + "\n"` under Python 3.15.
    expect(await readFile(resultFile('crq-run1-F1'), 'utf8')).toBe(
      [
        '{',
        '  "job": "crq-run1-F1",',
        '  "item": "pr-7",',
        `  "repair_base": "${'a'.repeat(40)}",`,
        `  "source_sha": "${'b'.repeat(40)}",`,
        `  "finding_sha256": "${'c'.repeat(64)}",`,
        '  "origin_job": null,',
        '  "verdict": "STALE",',
        '  "reason": "superseded \\u00e9 \\ud83d\\ude00 \\"q\\"",',
        '  "commits": [],',
        '  "attempts": [],',
        '  "judge": null,',
        '  "started_at": "T0",',
        '  "finished_at": "T1"',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('defaults absent fields to null and passes big ints and floats through losslessly', async () => {
    stamps = ['T0', 'T1'];
    await effects.markStale(
      stale(
        '{"job": "crq-backfill-k", "item": "backfill-finding-x", "repair_base": 12345678901234567890, "finding_sha256": 1.0}',
      ),
      'r',
    );
    expect(await readFile(resultFile('crq-backfill-k'), 'utf8')).toBe(
      [
        '{',
        '  "job": "crq-backfill-k",',
        '  "item": "backfill-finding-x",',
        '  "repair_base": 12345678901234567890,',
        '  "source_sha": null,',
        '  "finding_sha256": 1.0,',
        '  "origin_job": null,',
        '  "verdict": "STALE",',
        '  "reason": "r",',
        '  "commits": [],',
        '  "attempts": [],',
        '  "judge": null,',
        '  "started_at": "T0",',
        '  "finished_at": "T1"',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('writes a non-finite float field the way json.dump does', async () => {
    stamps = ['T0', 'T1'];
    const job = new JsonObject([
      ['job', 'crq-n-F1'],
      ['item', 'i'],
      ['repair_base', JsonNumber.float(Number.NaN)],
      ['source_sha', JsonNumber.float(-Infinity)],
    ]);
    await effects.markStale(job, 'r');
    const text = await readFile(resultFile('crq-n-F1'), 'utf8');
    expect(text).toContain('  "repair_base": NaN,\n  "source_sha": -Infinity,\n');
  });

  it('reads the clock once per stamp, started_at before finished_at', async () => {
    stamps = ['first', 'second', 'third'];
    await effects.markStale(stale('{"job": "crq-s-F1", "item": "i"}'), 'x');
    const written = object(await readFile(resultFile('crq-s-F1'), 'utf8'));
    expect(written.get('started_at')).toBe('first');
    expect(written.get('finished_at')).toBe('second');
    expect(stamps).toEqual(['third']);
  });

  it('creates the job directory, leaves only result.json, and writes it 0600', async () => {
    await effects.markStale(stale('{"job": "crq-s-F1", "item": "i"}'), 'x');
    expect(await readdir(join(root, 'repair', 'crq-s-F1'))).toEqual(['result.json']);
    expect((await stat(resultFile('crq-s-F1'))).mode & 0o777).toBe(0o600);
  });

  it('replaces an existing result and leaves it terminal for the next drain', async () => {
    await putResult('crq-s-F1', '{"retry_after": "later"}');
    expect(await effects.pending('crq-s-F1')).toBe(true);
    await effects.markStale(stale('{"job": "crq-s-F1", "item": "i"}'), 'superseded');
    expect(await effects.pending('crq-s-F1')).toBe(false);
    expect(await effects.unreadableResult('crq-s-F1')).toBe(false);
    expect(await readdir(join(root, 'repair', 'crq-s-F1'))).toEqual(['result.json']);
  });

  it('raises like job["job"] / job["item"] and writes nothing for an incomplete job', async () => {
    await expect(effects.markStale(stale('{"item": "i"}'), 'x')).rejects.toThrow(TypeError);
    await expect(effects.markStale(stale('{"job": "crq-s-F1"}'), 'x')).rejects.toThrow(TypeError);
    await expect(effects.markStale(stale('{"job": 7, "item": "i"}'), 'x')).rejects.toThrow(
      TypeError,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a job id that would escape the repair directory', async () => {
    await expect(
      effects.markStale(stale('{"job": "../../escape", "item": "i"}'), 'x'),
    ).rejects.toThrow('invalid repair job id');
    expect(await readdir(root)).toEqual([]);
  });
});
