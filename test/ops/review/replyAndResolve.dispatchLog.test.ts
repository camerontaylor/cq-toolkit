// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// subject files; this file carries the file-backed dispatch log behaviours.
import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDispatchLog } from '../../../src/adapters/store/dispatchLog.js';
import { replyAndResolve } from '../../../src/ops/review/replyAndResolve.js';
import type {
  DispatchRecord,
  ReplyAndResolveOpts,
  ReviewAction,
} from '../../../src/ops/review/replyAndResolve.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import { mkReply, NOW, REPO } from './replyAndResolve.helpers.js';

// ---------------------------------------------------------------------------
// fileDispatchLog — the file-backed DispatchLog
// ---------------------------------------------------------------------------

describe('fileDispatchLog', () => {
  test('a missing log file loads as an EMPTY log, and record creates the file and round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const log = fileDispatchLog(path);
      expect(await log.load()).toEqual([]);
      const first: DispatchRecord = {
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      const second: DispatchRecord = {
        actionId: 's1',
        kind: 'resolve_thread',
        resultRef: 'PRRT_1',
        at: NOW,
      };
      await log.record(first);
      await log.record(second);
      // One JSON record per line (JSON-lines-ish), newline-terminated.
      const text = await readFile(path, 'utf8');
      expect(text.split('\n')).toEqual([JSON.stringify(first), JSON.stringify(second), '']);
      // A FRESH log instance over the same path sees both records (the
      // cross-run memory).
      expect(await fileDispatchLog(path).load()).toEqual([first, second]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('MID-FILE corruption throws a CLEAR error — dispatching on an unreadable log would duplicate posts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      // A broken line with MORE records after it is not a truncated tail —
      // it is real corruption: load must refuse loudly.
      const first: DispatchRecord = {
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      const third: DispatchRecord = {
        actionId: 's1',
        kind: 'resolve_thread',
        resultRef: 'PRRT_1',
        at: NOW,
      };
      await writeFile(
        path,
        `${JSON.stringify(first)}\n{"actionId":"r2","kind":\n${JSON.stringify(third)}\n`,
        'utf8',
      );
      const log = fileDispatchLog(path);
      await expect(log.load()).rejects.toThrow(/corrupt.*line 2.*later lines follow/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a TRUNCATED FINAL line (a crash mid-append) is TOLERATED — prior records load, the record is retriable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const first: DispatchRecord = {
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      // The second line was cut off mid-write by a crash — no newline, no
      // closing brace.
      await writeFile(path, `${JSON.stringify(first)}\n{"actionId":"r2","kind`, 'utf8');
      const log = fileDispatchLog(path);
      // The intact prefix loads; the truncated tail is dropped, NOT thrown.
      // The r2 record never landed, so its action stays retriable.
      expect(await log.load()).toEqual([first]);
      expect(await fileDispatchLog(path).load()).toEqual([first]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('record() REPAIRS a partial tail before appending — the retry can never concatenate onto unterminated bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const first: DispatchRecord = {
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      const second: DispatchRecord = {
        actionId: 'r2',
        kind: 'issue_comment',
        resultRef: '8002',
        at: NOW + 1,
      };
      // The crash residue: a complete line followed by unterminated partial
      // bytes ("line1\npartialtail").
      await writeFile(path, `${JSON.stringify(first)}\n{"actionId":"r2","kind`, 'utf8');
      const log = fileDispatchLog(path);
      await log.record(second);
      // The partial tail was TRUNCATED before the append, so the new record
      // is whole and parseable — not concatenated into a dropped junk line.
      expect(await log.load()).toEqual([first, second]);
      const text = await readFile(path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.split('\n')).toEqual([JSON.stringify(first), JSON.stringify(second), '']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('record() PRESERVES a valid UNTERMINATED final record (crash after the closing brace, before the newline) — no repost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const first: DispatchRecord = {
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      const second: DispatchRecord = {
        actionId: 'r2',
        kind: 'issue_comment',
        resultRef: '8002',
        at: NOW + 1,
      };
      const third: DispatchRecord = {
        actionId: 's1',
        kind: 'resolve_thread',
        resultRef: 'PRRT_1',
        at: NOW + 2,
      };
      // The crash landed the SECOND record COMPLETE but without its newline:
      // it is valid JSON that load() already counts dispatched.
      await writeFile(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}`, 'utf8');
      expect(await fileDispatchLog(path).load()).toEqual([first, second]);
      await fileDispatchLog(path).record(third);
      // The landed record SURVIVED (only its '\n' boundary was added) —
      // truncating it would have discarded a real dispatch and reposted r2.
      expect(await fileDispatchLog(path).load()).toEqual([first, second, third]);
      const text = await readFile(path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.split('\n')).toEqual([
        JSON.stringify(first),
        JSON.stringify(second),
        JSON.stringify(third),
        '',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('record APPENDS one line: N interleaved load/record cycles always leave parseable content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const log = fileDispatchLog(path);
      // Interleave loads (including ones racing the record) with records;
      // after EVERY cycle the on-disk log must parse line-by-line — an
      // append can only ever add whole lines, and loads never rewrite.
      for (let cycle = 0; cycle < 20; cycle++) {
        await Promise.all([
          log.load(),
          log.record({
            actionId: `r${cycle}`,
            kind: 'issue_comment',
            resultRef: String(cycle),
            at: NOW + cycle,
          }),
          log.load(),
          log.load(),
        ]);
        const text = await readFile(path, 'utf8');
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue;
          expect((): unknown => JSON.parse(line)).not.toThrow();
        }
      }
      // Every record survived (appends never overwrite), and a FRESH log
      // instance sees the whole history.
      const history = await fileDispatchLog(path).load();
      expect(history).toHaveLength(20);
      expect(history.map((r) => r.actionId)).toEqual(
        Array.from({ length: 20 }, (_v, i) => `r${i}`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two CONCURRENT runs with the same action against a FILE log post exactly ONCE (cross-process dedupe)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const log = fileDispatchLog(path);
      let postCount = 0;
      const countingGh: GhFn = async (args) => {
        if (args.some((a) => a.includes('/pulls/'))) {
          postCount += 1;
          // A little latency so both runs genuinely overlap inside the
          // check-post-record window.
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { code: 0, stdout: JSON.stringify({ id: 8001 }), stderr: '' };
        }
        return { code: 0, stdout: JSON.stringify({ id: 8002 }), stderr: '' };
      };
      const actions: ReviewAction[] = [mkReply('r1', 1201)];
      const optsFor = (): ReplyAndResolveOpts => ({
        ...REPO,
        run: countingGh,
        push: null,
        dispatchLog: log,
        nowMs: NOW,
      });
      // Two jobs, same PR, same action: without the `<logPath>.lock`, both
      // would load an empty log, both see r1 unseen, and both POST.
      const [runA, runB] = await Promise.all([
        replyAndResolve(actions, optsFor()),
        replyAndResolve(actions, optsFor()),
      ]);
      // Exactly ONE user-visible POST across both runs.
      expect(postCount).toBe(1);
      // The runs CONVERGED: one posted, the other counted the skip.
      expect([runA, runB].filter((r) => r.posted.length > 0)).toHaveLength(1);
      expect([runA, runB].filter((r) => r.skippedAlreadyDispatched === 1)).toHaveLength(1);
      expect(runA.failed).toEqual([]);
      expect(runB.failed).toEqual([]);
      expect(await log.load()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
