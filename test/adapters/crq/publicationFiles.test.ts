// Differential run: the same isolated state tree through Python's real
// `crq_repair.atomic` and `write_text`/`read_text` one-liners of
// `repair_tick.publish`/`finalize_publication` (the oracle,
// test/helpers/publicationFilesOracle.py) and the TS publication file effects.
// Returned values, written bytes, file modes and leftover temp files must be
// equal, and a Python exception must coincide with a TS throw. Tmp state only: no
// network, git, forge, provider, queue or service state.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  filePublicationEffects,
  type PublicationFileEffects,
} from '../../../src/adapters/crq/publicationFiles.js';
import {
  parseJsonValue,
  pythonNonFinite,
  toPlainJsonRetainingNumbers,
} from '../../../src/policy/crq/jsonValue.js';
import { atomicJsonText } from '../../../src/policy/crq/pythonJson.js';
import { isPyError } from '../../../src/queue-runner/pyErrors.js';
import {
  publishRepair,
  type PublicationPublishEffects,
} from '../../../src/queue-runner/publicationPublish.js';
import type { PublicationFinalizeEffects } from '../../../src/queue-runner/publicationFinalize.js';

const ORACLE = new URL('../../helpers/publicationFilesOracle.py', import.meta.url).pathname;
const APPS = new URL('../../../apps/crq-python', import.meta.url).pathname;

type FileSpec = string | { hex: string } | { dir: true };
interface Case {
  name: string;
  op: 'read_journal' | 'write_journal' | 'write_patch' | 'write_fix_pr' | 'save_queue';
  files?: Record<string, FileSpec>;
  modes?: Record<string, number>;
  job?: string;
  /** JSON text of the value to write; kept as text so int/float survive. */
  value?: string;
  text?: string;
}
interface Outcome {
  ok?: unknown;
  error?: string;
  files: Record<string, [string, number]>;
}

const JOB = 'crq-job';
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function layOut(state: string, item: Case): Promise<void> {
  for (const [rel, spec] of Object.entries(item.files ?? {})) {
    const path = join(state, rel);
    if (typeof spec === 'object' && 'dir' in spec) {
      await mkdir(path, { recursive: true });
      continue;
    }
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, typeof spec === 'string' ? spec : Buffer.from(spec.hex, 'hex'));
  }
  for (const [rel, mode] of Object.entries(item.modes ?? {})) await chmod(join(state, rel), mode);
}

async function snapshot(state: string, dir = state): Promise<Outcome['files']> {
  const out: Outcome['files'] = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(state, path));
    else if (entry.isFile()) {
      out[path.slice(state.length + 1)] = [
        await readFile(path).then(
          (bytes) => bytes.toString('latin1'),
          () => '<unreadable>',
        ),
        (await stat(path)).mode & 0o777,
      ];
    }
  }
  return out;
}

async function runTs(item: Case): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), 'crq-publication-files-'));
  cleanups.push(root);
  const state = join(root, 'state');
  await mkdir(state);
  await layOut(state, item);
  const effects = filePublicationEffects({ stateRoot: state });
  const job = item.job ?? JOB;
  const value = (): Record<string, unknown> =>
    toPlainJsonRetainingNumbers(
      parseJsonValue(item.value ?? 'null', { parseConstant: pythonNonFinite }),
    ) as Record<string, unknown>;
  try {
    let ok: unknown = null;
    if (item.op === 'read_journal') {
      const read = await effects.readJournal(job);
      ok = read === null ? null : atomicJsonText(read).slice(0, -1);
    } else if (item.op === 'write_journal') await effects.writeJournal(job, value());
    else if (item.op === 'write_patch') await effects.writePatch(job, item.text ?? '');
    else if (item.op === 'write_fix_pr') await effects.writeFixPrBody(job, item.text ?? '');
    else await effects.saveQueue(value());
    return { ok, files: await snapshot(state) };
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'unknown', files: await snapshot(state) };
  }
}

function runOracle(cases: Case[]): Outcome[] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '' },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

/** Run every case through both implementations and require agreement. */
async function expectParity(cases: Case[]): Promise<Outcome[]> {
  const oracle = runOracle(cases);
  for (const [index, item] of cases.entries()) {
    const python = oracle[index] as Outcome;
    const ts = await runTs(item);
    if (python.error !== undefined) {
      expect(ts.error, `${item.name}: Python raised ${python.error}`).toBeDefined();
      expect(ts.files, `${item.name}: files after the failure`).toEqual(python.files);
    } else {
      expect(ts, item.name).toEqual(python);
    }
  }
  return oracle;
}

