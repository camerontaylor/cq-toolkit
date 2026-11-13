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
        version: 1,
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      const second: DispatchRecord = {
        version: 1,
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

  test('version rule: an absent version is legacy v1, accepted; writers always write version 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      // Exactly the pre-version line shape.
      const legacy = { actionId: 'r-legacy', kind: 'review_reply', resultRef: '8000', at: NOW };
      await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');
      const log = fileDispatchLog(path);
      // Legacy lines read as v1; the normalisation is in memory, the bytes are untouched.
      expect(await log.load()).toEqual([{ version: 1, ...legacy }]);
      const fresh: DispatchRecord = {
        version: 1,
        actionId: 'r-new',
        kind: 'issue_comment',
        resultRef: '8001',
        at: NOW + 1,
      };
      await log.record(fresh);
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
      expect(JSON.parse(lines[0]!)).toEqual(legacy);
      expect(JSON.parse(lines[1]!)).toEqual(fresh);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('version rule: an unsupported version is refused fail-closed, in the tail and mid-file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const v2 = { version: 2, actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW };
      // TERMINATED final line: parses, so it is not a truncated tail.
      await writeFile(path, `${JSON.stringify(v2)}\n`, 'utf8');
      await expect(fileDispatchLog(path).load()).rejects.toThrow(/unsupported record version 2/);
      // UNTERMINATED final line: still parses, so still refused (never dropped as junk).
      await writeFile(path, JSON.stringify(v2), 'utf8');
      await expect(fileDispatchLog(path).load()).rejects.toThrow(/unsupported record version 2/);
      // record() refuses to widen the log past a wrong-version tail.
      await expect(
        fileDispatchLog(path).record({
          version: 1,
          actionId: 'r2',
          kind: 'issue_comment',
          resultRef: '8002',
          at: NOW,
        }),
      ).rejects.toThrow(/unsupported record version 2/);
      // A MID-FILE unsupported version is loud too.
      await writeFile(path, `${JSON.stringify(v2)}\n${JSON.stringify(v2)}\n`, 'utf8');
      await expect(fileDispatchLog(path).load()).rejects.toThrow(
        /line 1.*unsupported record version/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('version rule: record() refuses to write any version but 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const log = fileDispatchLog(path);
      await expect(
        log.record({
          version: 2,
          actionId: 'r1',
          kind: 'review_reply',
          resultRef: '8001',
          at: NOW,
        } as unknown as DispatchRecord),
      ).rejects.toThrow(/this writer writes 1 only/);
      // Nothing landed.
      expect(await log.load()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a line with actionId renamed to id throws naming the line (issue #1199 acceptance)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      // Exactly the pre-version line shape but with the dedupe key renamed:
      // well-formed JSON, so it is not a truncated tail — it is a refusal.
      const renamed = { id: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW };
      await writeFile(path, `${JSON.stringify(renamed)}\n`, 'utf8');
      await expect(fileDispatchLog(path).load()).rejects.toThrow(
        /line 1.*malformed record.*actionId/,
      );
      // record() applies the same rule before appending: the writer cannot
      // poison its own log with a renamed key.
      await expect(
        fileDispatchLog(path).record({
          version: 1,
          id: 'r2',
          kind: 'issue_comment',
          resultRef: '8002',
          at: NOW,
        } as unknown as DispatchRecord),
      ).rejects.toThrow(/refusing to record a malformed dispatch record.*actionId/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('malformed record shapes throw fail-closed, naming the line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      // Each case is a line load() must refuse: the version gate already
      // passed (absent or 1), but a REQUIRED field is missing or mistyped.
      // A missing dedupe key would silently re-dispatch (a repost), so the
      // line throws exactly like a corrupt mid-file line does.
      const cases: Array<{ name: string; line: unknown; matches: RegExp }> = [
        {
          name: 'missing actionId',
          line: { kind: 'review_reply', resultRef: '8001', at: NOW },
          matches: /malformed record.*actionId/,
        },
        {
          name: 'legacy line missing actionId (no version excuses no shape)',
          line: { kind: 'review_reply', resultRef: '8001', at: NOW },
          matches: /malformed record.*actionId/,
        },
        {
          name: 'empty actionId',
          line: { version: 1, actionId: '', kind: 'review_reply', resultRef: '8001', at: NOW },
          matches: /malformed record.*actionId/,
        },
        {
          name: 'non-string actionId',
          line: { version: 1, actionId: 7, kind: 'review_reply', resultRef: '8001', at: NOW },
          matches: /malformed record.*actionId/,
        },
        {
          name: 'unknown kind',
          line: { version: 1, actionId: 'r1', kind: 'review_comment', resultRef: '8001', at: NOW },
          matches: /malformed record.*kind/,
        },
        {
          name: 'missing kind',
          line: { version: 1, actionId: 'r1', resultRef: '8001', at: NOW },
          matches: /malformed record.*kind/,
        },
        {
          name: 'non-string resultRef',
          line: { version: 1, actionId: 'r1', kind: 'review_reply', resultRef: 8001, at: NOW },
          matches: /malformed record.*resultRef/,
        },
        {
          name: 'non-numeric at',
          line: { version: 1, actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: 'now' },
          matches: /malformed record.*\bat\b/,
        },
        {
          name: 'missing at',
          line: { version: 1, actionId: 'r1', kind: 'review_reply', resultRef: '8001' },
          matches: /malformed record.*\bat\b/,
        },
        {
          name: 'stray record of another shape',
          line: { action: 'review', version: 1 },
          matches: /malformed record.*actionId/,
        },
      ];
      for (const { name, line, matches } of cases) {
        await writeFile(path, `${JSON.stringify(line)}\n`, 'utf8');
        await expect(fileDispatchLog(path).load(), name).rejects.toThrow(matches);
      }
      // Non-object lines are refused too: none can ever be a record.
      for (const [name, raw] of [
        ['array line', '[1,2]'],
        ['string line', '"r1"'],
        ['number line', '7'],
        ['null line', 'null'],
      ] as const) {
        await writeFile(path, `${raw}\n`, 'utf8');
        await expect(fileDispatchLog(path).load(), name).rejects.toThrow(/not a record object/);
      }
      // MID-FILE: a valid record followed by a malformed line names line 2.
      const first: DispatchRecord = {
        version: 1,
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      await writeFile(
        path,
        `${JSON.stringify(first)}\n${JSON.stringify({ version: 1, kind: 'review_reply', resultRef: '8002', at: NOW })}\n`,
        'utf8',
      );
      await expect(fileDispatchLog(path).load()).rejects.toThrow(
        /line 2.*malformed record.*actionId/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a v1 line with extra keys still loads (forward compat is the version field, not key strictness)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const withExtra = {
        version: 1,
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
        note: 'a future writer key',
      };
      await writeFile(path, `${JSON.stringify(withExtra)}\n`, 'utf8');
      expect(await fileDispatchLog(path).load()).toEqual([withExtra]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('record() refuses a malformed entry without appending (the writer never self-poisons the log)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const log = fileDispatchLog(path);
      await expect(
        log.record({
          version: 1,
          actionId: 'r1',
          kind: 'review_reply',
          resultRef: '8001',
          at: 'now',
        } as unknown as DispatchRecord),
      ).rejects.toThrow(/refusing to record a malformed dispatch record.*\bat\b/);
      // Nothing landed: a later load sees an empty log, not a poisoned one.
      expect(await log.load()).toEqual([]);
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
        version: 1,
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      const third: DispatchRecord = {
        version: 1,
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
        version: 1,
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
        version: 1,
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      const second: DispatchRecord = {
        version: 1,
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
        version: 1,
        actionId: 'r1',
        kind: 'review_reply',
        resultRef: '8001',
        at: NOW,
      };
      const second: DispatchRecord = {
        version: 1,
        actionId: 'r2',
        kind: 'issue_comment',
        resultRef: '8002',
        at: NOW + 1,
      };
      const third: DispatchRecord = {
        version: 1,
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
            version: 1,
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
