/**
 * Offline tests for the read-only triage row loader.
 *
 * Every test binds a temporary directory. Python 3.14 `Path.glob` /
 * `sorted` / `ledger.loads` behaviour was checked against the interpreter
 * when the module was written (see its header); the cases below pin that
 * behaviour and prove the loader never writes. No Git, forge, provider,
 * judge or transport participates.
 */
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  fileArtifactStore,
  fileFindingPublication,
} from '../../../src/adapters/crq/findingStore.js';
import {
  loadTriageDryRunInputs,
  loadTriageRows,
  TriageRowsRefusal,
} from '../../../src/adapters/crq/triageRows.js';
import { JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  ledgerCanonicalBytes,
  ledgerLoads,
} from '../../../src/policy/crq/ledger.js';
import { planTriageDryRun, type TriageRepo } from '../../../src/policy/crq/triagePlan.js';

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) {
    await chmod(path, 0o755).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'crq-triage-rows-'));
  temporary.push(path);
  return path;
}

/** A findings root whose `triage/` holds the named files. */
async function triageRoot(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await tempRoot();
  await mkdir(join(root, 'triage'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, 'triage', name), content);
  }
  return root;
}

function rowJson(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    review_id: 'r1',
    finding: { id, severity: 'minor', path: null, title: 'T', body: 'B' },
    target: 'a'.repeat(40),
    previous_event_id: null,
    status: 'untriaged',
    ...extra,
  });
}

async function ids(root: string): Promise<string[]> {
  const rows = await loadTriageRows(root);
  return rows.map((row) => ((row.get('finding') as JsonObject).get('id') as string) ?? '');
}

