// Session-store tests — PR 10 round-1 fix 2 + issue #18:
//   - torn-tail-then-append must not brick the session. load() tolerates a
//     torn last line; appendMessage now recovers it (truncate to the last
//     complete line) BEFORE appending, so the record stays the viable resume
//     path. Evidence corruption (a corrupt line in the middle of a
//     fully-written file) is NOT healed — it stays loud.
//   - issue #18's load-side check: only an UNTERMINATED last line is a torn
//     tail. A malformed line that was completely written (the file ends with
//     a newline) throws — that is evidence corruption, not a torn write.
//   - issue #18's append-side serialization: torn-tail recovery runs INSIDE
//     the write chain, so it can never interleave with an in-flight append.
//   - issue #18's privacy: the store dir is 0o700, the record file 0o600.
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionStore } from '../../src/harness/session.js';

// TRANSPARENT fs gate for the serialization test (below): when `gate` is
// null every call delegates untouched; when armed, calls on the gated
// session file are logged and the gate's marker line parks IN FLIGHT until
// released. vi.mock (not vi.spyOn) because the node builtin namespace is
// not redefinable.
const fsGate = vi.hoisted(() => ({
  state: null as null | {
    sessionFile: string;
    marker: string;
    events: string[];
    wait: Promise<void>;
    release: () => void;
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const passthroughAppend = (file: unknown, data: unknown, options?: unknown): Promise<void> =>
    actual.appendFile(
      file as Parameters<typeof actual.appendFile>[0],
      data as Parameters<typeof actual.appendFile>[1],
      options as Parameters<typeof actual.appendFile>[2],
    );
  return {
    ...actual,
    appendFile: (file: unknown, data: unknown, options?: unknown): Promise<void> => {
      const gate = fsGate.state;
      if (gate === null || file !== gate.sessionFile) return passthroughAppend(file, data, options);
      const text = typeof data === 'string' ? data : '';
      if (text.includes('"type":"session"')) return passthroughAppend(file, data, options); // the header
      if (text.includes(gate.marker)) {
        gate.events.push('append:A');
        return gate.wait.then(() => passthroughAppend(file, data, options)); // parked IN FLIGHT
      }
      gate.events.push('append:B');
      return passthroughAppend(file, data, options);
    },
    readFile: (file: unknown, options?: unknown): Promise<string> => {
      const gate = fsGate.state;
      if (gate === null || file !== gate.sessionFile) {
        return actual.readFile(
          file as Parameters<typeof actual.readFile>[0],
          options as Parameters<typeof actual.readFile>[1],
        ) as Promise<string>;
      }
      gate.events.push('read'); // a torn-tail recovery read on the session file
      return actual.readFile(
        file as Parameters<typeof actual.readFile>[0],
        options as Parameters<typeof actual.readFile>[1],
      ) as Promise<string>;
    },
  };
});

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

// ---------------------------------------------------------------------------
// Issue #18 — load-side torn-tail check: the file's LAST BYTE decides. A
// malformed line followed by a newline was COMPLETELY written: dropping it
// as a "torn tail" is evidence corruption and must throw.
// ---------------------------------------------------------------------------

describe('load-side torn-tail check (issue #18: a completed write is not a torn write)', () => {
  test('(a) malformed last line WITH the trailing newline → load THROWS', async () => {
    await withScratch(async (scratchDir) => {
      const store = new SessionStore(scratchDir);
      const record = await store.create(scratchDir);
      await appendFile(
        join(scratchDir, `${record.sessionId}.jsonl`),
        '{"type":"message","message":{"role":"user"}}\n', // complete write, invalid line
        'utf8',
      );
      await expect(store.load(record.sessionId)).rejects.toThrow(
        /completely written but is not a valid session line/,
      );
    });
  });

  test('(b) the same malformed line WITHOUT the trailing newline is a genuine torn tail — tolerated, dropped', async () => {
    await withScratch(async (scratchDir) => {
      const store = new SessionStore(scratchDir);
      const record = await store.create(scratchDir);
      await appendFile(
        join(scratchDir, `${record.sessionId}.jsonl`),
        '{"type":"message","message":{"role":"user"}}', // NO trailing newline — mid-write fragment
        'utf8',
      );
      const loaded = await store.load(record.sessionId);
      expect(loaded).toBeDefined();
      expect(loaded?.messages).toEqual([]); // the fragment is dropped; the header loads
    });
  });

  test('(c) a valid COMPLETE last line still loads', async () => {
    await withScratch(async (scratchDir) => {
      const store = new SessionStore(scratchDir);
      const record = await store.create(scratchDir);
      await store.appendMessage(record.sessionId, {
        role: 'user',
        content: 'complete line',
        at: '2026-09-14T00:00:00.000Z',
      });
      const loaded = await store.load(record.sessionId);
      expect(loaded?.messages.map((m) => m.content)).toEqual(['complete line']);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #18 — append-side serialization: recovery inside the write chain
// ---------------------------------------------------------------------------

describe('appendMessage recovery is serialized inside the write chain (issue #18)', () => {
  afterEach(() => {
    fsGate.state = null;
  });

  test('an in-flight append can never be interleaved by a second recovery: B reads only after A wrote', async () => {
    await withScratch(async (scratchDir) => {
      const store = new SessionStore(scratchDir);
      const record = await store.create(scratchDir);
      const sessionFile = join(scratchDir, `${record.sessionId}.jsonl`);
      const events: string[] = [];
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Arm the fs gate: A's line parks IN FLIGHT on the deferred until the
      // test releases it; every recovery read on the session file is logged.
      fsGate.state = { sessionFile, marker: 'in-flight line', events, wait, release };

      // A starts and parks mid-append; B is requested while A is in flight
      // (two stores on one dir is the driver pattern, but the serialization
      // property is per store CHAIN — this is its deterministic proof).
      const a = store.appendMessage(record.sessionId, {
        role: 'user',
        content: 'in-flight line',
        at: '2026-09-14T00:00:00.000Z',
      });
      const b = store.appendMessage(record.sessionId, {
        role: 'assistant',
        content: 'second line',
        at: '2026-09-14T00:00:01.000Z',
      });
      // Yield macrotask turns so a PRE-FIX B recovery (running outside the
      // chain) would land here, while A's append is still parked.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      release();
      await Promise.all([a, b]);
      // THE COMPLETED ORDER (review round 2 — the parked-phase assertion
      // was vacuous: with A parked the log held only ['read'], so
      // indexOf('append:A') === -1 passed against any shape). After
      // release, the serialized chain reads exactly:
      //   A's recovery read → A's append → B's recovery read → B's append,
      // whereas the PRE-FIX shape recorded B's recovery read while A was
      // still parked: ['read', 'read', 'append:A', 'append:B'] — this
      // assertion discriminates the two.
      expect(events).toEqual(['read', 'append:A', 'read', 'append:B']);
      expect(events.indexOf('append:A')).toBeLessThan(events.indexOf('append:B'));
      expect(events.lastIndexOf('read')).toBeGreaterThan(events.indexOf('append:A'));
      // Nothing was lost: both messages load.
      const loaded = await store.load(record.sessionId);
      expect(loaded?.messages.map((m) => m.content)).toEqual(['in-flight line', 'second line']);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #18 — privacy: session records are worker conversation evidence
// ---------------------------------------------------------------------------

describe('session file modes (issue #18: not world-readable)', () => {
  test('the store dir is created 0o700 and the record file 0o600 (mode at creation; umask still masks)', async () => {
    await withScratch(async (scratchDir) => {
      const sessionsDir = join(scratchDir, 'sessions'); // created BY the store's mkdir
      const store = new SessionStore(sessionsDir);
      const record = await store.create(scratchDir);
      const file = join(sessionsDir, `${record.sessionId}.jsonl`);
      expect((await stat(sessionsDir)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      // Further appends (file already exists — the creation mode stands).
      await store.appendMessage(record.sessionId, {
        role: 'user',
        content: 'x',
        at: '2026-09-14T00:00:00.000Z',
      });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    });
  });
});
