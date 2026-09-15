// Ledger lane C4 — registry-slice test evidence: the two entries
// (ledger.record, ledger.query) validate the full input and only it —
// strict unknown-key rejection, because a smuggled field would cross the
// plain-JSON boundary the input-driven store binding depends on — and
// their importers resolve end-to-end through the REAL pathLedgerStore (the
// one place real fs is allowed here, mirroring C1's subprocessRunCheck
// precedent): a record→query round trip over a mkdtemp root, cleaned up
// per test. The containment surface (root → strict descendant), the async
// retried lock, and the atomic publish are all exercised HERE.
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { registry } from '../../../src/ops/ledger/registry.js';
import { LedgerQueryInputSchema, LedgerRecordInputSchema } from '../../../src/ops/ledger/registry.js';
import { makeLedgerRecord } from '../../../src/ops/ledger/ledger.js';
import { parseLedger, serializeLedger } from '../../../src/ops/ledger/store.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';

let scratchDir = '';

afterEach(async () => {
  if (scratchDir !== '') {
    await rm(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
});

function entryNamed(name: string): OpRegistryEntry {
  const entry = registry.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`${name} missing from the ledger registry`);
  }
  return entry;
}

describe('ledger registry: the two C4 entries', () => {
  test('the registry names the lane ops', () => {
    expect(registry.map((entry) => entry.name)).toEqual(['ledger.record', 'ledger.query']);
  });
});

describe('LedgerRecordInputSchema / LedgerQueryInputSchema (full input, and only it)', () => {
  test('accepts the plain JSON a dispatcher sends (root + storePath, optional fields included)', () => {
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'ws/ledger.json', signature: 'sig-a' }).success,
    ).toBe(true);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'ws/ledger.json',
        signature: 'sig-a',
        component: 'c',
        note: 'n',
      }).success,
    ).toBe(true);
    expect(LedgerQueryInputSchema.safeParse({ root: 'ws', storePath: 'ws/ledger.json' }).success).toBe(true);
  });

  test('rejects smuggled unknown keys at every level (strict)', () => {
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: 's', memoize: true })
        .success,
    ).toBe(false);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        thresholds: { suppressAt: 1, escalateAt: 2, cache: true },
      }).success,
    ).toBe(false);
    expect(LedgerQueryInputSchema.safeParse({ root: 'ws', storePath: 'l.json', store: {} }).success).toBe(false);
  });

  test('rejects missing/empty root and storePath and out-of-bounds signatures', () => {
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 's' }).success).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ root: '', storePath: 'l.json', signature: 's' }).success).toBe(
      false,
    );
    expect(LedgerRecordInputSchema.safeParse({ root: 'ws', signature: 's' }).success).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: '', signature: 's' }).success).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: '' }).success).toBe(
      false,
    );
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: 's'.repeat(501) }).success,
    ).toBe(false);
    expect(LedgerQueryInputSchema.safeParse({}).success).toBe(false);
    expect(LedgerQueryInputSchema.safeParse({ storePath: 'l.json' }).success).toBe(false);
  });

  test('bounds component at 200 and note at 500 chars, mirroring the op-level validation', () => {
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: 's', component: 'c'.repeat(200) })
        .success,
    ).toBe(true);
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: 's', component: 'c'.repeat(201) })
        .success,
    ).toBe(false);
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: 's', note: 'n'.repeat(500) })
        .success,
    ).toBe(true);
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: 's', note: 'n'.repeat(501) })
        .success,
    ).toBe(false);
  });

  test('rejects an EMPTY component or note (an empty backfill would pin hollow metadata permanently)', () => {
    expect(LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: 's', component: '' }).success).toBe(
      false,
    );
    expect(LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: 's', note: '' }).success).toBe(
      false,
    );
  });
});