const journalPath = `repair/${JOB}/publication.json`;
const patchPath = `repair/${JOB}/publication.patch`;
const bodyPath = `repair/${JOB}/fix-pr.md`;
const journal = (files: Record<string, FileSpec>): Pick<Case, 'files'> => ({ files });
const read = (name: string, spec: FileSpec | null): Case => ({
  name,
  op: 'read_journal',
  ...(spec === null ? {} : journal({ [journalPath]: spec })),
});

const PUBLICATION =
  '{"head":"h1","target":"t1","branch":"crq/fix-r","commits":["c1","c2"],"open_pr":false,"at":"2026-11-21T00:00:00Z"}';

describe('readJournal parity (json.loads(journal.read_text()) when journal.exists())', () => {
  it('absent reads as null, not an error, whatever is missing above it', async () => {
    const oracle = await expectParity([
      { name: 'no job dir', op: 'read_journal' },
      { name: 'job dir only', op: 'read_journal', files: { [`repair/${JOB}`]: { dir: true } } },
    ]);
    expect(oracle.map((o) => o.ok)).toEqual([null, null]);
  });

  it('returns the object with Python numbers, order, unicode and duplicate keys', async () => {
    await expectParity([
      read('plain', PUBLICATION),
      read('empty object', '{}'),
      read('crlf whitespace', '{\r\n"head": "h",\r\n"n": 1\r\n}\r\n'),
      read(
        'numbers',
        '{"i":3,"big":123456789012345678901234567890,"f":1.5,"e":1.5e-1,"z":-0.5,"neg":-7}',
      ),
      read('NaN and Infinity', '{"a":NaN,"b":Infinity,"c":-Infinity}'),
      read('duplicate keys: last wins', '{"head":"a","head":"b"}'),
      read('astral and BMP', '{"head":"\\ud83d\\ude00 é \\u00e9"}'),
      read('lone surrogate escape', '{"head":"\\ud800"}'),
      read('nested', '{"a":{"b":[1,{"c":null},[],{}],"d":true,"e":false}}'),
      read('pretty (as atomic writes it)', `{\n  "head": "h",\n  "commits": []\n}\n`),
      read('trailing newline absent', '{"head":"h"}'),
    ]);
  });

  it('a present journal that cannot be read or parsed is an error, never absent', async () => {
    const oracle = await expectParity([
      read('empty file', ''),
      read('whitespace only', ' \n'),
      read('truncated', '{"head":"h","commits":['),
      read('trailing garbage', '{"head":"h"} x'),
      read('two documents', '{} {}'),
      read('BOM', '﻿{"head":"h"}'),
      read('invalid utf-8', { hex: '7b2268223a22ff227d' }),
      read('single quotes', "{'head':'h'}"),
      read('trailing comma', '{"head":"h",}'),
      read('integer over 4300 digits', `{"n":${'9'.repeat(4301)}}`),
      read('a directory', { dir: true }),
      read('top-level null', 'null'),
      read('top-level list', '[{"head":"h"}]'),
      read('top-level string', '"head"'),
      read('top-level number', '7'),
      read('top-level true', 'true'),
    ]);
    expect(oracle.every((o) => o.error !== undefined)).toBe(true);
  });

  it('narrowing: an integral float reads back as an integer (Python keeps 2.0)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publication-files-'));
    cleanups.push(root);
    await mkdir(join(root, 'repair', JOB), { recursive: true });
    await writeFile(join(root, journalPath), '{"attempts":2.0,"e":1e2}');
    const read = await filePublicationEffects({ stateRoot: root }).readJournal(JOB);
    expect(read).toEqual({ attempts: 2, e: 100 });
    expect(Object.is((read as { attempts: number }).attempts, 2)).toBe(true);
  });

  it('an integer of exactly 4300 digits still parses', async () => {
    await expectParity([read('4300 digits', `{"n":${'9'.repeat(4300)}}`)]);
  });

  it.skipIf(process.getuid?.() === 0)('an unreadable journal is an error', async () => {
    await expectParity([{ ...read('mode 000', PUBLICATION), modes: { [journalPath]: 0 } }]);
  });

  it('classifies failures: OSError for a failed read, ValueError for decode and parse, TypeError for a non-object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publication-files-'));
    cleanups.push(root);
    const effects = filePublicationEffects({ stateRoot: root });
    const dir = join(root, 'repair', JOB);
    await mkdir(join(dir, 'publication.json'), { recursive: true });
    const classify = async (): Promise<string> => {
      try {
        await effects.readJournal(JOB);
        return 'returned';
      } catch (error) {
        return isPyError(error, 'OSError')
          ? 'OSError'
          : isPyError(error, 'TypeError')
            ? 'TypeError'
            : isPyError(error, 'ValueError')
              ? 'ValueError'
              : 'other';
      }
    };
    expect(await classify()).toBe('OSError');
    await rm(join(dir, 'publication.json'), { recursive: true });
    for (const [text, kind] of [
      ['{"head":', 'ValueError'],
      ['null', 'TypeError'],
      ['[]', 'TypeError'],
    ] as const) {
      await writeFile(join(dir, 'publication.json'), text);
      expect(await classify()).toBe(kind);
    }
    await writeFile(join(dir, 'publication.json'), Buffer.from([0x7b, 0xff]));
    expect(await classify()).toBe('ValueError');
  });
});