/** The names and sizes of every entry below `root`, to prove nothing changes. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await stat(path).catch(() => null);
      out.push(`${path}:${info === null ? 'dangling' : `${info.size}:${info.mtimeMs}`}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return out.sort();
}

describe('loadTriageRows: Python glob and sort', () => {
  test('an absent triage directory is zero rows, not an error', async () => {
    expect(await loadTriageRows(await tempRoot())).toEqual([]);
  });

  test('a triage path that is not a directory is zero rows (scandir OSError swallowed)', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'triage'), 'not a directory');
    expect(await loadTriageRows(root)).toEqual([]);
  });

  test('rows come in file-name order, and only *.json entries are read', async () => {
    const root = await triageRoot({
      'b.json': rowJson('b'),
      'a.json': rowJson('a'),
      'c.json.tmp': 'not json at all',
      'notes.txt': 'ignored',
      'c.json': rowJson('c'),
    });
    expect(await ids(root)).toEqual(['a', 'b', 'c']);
  });

  test('order is by code point, uppercase before lowercase and digits first', async () => {
    const root = await triageRoot({
      'b.json': rowJson('b'),
      'B.json': rowJson('B'),
      '1.json': rowJson('1'),
      'a-1.json': rowJson('a-1'),
      'a.json': rowJson('a'),
    });
    // '-' (0x2d) sorts before '.' (0x2e): a-1.json before a.json.
    expect(await ids(root)).toEqual(['1', 'B', 'a-1', 'a', 'b']);
  });

  test('an astral name sorts after a high BMP name (code points, not UTF-16 units)', async () => {
    const root = await triageRoot({
      'x\u{1d49c}.json': rowJson('astral'),
      'x\u{ff5e}.json': rowJson('bmp'),
      'x\u{e000}.json': rowJson('private'),
    });
    // UTF-16 code-unit order would put the astral name first (0xD835 < 0xE000).
    expect(await ids(root)).toEqual(['private', 'bmp', 'astral']);
  });

  test('a hidden ".json" file and a bare ".json" name are yielded, as pathlib does', async () => {
    const root = await triageRoot({
      '.json': rowJson('bare'),
      '.hidden.json': rowJson('hidden'),
      'a.json': rowJson('a'),
    });
    // '.hidden.json' < '.json' ('h' < 'j'), and both precede 'a.json' ('.' < 'a').
    expect(await ids(root)).toEqual(['hidden', 'bare', 'a']);
  });

  test('an undecodable file name is a lone surrogate, sorted before U+E000, BOM kept', async () => {
    const root = await triageRoot({});
    const dir = join(root, 'triage');
    const names = [
      Buffer.from('z.json'),
      Buffer.from([0x7a, 0xff, ...Buffer.from('.json')]), // 'z\udcff.json'
      Buffer.from([0xee, 0x80, 0x80, ...Buffer.from('.json')]), // U+E000
      Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('a.json')]), // U+FEFF + 'a'
      Buffer.from([0xf0, 0x9f, 0x98, 0x80, ...Buffer.from('.json')]), // U+1F600
    ];
    const labels = ['z', 'z-ff', 'e000', 'feff-a', 'astral'];
    for (const [index, name] of names.entries()) {
      await writeFile(
        Buffer.concat([Buffer.from(`${dir}/`), name]),
        rowJson(labels[index] as string),
      );
    }
    // Python 3.14 sorted(glob), checked with ascii(): z, z-ff (lone U+DCFF), U+E000, U+FEFF+a, U+1F600.
    expect(await ids(root)).toEqual(['z', 'z-ff', 'e000', 'feff-a', 'astral']);
  });
});

describe('loadTriageRows: refusal semantics', () => {
  test('a directory named *.json is yielded by glob and read_bytes raises', async () => {
    const root = await triageRoot({ 'a.json': rowJson('a') });
    await mkdir(join(root, 'triage', 'd.json'));
    await expect(loadTriageRows(root)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  test('a dangling symlink named *.json is yielded and read raises ENOENT', async () => {
    const root = await triageRoot({ 'a.json': rowJson('a') });
    await symlink('nowhere', join(root, 'triage', 'dangling.json'));
    await expect(loadTriageRows(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an unreadable row aborts the whole load', async (context) => {
    const root = await triageRoot({ 'a.json': rowJson('a'), 'b.json': rowJson('b') });
    await chmod(join(root, 'triage', 'b.json'), 0o000);
    if ((await readFileProbe(join(root, 'triage', 'b.json'))) === 'readable') context.skip();
    await expect(loadTriageRows(root)).rejects.toMatchObject({ code: 'EACCES' });
  });

  test('a malformed row aborts with the ledger decode error, not a partial list', async () => {
    const root = await triageRoot({ 'a.json': rowJson('a'), 'b.json': '{"finding": ' });
    await expect(loadTriageRows(root)).rejects.toBeInstanceOf(LedgerJsonDecodeError);
  });

  test('a duplicate key, a float or NaN is a ledger integrity refusal', async () => {
    for (const text of [
      '{"status": "a", "status": "b"}',
      '{"n": 1.5}',
      '{"n": NaN}',
      '{"n": Infinity}',
    ]) {
      const root = await triageRoot({ 'a.json': text });
      await expect(loadTriageRows(root)).rejects.toBeInstanceOf(LedgerIntegrityError);
    }
  });

  test('a non-object row is refused even when it is valid JSON', async () => {
    for (const text of ['[]', '"row"', '7', 'null', 'true']) {
      const root = await triageRoot({ 'a.json': rowJson('a'), 'b.json': text });
      await expect(loadTriageRows(root)).rejects.toBeInstanceOf(TriageRowsRefusal);
    }
  });

  test('invalid UTF-8 content is refused, never replaced', async () => {
    const root = await triageRoot({ 'a.json': new Uint8Array([0x7b, 0xff, 0x7d]) });
    await expect(loadTriageRows(root)).rejects.toThrow();
  });

  test('the loader writes nothing: the tree is byte- and mtime-identical afterwards', async () => {
    const root = await triageRoot({ 'a.json': rowJson('a'), 'b.json': rowJson('b') });
    const before = await snapshot(root);
    await loadTriageRows(root);
    await loadTriageRows(join(root, 'absent'));
    expect(await snapshot(root)).toEqual(before);
    expect(await readdir(root)).toEqual(['triage']);
  });
});

async function readFileProbe(path: string): Promise<'readable' | 'denied'> {
  try {
    readFileSync(path);
    return 'readable';
  } catch {
    return 'denied';
  }
}

describe('loadTriageDryRunInputs: rows then retained reviews', () => {
  async function stateRoot(): Promise<{
    findingsRoot: string;
    publication: ReturnType<typeof fileFindingPublication>;
    pending: string;
  }> {
    const root = await tempRoot();
    const findingsRoot = join(root, 'backfill', 'findings');
    const publicationRoot = join(root, 'backfill', 'publication');
    await mkdir(join(findingsRoot, 'triage'), { recursive: true });
    await mkdir(join(publicationRoot, 'pending'), { recursive: true });
    const publication = fileFindingPublication({
      root: publicationRoot,
      artifacts: fileArtifactStore(join(root, 'durable')),
    });
    return { findingsRoot, publication, pending: join(publicationRoot, 'pending') };
  }

  const NO_GIT: TriageRepo = {
    beginInvocation: () => undefined,
    commitDate: () => {
      throw new Error('a retained date makes Git unnecessary');
    },
    entryPaths: () => new Set(),
    lineage: () => null,
    provenDeleted: () => false,
    deletingCommit: () => '',
  };

  test('the loaded inputs drive the planner end to end, offline', async () => {
    const { findingsRoot, publication, pending } = await stateRoot();
    await writeFile(join(findingsRoot, 'triage', 'p1.json'), rowJson('p1'));
    await writeFile(join(findingsRoot, 'triage', 'p2.json'), rowJson('p2', { status: 'fixed' }));
    await writeFile(
      join(pending, 'r1.json'),
      JSON.stringify({
        event_type: 'review',
        id: 'r1',
        occurred_at: '2026-01-01T00:00:00Z',
        payload: {},
      }),
    );

    const inputs = await loadTriageDryRunInputs({ findingsRoot, publication });
    expect(inputs.rows).toHaveLength(2);
    expect(inputs.reviews).toHaveLength(1);

    const result = planTriageDryRun({
      ...inputs,
      tip: 'b'.repeat(40),
      clock: () => 0,
      repo: NO_GIT,
      prepareContext: () => ({ kind: 'ready' }),
    });
    // p1 has no repository path (mechanical needs-human); p2 is settled.
    expect(result.report.total).toBe(2);
    expect(result.report.outcomes).toEqual([
      { findingId: 'p1', action: 'needs-human', reason: 'finding has no repository path' },
    ]);
    expect(result.report.dryRun).toBe(true);
  });

  test('a triage refusal wins and the retained reviews are never read', async () => {
    const { findingsRoot, pending } = await stateRoot();
    await writeFile(join(findingsRoot, 'triage', 'bad.json'), '[1]');
    let retainedCalls = 0;
    await expect(
      loadTriageDryRunInputs({
        findingsRoot,
        publication: {
          retained: async (): Promise<JsonValue[]> => {
            retainedCalls += 1;
            return [];
          },
        },
      }),
    ).rejects.toBeInstanceOf(TriageRowsRefusal);
    expect(retainedCalls).toBe(0);
    expect(pending).toContain('pending');
  });

  test('a damaged retained review aborts the load after the rows were read', async () => {
    const { findingsRoot, publication, pending } = await stateRoot();
    await writeFile(join(findingsRoot, 'triage', 'a.json'), rowJson('a'));
    await writeFile(join(pending, 'x.json'), '{"id": ');
    await expect(loadTriageDryRunInputs({ findingsRoot, publication })).rejects.toBeInstanceOf(
      LedgerJsonDecodeError,
    );
  });
});

describe('loadTriageRows: Python oracle rows', () => {
  interface Case {
    input: { rows: { file: string; row: unknown }[] };
    ts_refuses: boolean;
    raises?: string;
  }
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../apps/crq-python/fixtures/crq-triage-plan/cases.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: Case[] };

  test('every oracle inbox loads to the same canonical rows the planner test injects', async () => {
    let compared = 0;
    for (const vector of fixture.cases) {
      const rows = vector.input.rows;
      if (
        rows.some(
          (entry) =>
            typeof entry.row !== 'object' || entry.row === null || Array.isArray(entry.row),
        )
      ) {
        continue;
      }
      const files: Record<string, string> = {};
      for (const entry of rows) files[entry.file] = JSON.stringify(entry.row);
      const root = await triageRoot(files);
      let loaded: readonly JsonObject[];
      try {
        loaded = await loadTriageRows(root);
      } catch (error) {
        // Floats or NaN in a deliberately damaged oracle row: Python's
        // `ledger.loads` refuses the same input.
        expect(error).toBeInstanceOf(LedgerIntegrityError);
        continue;
      }
      const expected = rows.map((entry) =>
        Buffer.from(ledgerCanonicalBytes(ledgerLoads(JSON.stringify(entry.row)))).toString('utf8'),
      );
      const actual = loaded.map((row) => Buffer.from(ledgerCanonicalBytes(row)).toString('utf8'));
      expect([...actual].sort()).toEqual([...expected].sort());
      compared += 1;
    }
    expect(compared).toBeGreaterThan(60);
  });
});