describe('the C4 importers resolve end-to-end (real pathLedgerStore over a mkdtemp root)', () => {
  test('ledger.record: record → suppress → escalate inside the root, including the mkdir -p parent', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    // A missing parent directory inside the root: the save must create it.
    const storePath = join(scratchDir, 'state', 'nested', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 2, escalated: false },
    });
    await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'needs-human',
      reason: 'error signature exceeded escalation threshold: sig-a (count 3 ≥ 3)',
    });
    // The committed bytes are the canonical format: parseable, sorted.
    expect(parseLedger(await readFile(storePath, 'utf8'))).toEqual({
      version: 1,
      entries: [{ signature: 'sig-a', count: 3 }],
    });
  });

  test('ledger.query: the importer-bound query reads the same file the record wrote', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    const query = await entryNamed('ledger.query').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-z' });
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    await expect(query({ root: scratchDir, storePath })).resolves.toEqual({
      status: 'ok',
      value: {
        entries: [
          { signature: 'sig-a', count: 2 },
          { signature: 'sig-z', count: 1 },
        ],
        knownNoise: ['sig-a'],
        needsHuman: [],
      },
    });
    // The persisted BYTES are canonical: byte-identical to their own
    // serialize∘parse fixpoint AND to the hand-built expected string.
    const content = await readFile(storePath, 'utf8');
    expect(content).toBe(serializeLedger(parseLedger(content)));
    expect(content).toBe(
      `{
  "version": 1,
  "entries": [
    {
      "signature": "sig-a",
      "count": 2
    },
    {
      "signature": "sig-z",
      "count": 1
    }
  ]
}
`,
    );
  });

  test('the store is input-driven: two paths inside one root keep independent counts', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const op = await entryNamed('ledger.record').importer();
    const firstPath = join(scratchDir, 'one.json');
    const secondPath = join(scratchDir, 'two.json');
    await op({ root: scratchDir, storePath: firstPath, signature: 'sig-a' });
    await op({ root: scratchDir, storePath: firstPath, signature: 'sig-a' });
    await expect(op({ root: scratchDir, storePath: secondPath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
  });

  test('a corrupt committed file is failed for record AND query (a LedgerFormatError from parseLedger, mapped by the ops)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-b' });
    const corrupted = (await readFile(storePath, 'utf8')).replace('"count": 1', '"count": 0');
    await writeFile(storePath, corrupted, 'utf8');
    const recorded = await record({ root: scratchDir, storePath, signature: 'sig-b' });
    expect(recorded.status).toBe('failed');
    if (recorded.status === 'failed') {
      expect(recorded.error).toContain('ledger: schema violation');
    }
    const query = await entryNamed('ledger.query').importer();
    const queried = await query({ root: scratchDir, storePath });
    expect(queried.status).toBe('failed');
    if (queried.status === 'failed') {
      expect(queried.error).toContain('ledger: schema violation');
    }
  });
});

describe('ledger.query is fs-READ-ONLY (the read-only pin)', () => {
  /** The full directory tree as sorted, typed entries — the byte-identity snapshot. */
  async function treeSnapshot(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .map(
        (entry) =>
          `${entry.parentPath}/${entry.name}:${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}`,
      )
      .sort();
  }

  test('queries over a real path create NOTHING: the directory tree is identical before and after', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-a' });

    const before = await treeSnapshot(scratchDir);
    expect(before).toContain(`${scratchDir}/ledger.json:f`); // the snapshot sees the real tree

    const query = await entryNamed('ledger.query').importer();
    await expect(query({ root: scratchDir, storePath })).resolves.toEqual({
      status: 'ok',
      value: {
        entries: [{ signature: 'sig-a', count: 1 }],
        knownNoise: [],
        needsHuman: [],
      },
    });
    // A query over a MISSING path (parent included) must not mkdir either —
    // including NESTED missing segments: clean absence under an in-root
    // ancestor stays the empty ledger (the contrast case for the
    // dangling-symlink queries, which must fault).
    await expect(query({ root: scratchDir, storePath: join(scratchDir, 'missing', 'ledger.json') })).resolves.toEqual(
      {
        status: 'ok',
        value: { entries: [], knownNoise: [], needsHuman: [] },
      },
    );
    await expect(
      query({ root: scratchDir, storePath: join(scratchDir, 'missing', 'deeper', 'ledger.json') }),
    ).resolves.toEqual({
      status: 'ok',
      value: { entries: [], knownNoise: [], needsHuman: [] },
    });

    // No files, dirs, or lock dirs appeared: the tree is byte-identical.
    expect(await treeSnapshot(scratchDir)).toEqual(before);
  });
});