const write = (
  name: string,
  op: Case['op'],
  value: string,
  files?: Record<string, FileSpec>,
): Case => ({
  name,
  op,
  value,
  ...(files === undefined ? {} : { files }),
});

describe.each([
  ['writeJournal (atomic)', 'write_journal', journalPath],
  ['saveQueue (atomic)', 'save_queue', 'queue.json'],
] as const)('%s parity', (_label, op, target) => {
  const existing = { [target]: '{"old": true}\n' };

  it('writes the exact bytes of json.dump(indent=2) plus a newline', async () => {
    const oracle = await expectParity([
      write('publication', op, PUBLICATION),
      write('empty object', op, '{}'),
      write('overwrites an existing file', op, PUBLICATION, existing),
      write('overwrites a longer file', op, '{"a":1}', {
        [target]: `{"pad": "${'x'.repeat(500)}"}\n`,
      }),
      write('key order is insertion order', op, '{"z":1,"a":2,"m":{"b":1,"a":2}}'),
      write(
        'ints, floats, bool, null',
        op,
        '{"i":3,"f":1.5,"t":true,"f2":false,"n":null,"e":1e22,"s":-0.0}',
      ),
      write('big integers keep every digit', op, '{"big":123456789012345678901234567890}'),
      write('integral float stays a float', op, '{"attempts":2.0}'),
      write('ASCII-escaped unicode and astral', op, '{"é":"😀 é \\ud83d\\ude00 \\u2028"}'),
      write('lone surrogate escape', op, '{"x":"\\ud800"}'),
      write('empty containers', op, '{"a":[],"b":{},"c":[[],{}]}'),
      write('control characters', op, '{"a":"\\u0000\\u001f\\t\\n\\"\\\\/"}'),
      write('NaN and Infinity', op, '{"a":NaN,"b":Infinity,"c":-Infinity}'),
      write('existing file with another mode is replaced at 0600', op, '{}', existing),
    ]);
    // The atomic temp is gone and the final file is 0600 in both runtimes.
    for (const result of oracle) {
      for (const [path, [, mode]] of Object.entries(result.files)) {
        if (path === target) expect(mode).toBe(0o600);
      }
    }
    expect(Object.keys(oracle[0]?.files ?? {})).toEqual([target]);
  });

  it('a replaced file at mode 0644 ends 0600, as os.replace of a 0600 temp does', async () => {
    await expectParity([
      { ...write('mode 0644 before', op, '{}', existing), modes: { [target]: 0o644 } },
    ]);
  });

  it('creates the parent directory (Python mkdir -p) when it is missing', async () => {
    await expectParity([write('fresh tree', op, '{}')]);
  });
});

