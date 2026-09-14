// Session-store tests — PR 10 round-1 fix 2: torn-tail-then-append must not
// brick the session. load() tolerates a torn last line; appendMessage now
// recovers it (truncate to the last complete line) BEFORE appending, so the
// record stays the viable resume path. Evidence corruption (a corrupt line
// in the middle of a fully-written file) is NOT healed — it stays loud.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SessionStore } from '../../src/harness/session.js';

async function withScratch(body: (scratchDir: string) => Promise<void>): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'harness-session-'));
  try {
    await body(scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

describe('SessionStore torn-tail recovery (fix 2)', () => {
  test('torn tail + append + load: the session stays loadable with all complete messages', async () => {
    await withScratch(async (scratchDir) => {
      const store = new SessionStore(scratchDir);
      const record = await store.create(scratchDir);
      await store.appendMessage(record.sessionId, {
        role: 'user',
        content: 'before the crash',
        at: '2026-09-14T00:00:00.000Z',
      });
      // Simulate a crash mid-append: a partial JSON line without a newline.
      await appendFile(join(scratchDir, `${record.sessionId}.jsonl`), '{"type":"message","mess');
      // The pre-fix behavior would GLUE the next append onto that fragment
      // and turn it into a corrupt middle line, throwing on every load.
      await store.appendMessage(record.sessionId, {
        role: 'assistant',
        content: 'after recovery',
        at: '2026-09-14T00:00:01.000Z',
      });
      const loaded = await store.load(record.sessionId);
      expect(loaded).toBeDefined();
      expect(loaded?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(loaded?.messages[0]?.content).toBe('before the crash');
      expect(loaded?.messages[1]?.content).toBe('after recovery');
    });
  });

  test('a file with no complete line is a torn header — appending refuses (session never existed)', async () => {
    await withScratch(async (scratchDir) => {
      const store = new SessionStore(scratchDir);
      // A header line that never completed: create() crashed mid-write.
      await mkdir(scratchDir, { recursive: true });
      await appendFile(join(scratchDir, 'ses-torn.jsonl'), '{"type":"session","sess');
      await expect(
        store.appendMessage('ses-torn', { role: 'user', content: 'x', at: 'now' }),
      ).rejects.toThrow(/ses-torn/);
      // And it still loads as "no session" — the never-established path.
      await expect(store.load('ses-torn')).resolves.toBeUndefined();
    });
  });

  test('an empty session file is a never-established session — appending refuses instead of writing a headerless line', async () => {
    await withScratch(async (scratchDir) => {
      const store = new SessionStore(scratchDir);
      // create() crashed between open(O_CREAT) and the header write: an EMPTY
      // file. Pre-fix, appendMessage wrote a headerless message line into it
      // — every subsequent load threw 'message before header' (the brick).
      await mkdir(scratchDir, { recursive: true });
      await writeFile(join(scratchDir, 'ses-empty.jsonl'), '', 'utf8');
      await expect(
        store.appendMessage('ses-empty', { role: 'user', content: 'x', at: 'now' }),
      ).rejects.toThrow(/unknown sessionId 'ses-empty'/);
      // And it still loads as "no session" — the never-established path.
      await expect(store.load('ses-empty')).resolves.toBeUndefined();
    });
  });

    test('evidence corruption is not healed: a corrupt middle line still throws on load', async () => {
      await withScratch(async (scratchDir) => {
        const store = new SessionStore(scratchDir);
        const record = await store.create(scratchDir);
        await store.appendMessage(record.sessionId, {
          role: 'user',
          content: 'intact',
          at: '2026-09-14T00:00:00.000Z',
        });
        // A corrupt line that ENDS with a newline is a completed write; a
        // further complete append makes it a MIDDLE line — evidence
        // corruption, which recovery must NOT heal.
        await appendFile(
          join(scratchDir, `${record.sessionId}.jsonl`),
          '{"type":"message","message":{"role":"user"}}\n',
        );
        await store.appendMessage(record.sessionId, {
          role: 'assistant',
          content: 'after the corruption',
          at: '2026-09-14T00:00:01.000Z',
        });
        await expect(store.load(record.sessionId)).rejects.toThrow(/corrupt line/);
      });
    });
});