describe('pathLedgerStore containment (the trust surface is checked at the seam)', () => {
  test('a storePath inside an existing root is accepted (the happy containment row)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const storePath = join(root, 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ root, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
  });

  test('a storePath outside the root (a sibling) is refused and nothing is written', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const storePath = join(scratchDir, 'outside.json'); // a sibling of the root
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve inside root');
    }
    // The refused target was never created.
    await expect(stat(storePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a storePath equal to the root is refused (strict descendant, never the root itself)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath: root, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve inside root');
    }
  });

  test('a nonexistent root refuses the store (root must resolve)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'missing');
    const storePath = join(root, 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('root does not resolve');
    }
    // Containment refuses BEFORE any mkdir: the root was never created.
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a root reached THROUGH a symlinked ancestor accepts contained targets (realpath normalizes, never refuses)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    // tmpdir-style layout: the root is itself a symlink to a real dir, the
    // way /var/... aliases /private/var/... on stock macOS.
    const realDir = join(scratchDir, 'real-ws');
    await mkdir(realDir);
    const root = join(scratchDir, 'link-to-ws');
    await symlink(realDir, root);
    const storePath = join(root, 'ledgers', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ root, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    // The ledger materialized under the root's REAL location, and a second
    // record through the symlinked root increments the SAME ledger.
    await expect(op({ root, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 2, escalated: false },
    });
    expect(parseLedger(await readFile(join(realDir, 'ledgers', 'ledger.json'), 'utf8')).entries).toEqual([
      { signature: 'sig-a', count: 2 },
    ]);
  });

  test('an intermediate symlink UNDER the root pointing outside is refused before any write (stage A: link exists at store creation)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'escape'));
    const storePath = join(root, 'escape', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve inside root');
    }
    // The escape was refused: nothing landed outside the root.
    await expect(stat(join(outside, 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an intermediate symlink planted AFTER store creation is refused by the stage-B re-verify (naming the escape)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const target = join(root, 'sub', 'ledger.json');
    // Stage A passes on the clean path; the escape appears before the save.
    const { pathLedgerStore } = await import('../../../src/ops/ledger/store.js');
    const store = pathLedgerStore(root, target);
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'sub'));
    const record = makeLedgerRecord(() => store);
    const result = await record({ root, storePath: target, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('strict descendant');
      expect(result.error).toContain('intermediate symlink');
    }
    // Nothing was written through the link.
    await expect(stat(join(outside, 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a DANGLING intermediate symlink fails the record without writing anywhere', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    await symlink(join(scratchDir, 'outside'), join(root, 'escape')); // target never exists
    const storePath = join(root, 'escape', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    await expect(stat(join(scratchDir, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a ledger FILE behind an escaping intermediate symlink is refused on read (the load-side twin)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'real.json'), '{\n  "version": 1,\n  "entries": []\n}\n', 'utf8');
    await symlink(join(outside, 'real.json'), join(root, 'ledger.json'));
    const query = await entryNamed('ledger.query').importer();
    const result = await query({ root, storePath: join(root, 'ledger.json') });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('strict descendant');
      expect(result.error).toContain('refusing to read');
    }
  });

  test('a query over a DANGLING intermediate symlink is a containment fault, never an ok empty view (PR #78 review: ENOENT ≠ missing file)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    // The escape target never exists, so realpath of the target ENOENTs —
    // the load must NOT read that as "missing in-root ledger" and hand
    // dispatch an empty (all-suppression-dropped) view.
    await symlink(join(scratchDir, 'outside'), join(root, 'escape'));
    const query = await entryNamed('ledger.query').importer();
    const result = await query({ root, storePath: join(root, 'escape', 'ledger.json') });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve');
    }
  });

  test('a direct-store load through an escaping symlink whose file is ABSENT through the link fails, never the empty ledger', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const target = join(root, 'sub', 'ledger.json');
    // Store created on the clean path (stage A passes on missing segments);
    // the escape is planted AFTER creation, pointing at an existing outside
    // dir where the ledger file itself does NOT exist — realpath of the
    // target ENOENTs through the escape, which must surface as a
    // containment fault, not an empty in-root ledger.
    const { pathLedgerStore } = await import('../../../src/ops/ledger/store.js');
    const store = pathLedgerStore(root, target);
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'sub'));
    expect(() => store.load()).toThrow(/does not resolve inside root.*refusing to read/s);
  });

  test('a query over a dangling symlink with FURTHER absent segments below it is a fault, never an ok empty view (nested ENOENT)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    // escape dangles AND another component is missing below it: the
    // immediate parent lstat-ENOENTs, so the one-level parent check would
    // read "absent parent ⇒ empty ledger" — the ancestor walk must instead
    // stop AT the dangling link and refuse (PR #93 review, Codex P2 +
    // CodeRabbit Major).
    await symlink(join(scratchDir, 'outside'), join(root, 'escape'));
    const query = await entryNamed('ledger.query').importer();
    const result = await query({ root, storePath: join(root, 'escape', 'missing', 'ledger.json') });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve');
    }
  });

  test('a direct-store load through an escaping symlink with FURTHER absent segments below it fails, never the empty ledger', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const target = join(root, 'escape', 'sub', 'ledger.json');
    const { pathLedgerStore } = await import('../../../src/ops/ledger/store.js');
    const store = pathLedgerStore(root, target);
    // The escape points at an EXISTING outside dir, but both 'sub' and the
    // ledger are absent THROUGH the link — the ancestor walk stops at the
    // link, resolves it outside the root, and refuses.
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'escape'));
    expect(() => store.load()).toThrow(/does not resolve inside root.*refusing to read/s);
  });
});

