import { describe, expect, test } from 'vitest';
import {
  OSError,
  RECEIPT_SAMPLE,
  newest,
  runMetadataProblem,
  runMetadataSample,
  type DirEntry,
  type RunMetadataEffects,
} from '../../../../src/ops/crq/deploy/runMetadata.js';

type Node =
  | { kind: 'dir'; mtime?: bigint | 'error' | undefined }
  | { kind: 'file'; data: Uint8Array | 'error' };

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An in-memory tree keyed by absolute path; parents are implied by the keys. */
function fake(tree: Record<string, Node>, state = '/s'): RunMetadataEffects {
  const child = (dir: string): DirEntry[] =>
    Object.keys(tree)
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => ({ name: p.slice(dir.length + 1), isDir: tree[p]?.kind === 'dir' }));
  return {
    stateDir: () => state,
    isDir: (p) => Promise.resolve(tree[p]?.kind === 'dir'),
    isFile: (p) => Promise.resolve(tree[p]?.kind === 'file'),
    listDir: (p) => Promise.resolve(child(p)),
    mtimeNs: (p) => {
      const node = tree[p];
      if (node?.kind !== 'dir' || node.mtime === undefined) return Promise.resolve(0n);
      if (node.mtime === 'error') return Promise.reject(new OSError('stat failed'));
      return Promise.resolve(node.mtime);
    },
    readFile: (p) => {
      const node = tree[p];
      if (node?.kind !== 'file' || node.data === 'error')
        return Promise.reject(new OSError(`[Errno 13] Permission denied: '${p}'`));
      return Promise.resolve(node.data);
    },
  };
}
const file = (text: string): Node => ({ kind: 'file', data: enc(text) });
const dir = (mtime?: bigint | 'error'): Node => ({ kind: 'dir', mtime });
const problem = (tree: Record<string, Node>): Promise<string | null> =>
  runMetadataProblem('/e', fake(tree));

describe('runMetadataProblem', () => {
  test('a parseable meta.json is fine, whatever it holds', async () => {
    expect(await problem({ '/e/meta.json': file('{"a":1}') })).toBeNull();
    expect(await problem({ '/e/meta.json': file('[]') })).toBeNull();
    expect(await problem({ '/e/meta.json': file(' \n"x"\t') })).toBeNull();
  });

  test('Python json.loads accepts NaN and Infinity; so does the port', async () => {
    expect(await problem({ '/e/meta.json': file('{"x": NaN, "y": -Infinity}') })).toBeNull();
  });

  test('unparseable meta.json is corrupt', async () => {
    expect(await problem({ '/e/meta.json': file('{') })).toBe('corrupt: unparseable meta.json');
    expect(await problem({ '/e/meta.json': file('') })).toBe('corrupt: unparseable meta.json');
    expect(await problem({ '/e/meta.json': file('﻿{}') })).toBe('corrupt: unparseable meta.json');
    expect(
      await problem({ '/e/meta.json': { kind: 'file', data: Uint8Array.of(0x22, 0xff, 0x22) } }),
    ).toBe('corrupt: unparseable meta.json');
  });

  test('an unreadable meta.json reports the OS error, cut to 80 code points', async () => {
    const reason = await problem({ '/e/meta.json': { kind: 'file', data: 'error' } });
    expect(reason).toBe(
      `unreadable: ${"[Errno 13] Permission denied: '/e/meta.json'".slice(0, 80)}`,
    );
    const long = fake({ '/e/meta.json': file('{}') });
    long.readFile = () => Promise.reject(new OSError('😀'.repeat(100)));
    expect(await runMetadataProblem('/e', long)).toBe(`unreadable: ${'😀'.repeat(80)}`);
  });

  test('an empty run directory is missing metadata', async () => {
    expect(await problem({})).toBe('missing meta.json: empty run directory');
  });

  test('pre-launch artifacts are an expected stop', async () => {
    expect(await problem({ '/e/secret-scan.json': file('{}') })).toBe('prelaunch');
    expect(
      await problem({
        '/e/secret-scan.json': file('{}'),
        '/e/context-secret-scan.json': file('{"a":1}'),
      }),
    ).toBe('prelaunch');
  });

  test('pre-launch artifacts must be objects, checked in sorted order', async () => {
    expect(
      await problem({
        '/e/secret-scan.json': file('[]'),
        '/e/context-secret-scan.json': file('1'),
      }),
    ).toBe('corrupt pre-launch artifact: context-secret-scan.json');
    expect(await problem({ '/e/secret-scan.json': file('"x"') })).toBe(
      'corrupt pre-launch artifact: secret-scan.json',
    );
    expect(await problem({ '/e/secret-scan.json': file('{') })).toBe(
      'corrupt: unparseable pre-launch artifact',
    );
    expect(await problem({ '/e/secret-scan.json': { kind: 'file', data: 'error' } })).toMatch(
      /^unreadable: /,
    );
  });

  test('context-secret-scan alone is not a pre-launch stop', async () => {
    expect(await problem({ '/e/context-secret-scan.json': file('{}') })).toBe(
      'missing meta.json alongside context-secret-scan.json',
    );
  });

  test('other contents are listed sorted and cut to 120 code points', async () => {
    expect(
      await problem({
        '/e/b.log': file(''),
        '/e/a.log': file(''),
        '/e/secret-scan.json': file('{}'),
      }),
    ).toBe('missing meta.json alongside a.log,b.log,secret-scan.json');
    const tree: Record<string, Node> = {};
    for (let i = 0; i < 30; i++)
      tree[`/e/${'x'.repeat(10)}${String(i).padStart(2, '0')}`] = file('');
    const reason = (await problem(tree)) ?? '';
    expect(reason.startsWith('missing meta.json alongside xxxxxxxxxx00,')).toBe(true);
    expect(reason).toHaveLength('missing meta.json alongside '.length + 120);
  });

  test('sorts names by code point, not UTF-16 unit', async () => {
    expect(await problem({ '/e/\u{1F600}': file(''), '/e/￿': file('') })).toBe(
      'missing meta.json alongside ￿,\u{1F600}',
    );
  });
});