describe.each([
  ['writePatch (write_text)', 'write_patch', patchPath],
  ['writeFixPrBody (write_text)', 'write_fix_pr', bodyPath],
] as const)('%s parity', (_label, op, target) => {
  const dir = { [`repair/${JOB}`]: { dir: true } } as const;
  const text = (name: string, body: string, files?: Record<string, FileSpec>): Case => ({
    name,
    op,
    text: body,
    files: { ...dir, ...(files ?? {}) },
  });

  it('writes the text as UTF-8, truncating in place', async () => {
    await expectParity([
      text('new', 'diff --git a/f b/f\n+x\n'),
      text('empty plus newline', '\n'),
      text('empty', ''),
      text('crlf and lone cr are kept', 'a\r\nb\rc\n'),
      text('non-ASCII', 'é 😀 日本語\n'),
      text('overwrites a longer file', 'short\n', { [target]: 'x'.repeat(500) }),
      text('keeps the mode of an existing file', 'new\n', { [target]: 'old' }),
      { ...text('mode 0640 survives', 'new\n', { [target]: 'old' }), modes: { [target]: 0o640 } },
    ]);
  });

  it('a missing job directory fails and creates nothing', async () => {
    const oracle = await expectParity([{ name: 'no job dir', op, text: 'x\n' }]);
    expect(oracle[0]?.error).toBe('FileNotFoundError');
    expect(oracle[0]?.files).toEqual({});
  });

  it('a lone surrogate fails after the file was truncated', async () => {
    const oracle = await expectParity([
      text('new file', 'a\ud800b'),
      text('existing file', 'a\udfffb', { [target]: 'previous content' }),
    ]);
    expect(oracle.map((o) => o.error)).toEqual(['UnicodeEncodeError', 'UnicodeEncodeError']);
    expect(oracle.map((o) => o.files[target]?.[0])).toEqual(['', '']);
  });

  it('the target being a directory fails', async () => {
    await expectParity([text('directory', 'x', { [`${target}/keep`]: 'k' })]);
  });
});

describe('job id handling (TS-only narrowing: Python joins any string)', () => {
  let root: string;
  let effects: PublicationFileEffects;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crq-publication-files-'));
    effects = filePublicationEffects({ stateRoot: join(root, 'state') });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['empty', ''],
    ['no crq- prefix', 'job-1'],
    ['parent traversal', '../x'],
    ['absolute', '/tmp/x'],
    ['nested', 'crq-a/b'],
    ['trailing newline', 'crq-a\n'],
    ['number', 5],
    ['null', null],
    ['undefined', undefined],
    ['list', ['crq-a']],
  ])('refuses %s before touching the disk', async (_name, id) => {
    const refused = async (work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work();
        return false;
      } catch (error) {
        return isPyError(error, 'TypeError', 'ValueError');
      }
    };
    expect(await refused(() => effects.readJournal(id))).toBe(true);
    expect(await refused(() => effects.writeJournal(id, {}))).toBe(true);
    expect(await refused(() => effects.writePatch(id, 'x'))).toBe(true);
    expect(await refused(() => effects.writeFixPrBody(id, 'x'))).toBe(true);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('accepts the real grammar, including dots and dashes', async () => {
    await effects.writeJournal('crq-1.2_3-a', { a: 1 });
    expect(await effects.readJournal('crq-1.2_3-a')).toEqual({ a: 1 });
  });

  it('writeFixPrBody resolves to the path it wrote', async () => {
    await mkdir(join(root, 'state', 'repair', JOB), { recursive: true });
    const path = await effects.writeFixPrBody(JOB, 'body\n');
    expect(path).toBe(join(root, 'state', 'repair', JOB, 'fix-pr.md'));
    expect(await readFile(path, 'utf8')).toBe('body\n');
  });

  it('snapshots the journal and queue at the call, before the first await', async () => {
    const publication: Record<string, unknown> = { head: 'h', commits: ['a'] };
    const pending = effects.writeJournal(JOB, publication);
    publication.head = 'mutated';
    (publication.commits as string[]).push('b');
    await pending;
    expect(await effects.readJournal(JOB)).toEqual({ head: 'h', commits: ['a'] });

    const queue: Record<string, unknown> = { items: [{ id: 'a' }] };
    const saving = effects.saveQueue(queue);
    (queue.items as unknown[]).push({ id: 'b' });
    await saving;
    expect(JSON.parse(await readFile(join(root, 'state', 'queue.json'), 'utf8'))).toEqual({
      items: [{ id: 'a' }],
    });
  });

  it('an unserialisable value leaves the target and no temp behind', async () => {
    await effects.writeJournal(JOB, { head: 'old' });
    await expect(effects.writeJournal(JOB, { head: Symbol('x') })).rejects.toThrow();
    await expect(effects.writeJournal(JOB, { head: 2 ** 60 })).rejects.toThrow();
    expect(await readdir(join(root, 'state', 'repair', JOB))).toEqual(['publication.json']);
    expect(await effects.readJournal(JOB)).toEqual({ head: 'old' });
  });

  it('honours an explicit queue path', async () => {
    const custom = filePublicationEffects({
      stateRoot: join(root, 'state'),
      queuePath: join(root, 'elsewhere', 'q.json'),
    });
    await custom.saveQueue({ items: [] });
    expect(await readFile(join(root, 'elsewhere', 'q.json'), 'utf8')).toBe('{\n  "items": []\n}\n');
  });
});