describe('pathLedgerStore.lock (contention contract: bounded backoff, live holders win, abandoned locks are recovered)', () => {
  test('8 parallel registry-bound records on one path ALL land (counts 1..8, none lost)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => op({ root: scratchDir, storePath, signature: 'sig-a' })),
    );
    // Every record observed its OWN increment: the counts 1..8 each appear
    // exactly once (ok values at 1–2, the escalation reason above that).
    const observed = results
      .map((result) =>
        result.status === 'ok'
          ? (result.value as { count: number }).count
          : result.status === 'needs-human'
            ? Number(/count (\d+)/.exec(result.reason)?.[1])
            : Number.NaN,
      )
      .sort((a, b) => a - b);
    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const query = await entryNamed('ledger.query').importer();
    await expect(query({ root: scratchDir, storePath })).resolves.toEqual({
      status: 'ok',
      value: {
        entries: [{ signature: 'sig-a', count: 8 }],
        knownNoise: ['sig-a'],
        needsHuman: ['sig-a'],
      },
    });
  }, 20_000);

  test('an ABANDONED lock is stolen once staleness passes (crash recovery), and the record lands', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    await mkdir(`${storePath}.lock`); // left by a crashed holder — never mtime-updated again
    // Backdate the abandoned lock dir's mtime past the 30s stale window —
    // the deterministic stand-in for waiting out the window in wall-clock
    // time. The one-call recovery guarantee for a JUST-crashed holder is
    // arithmetic instead: the acquire backoff (retries: 11, factor: 2,
    // minTimeout: 25 → cumulative ≈ 51s) outlives the 30s stale window,
    // and the sync critical section the window must cover is bounded well
    // under it (PR #78 review, Codex P2 — a 5s window could expire a lock
    // whose holder was merely blocked in sync fs work).
    const staleAgo = new Date(Date.now() - 35_000);
    await utimes(`${storePath}.lock`, staleAgo, staleAgo);
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    // The stale lock was consumed: only the ledger remains.
    expect(await readdir(scratchDir)).toEqual(['ledger.json']);
  }, 20_000);

  test('a LIVE held lock is waited out, never stolen from (the record lands only after the holder releases)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    // A genuinely live holder: proper-lockfile refreshes the lock's mtime
    // (update: 1000), so it never goes stale inside the record's 30s
    // window. The holder releases after 1.2s — well inside the record's
    // ≈51s cumulative backoff — so the record must WAIT for the release
    // and then proceed. Had it stolen the live lock instead, the external
    // release() below would reject (compromised lock) and fail the test.
    const { lock } = await import('proper-lockfile');
    const release = await lock(storePath, { realpath: false, update: 1000 });
    let releaseOutcome: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    const released = new Promise<void>((resolve) => {
      setTimeout(() => {
        void release().then(
          () => {
            releaseOutcome = 'fulfilled';
            resolve();
          },
          () => {
            releaseOutcome = 'rejected';
            resolve();
          },
        );
      }, 1_200);
    });
    try {
      const op = await entryNamed('ledger.record').importer();
      await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
        status: 'ok',
        value: { signature: 'sig-a', count: 1, escalated: false },
      });
    } finally {
      await released;
    }
    expect(releaseOutcome).toBe('fulfilled'); // clean external release: nothing was stolen
    expect(await readdir(scratchDir)).toEqual(['ledger.json']);
  }, 20_000);
});