describe('newest', () => {
  const entries = (...names: string[]) => names.map((name) => ({ name, path: `/p/${name}` }));
  const times = (m: Record<string, bigint | 'error'>) => (p: string) => {
    const v = m[p.slice(3)];
    return v === 'error' ? Promise.reject(new OSError('x')) : Promise.resolve(v ?? 0n);
  };

  test('most recent first, ties by name', async () => {
    const got = await newest(entries('c', 'a', 'b', 'd'), 3, times({ c: 5n, a: 1n, b: 5n, d: 9n }));
    expect(got.map((e) => e.name)).toEqual(['d', 'b', 'c']);
  });

  test('an unstattable entry is sampleable but never preferred', async () => {
    const m = times({ a: 'error', b: 0n, c: 0n });
    expect((await newest(entries('a', 'b', 'c'), 3, m)).map((e) => e.name)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect((await newest(entries('a', 'b', 'c'), 2, m)).map((e) => e.name)).toEqual(['b', 'c']);
  });

  test('a seam failure that is not an OSError propagates', async () => {
    await expect(
      newest(entries('a'), 1, () => Promise.reject(new TypeError('boom'))),
    ).rejects.toThrow('boom');
  });

  test('name ties use code point order', async () => {
    const got = await newest(entries('\u{1F600}', '￿'), 1, () => Promise.resolve(7n));
    expect(got.map((e) => e.name)).toEqual(['￿']);
  });

  test('nanosecond mtimes beyond 2^53 still order', async () => {
    const big = 2n ** 60n;
    const got = await newest(entries('a', 'b'), 1, times({ a: big, b: big + 1n }));
    expect(got.map((e) => e.name)).toEqual(['b']);
  });
});

describe('runMetadataSample', () => {
  test('no runs directory is null', async () => {
    expect(await runMetadataSample(fake({ '/s': dir() }))).toBeNull();
    expect(await runMetadataSample(fake({ '/s/runs': file('') }))).toBeNull();
  });

  test('counts readable, pre-launch, unreadable and ignored entries', async () => {
    const sample = await runMetadataSample(
      fake({
        '/s/runs': dir(),
        '/s/runs/ok': dir(3n),
        '/s/runs/ok/meta.json': file('{}'),
        '/s/runs/pre': dir(2n),
        '/s/runs/pre/secret-scan.json': file('{}'),
        '/s/runs/bad': dir(1n),
        '/s/runs/bad/meta.json': file('{'),
        '/s/runs/._ok': file(''),
        '/s/runs/stray.txt': file(''),
      }),
    );
    expect(sample).toEqual({
      sampled: 3,
      readable: 1,
      prelaunch: 1,
      unreadable: [{ run: 'bad', reason: 'corrupt: unparseable meta.json' }],
      ignored_entries: 2,
    });
  });

  test('samples only the newest RECEIPT_SAMPLE runs', async () => {
    const tree: Record<string, Node> = { '/s/runs': dir() };
    for (let i = 0; i < RECEIPT_SAMPLE + 2; i++) {
      tree[`/s/runs/r${String(i).padStart(2, '0')}`] = dir(BigInt(i));
      // The two oldest are corrupt; they must fall outside the sample.
      tree[`/s/runs/r${String(i).padStart(2, '0')}/meta.json`] = file(i < 2 ? '{' : '{}');
    }
    const sample = await runMetadataSample(fake(tree));
    expect(RECEIPT_SAMPLE).toBe(10);
    expect(sample).toMatchObject({ sampled: 10, readable: 10, unreadable: [] });
  });

  test('unreadable runs keep newest-first order', async () => {
    const sample = await runMetadataSample(
      fake({
        '/s/runs': dir(),
        '/s/runs/a': dir(1n),
        '/s/runs/a/meta.json': file('{'),
        '/s/runs/b': dir(2n),
        '/s/runs/b/meta.json': file('{'),
      }),
    );
    expect(sample?.unreadable.map((u) => u.run)).toEqual(['b', 'a']);
  });

  test('a listing failure on state/runs itself propagates', async () => {
    const e = fake({ '/s/runs': dir() });
    e.listDir = () => Promise.reject(new OSError('denied'));
    await expect(runMetadataSample(e)).rejects.toThrow('denied');
  });
});