describe('composition with the publication orchestrators', () => {
  it('is assignable to the publish and finalize effect declarations', () => {
    const effects = filePublicationEffects({ stateRoot: '/nonexistent' });
    const asPublish: Pick<
      PublicationPublishEffects,
      'readJournal' | 'writeJournal' | 'writePatch' | 'saveQueue'
    > = effects;
    const asFinalize: Pick<
      PublicationFinalizeEffects,
      'writeFixPrBody' | 'writeJournal' | 'saveQueue'
    > = effects;
    expect([asPublish, asFinalize]).toHaveLength(2);
  });

  it('a publish that fails at the push leaves a journal the next tick reads back and recovers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-publication-files-'));
    cleanups.push(root);
    const files = filePublicationEffects({ stateRoot: join(root, 'state') });
    await mkdir(join(root, 'state', 'repair', JOB), { recursive: true });
    const sha = (c: string): string => c.repeat(40);
    const calls: string[] = [];
    const effects = {
      ...files,
      iso: () => '2026-11-21T00:00:00Z',
      revParseDefaultRef: async () => sha('t'),
      prInfo: async () => ({ state: 'OPEN', headRefName: 'b', headRefOid: sha('t') }),
      isAncestor: async () => true,
      makeWorktree: async () => ({ path: '/wt', branch: 'w' }),
      removeWorktree: async () => {
        calls.push('remove');
      },
      revParseHead: async () => (calls.includes('pick') ? sha('h') : sha('b')),
      cherryPick: async () => {
        calls.push('pick');
      },
      verifyCherryPickHead: async () => undefined,
      conflictedFiles: async () => '',
      stagedFiles: async () => '',
      revListSince: async () => [sha('c')],
      verify: async () => undefined,
      diffSince: async () => 'diff --git a/f b/f',
      hackDetector: async () => undefined,
      secretScan: async () => true,
      updateRef: async () => undefined,
      push: async () => {
        calls.push('push');
        throw new Error('network down');
      },
      finalize: async () => undefined,
      lsRemoteHeads: async () => {
        calls.push('ls-remote');
        return '';
      },
      listBranchPrs: async () => [],
    } as unknown as PublicationPublishEffects;
    const item: Record<string, unknown> = { id: 'pr5', pr: 5, kind: 'open', state: 'repairing' };
    const record: Record<string, unknown> = {
      jobs: [JOB],
      base: sha('b'),
      open_pr: true,
      branch: 'b',
      state: 'ready',
    };
    const fixed = [{ job: JOB, verdict: 'FIXED', reason: 'ok', commits: [sha('c')] }];
    const q = { items: [item] };
    item.repair_runs = { run: record };

    await expect(publishRepair(effects, q, item, 'run', record, fixed)).rejects.toThrow(
      'network down',
    );
    const dir = join(root, 'state', 'repair', JOB);
    expect(await readFile(join(dir, 'publication.patch'), 'utf8')).toBe('diff --git a/f b/f\n');
    const saved = await readFile(join(dir, 'publication.json'), 'utf8');
    expect(saved).toBe(atomicJsonText(record.publication));
    // The queue was saved with the publication identity before the push.
    const queue = JSON.parse(await readFile(join(root, 'state', 'queue.json'), 'utf8')) as {
      items: { repair_runs: { run: { publication: unknown } } }[];
    };
    expect(queue.items[0]?.repair_runs.run.publication).toEqual(record.publication);

    // The next tick finds the journal on disk and takes the recovery arm.
    calls.length = 0;
    await publishRepair(effects, q, item, 'run', record, fixed).catch(() => undefined);
    expect(calls).toContain('ls-remote');
    expect(calls).not.toContain('pick');
  });
});