describe('pathLedgerStore.save is an atomic publish (temp + rename, never a bare write)', () => {
  test('a successful save (create AND rewrite) leaves no leftover temp files', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    await record({ root: scratchDir, storePath, signature: 'sig-a' }); // a rewrite, not just a create
    expect(await readdir(scratchDir)).toEqual(['ledger.json']);
  });

  test('a pre-planted symlink at the ledger path is replaced, never followed', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    // The sentinel holds VALID ledger content so the record's read (which
    // legitimately follows the symlink, like any file read) reaches the
    // save — the load-bearing assertion is that the PUBLISH does not write
    // through the link: a bare writeFileSync would clobber the sentinel's
    // bytes; temp+rename leaves them exactly as written.
    const sentinelBytes = '{\n  "version": 1,\n  "entries": []\n}\n';
    const sentinelPath = join(scratchDir, 'sentinel.txt');
    await writeFile(sentinelPath, sentinelBytes, 'utf8');
    await symlink(sentinelPath, storePath);
    const record = await entryNamed('ledger.record').importer();
    await expect(record({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    // The sentinel the symlink pointed at is untouched…
    expect(await readFile(sentinelPath, 'utf8')).toBe(sentinelBytes);
    // …and the ledger path is now a REGULAR file holding the record.
    const stat = await lstat(storePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(parseLedger(await readFile(storePath, 'utf8')).entries).toEqual([
      { signature: 'sig-a', count: 1 },
    ]);
  });

  test('a NEW ledger is created 0600 and an update PRESERVES the ledger mode (the inode swap never widens permissions)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    // The first publish is a fresh create: restrictive by default — 0600,
    // not the 0666&umask (typically 0644) a bare writeFileSync temp gets.
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    // An operator tightens it further still (a group-readable 0640 proof:
    // any non-default mode works); the next record swaps the inode via
    // temp+rename and must carry the mode ACROSS the swap.
    await chmod(storePath, 0o640);
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    expect((await stat(storePath)).mode & 0o777).toBe(0o640);
    expect(parseLedger(await readFile(storePath, 'utf8')).entries).toEqual([
      { signature: 'sig-a', count: 2 },
    ]);
  });

  // Root bypasses directory permission bits, so the chmod-0000 precondition
  // cannot be produced under UID 0 — skip there (PR #95 review, Codex P2;
  // same posture as the EACCES test in test/cli/i1.test.ts).
  test.skipIf(process.getuid?.() === 0)(
    'an unreadable target metadata PROPAGATES from the mode probe — never a silent 0600 replacement (non-ENOENT lstat faults)',
    async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const root = join(scratchDir, 'ws');
    const stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
    const storePath = join(stateDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root, storePath, signature: 'sig-a' });
    await chmod(storePath, 0o640);
    const before = await readFile(storePath, 'utf8');
    // Deny search on the containing dir: lstat of the target now fails
    // EACCES. The publish must fail with THAT fault (the message names the
    // lstat), not swallow it and swap the 0640 ledger for a 0600
    // replacement (PR #93 review, CodeRabbit Minor).
    await chmod(stateDir, 0o000);
    const { pathLedgerStore } = await import('../../../src/ops/ledger/store.js');
    const store = pathLedgerStore(root, storePath);
    try {
      expect(() => store.save({ version: 1, entries: [{ signature: 'sig-b', count: 1 }] })).toThrow(/lstat/);
    } finally {
      await chmod(stateDir, 0o755);
    }
    // The refused publish changed nothing: same bytes, same mode.
    expect(await readFile(storePath, 'utf8')).toBe(before);
    expect((await stat(storePath)).mode & 0o777).toBe(0o640);
    });
});

