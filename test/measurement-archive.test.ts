// M8a — local measurement evidence bundle. One case per condition:
//   - explicit roots plus Git-common-dir receipts;
//   - sanitized files, checksums and a missing inventory;
//   - deterministic restore resolving available pointers;
//   - a missing session index stays unknown;
//   - no network.
// Local fixtures only: temp journal/receipt trees, no providers, no network.
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildMeasurementBundle,
  restoreMeasurementBundle,
  sanitizeEvidenceText,
} from '../scripts/archive-measurement-evidence.mjs';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), open: vi.fn(actual.open) };
});

interface EvidenceEntry {
  root: string;
  path: string;
  state: string;
  reason?: string;
  pointer?: string;
  sha256?: string;
  sourceSha256?: string;
  resolvedPath?: string;
}

interface SessionIndexEvidence {
  state: string;
  reason?: string;
  pointer?: string;
  sha256?: string;
  sourceSha256?: string;
  resolvedPath?: string;
}

interface Manifest {
  bundleVersion: number;
  runId: string;
  files: EvidenceEntry[];
  missing: EvidenceEntry[];
  sessionIndex: SessionIndexEvidence;
}

interface Restored {
  runId: string;
  files: EvidenceEntry[];
  pointers: Record<string, string>;
  unavailable: EvidenceEntry[];
  sessionIndex: SessionIndexEvidence;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-m8a-'));
  dirs.push(dir);
  return dir;
}

function entryOf(manifest: Manifest, root: string, path: string): EvidenceEntry {
  const entry = manifest.files.find((file) => file.root === root && file.path === path);
  if (entry === undefined) throw new Error(`no entry for ${root}/${path}`);
  return entry;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('M8a nominal evidence', () => {
  test('bundles explicit roots plus Git-common-dir receipts, sanitized and checksummed', async () => {
    const base = await workspace();
    const journal = join(base, 'journal');
    const receipt = join(base, 'common', 'cq-review-address', 'ns');
    await mkdir(join(journal, 'observations', 'work'), { recursive: true });
    await mkdir(join(journal, 'state'), { recursive: true });
    await mkdir(receipt, { recursive: true });
    const secret = 'm8a-fixture-secret-value';
    vi.stubEnv('CQ_M8A_TOKEN', secret);
    vi.stubEnv('CQ_LITERAL_TOKEN', 'true');
    const stream = `${JSON.stringify({
      type: 'composition-started',
      payload: {
        journalVersion: 3,
        workId: 'work',
        ok: true,
        token: 'safe',
        url: 'https://example.test/?ref=main',
        note: 'uses Bearer auth',
      },
    })}\n`;
    const report = `${JSON.stringify({
      apiKey: 'hunter2-fixture',
      providerKey: 'a'.repeat(32) + '.' + 'b'.repeat(16),
      url: 'https://build:fixture@example.test/repo?ref=main',
      echoed: secret,
    })}\n`;
    await writeFile(join(journal, 'observations', 'work', 'run.ndjson'), stream);
    await writeFile(join(journal, 'state', 'report.json'), report);
    await writeFile(join(receipt, 'dispatch.jsonl'), '{"action":"review"}\n');
    await writeFile(join(receipt, 'bookkeeping.json'), '{}\n');
    const indexPath = join(base, 'session-index.json');
    await writeFile(indexPath, `${JSON.stringify({ indexVersion: 1, sessions: [] })}\n`);

    const built = (await buildMeasurementBundle({
      runId: 'run-m8a-1',
      bundleRoot: join(base, 'bundles'),
      roots: [
        {
          name: 'fix',
          path: journal,
          files: ['observations/work/run.ndjson', 'state/report.json'],
        },
      ],
      gitCommonDir: join(base, 'common'),
      sessionIndexPath: indexPath,
    })) as { bundleDir: string; manifest: Manifest };

    expect(built.bundleDir).toBe(join(base, 'bundles', 'run-m8a-1'));
    expect(built.manifest.missing).toEqual([]);
    expect(new Set(built.manifest.files.map((file) => file.root))).toEqual(
      new Set(['fix', 'git-common-dir', 'session-index']),
    );
    expect(entryOf(built.manifest, 'git-common-dir', 'ns/dispatch.jsonl').state).toBe('present');
    expect(entryOf(built.manifest, 'git-common-dir', 'ns/bookkeeping.json').state).toBe('present');
    expect(built.manifest.sessionIndex.state).toBe('present');
    expect(JSON.stringify(built.manifest)).not.toContain(base);

    const streamEntry = entryOf(built.manifest, 'fix', 'observations/work/run.ndjson');
    const storedStream = await readFile(join(built.bundleDir, streamEntry.pointer!), 'utf8');
    // Journal bytes are bundled verbatim (no v3 parse/rewrite, version intact).
    expect(storedStream).toBe(stream);
    expect(storedStream).toContain('"journalVersion":3');

    const reportEntry = entryOf(built.manifest, 'fix', 'state/report.json');
    const storedReport = await readFile(join(built.bundleDir, reportEntry.pointer!), 'utf8');
    expect(storedReport).not.toContain(secret);
    expect(storedReport).not.toContain('a'.repeat(32) + '.' + 'b'.repeat(16));
    expect(storedReport).not.toContain('hunter2-fixture');
    expect(storedReport).not.toContain('build:fixture');
    expect(storedReport).toContain('https://example.test/repo');
    expect(storedReport).toContain('[redacted]');
    expect(sha256(storedReport)).toBe(reportEntry.sha256);
    expect(sha256(await readFile(join(journal, 'state', 'report.json')))).toBe(
      reportEntry.sourceSha256,
    );
    expect(sanitizeEvidenceText('Bearer fixture-token-long-enough')).toContain('[redacted]');

    const restored = (await restoreMeasurementBundle(built.bundleDir)) as Restored;
    expect(Object.keys(restored.pointers)).toEqual([
      'fix/observations/work/run.ndjson',
      'fix/state/report.json',
      'git-common-dir/ns/bookkeeping.json',
      'git-common-dir/ns/dispatch.jsonl',
      'session-index/session-index.json',
    ]);
    expect(restored.pointers['fix/state/report.json']).toBe(
      join(built.bundleDir, reportEntry.pointer!),
    );
    expect(restored.sessionIndex.state).toBe('present');
    const again = (await restoreMeasurementBundle(built.bundleDir)) as Restored;
    expect(again.pointers).toEqual(restored.pointers);
    expect(again.files).toEqual(restored.files);

    vi.stubEnv('XDG_STATE_HOME', join(base, 'state'));
    const defaulted = (await buildMeasurementBundle({ runId: 'run-default' })) as {
      bundleDir: string;
    };
    expect(defaulted.bundleDir).toBe(
      join(base, 'state', 'cq', 'measurement-bundles', 'run-default'),
    );
  });

  test('scans the required credential shapes without removing ordinary URL queries', () => {
    for (const value of [
      'AKIA' + 'A'.repeat(16),
      'eyJabc.def.signature',
      'Bearer fixture-token-long-enough',
      'https://user:password@example.test/?q=kept',
    ]) {
      expect(sanitizeEvidenceText(value)).not.toContain(value);
    }
    expect(sanitizeEvidenceText('https://example.test/?q=kept')).toBe(
      'https://example.test/?q=kept',
    );
  });

  test('redacts quoted secret names and Z.ai keys while retaining short bearer prose', () => {
    const names = [
      'token',
      'SECRET',
      'password',
      'passphrase',
      'api_key',
      'apiKey',
      'ACCESS_TOKEN',
    ];
    for (const name of names) {
      const text = JSON.stringify({ [name]: 'hunter2-fixture-long' });
      expect(sanitizeEvidenceText(text)).toBe(JSON.stringify({ [name]: '[redacted]' }));
    }
    const zai = 'a'.repeat(32) + '.' + 'b'.repeat(16);
    expect(sanitizeEvidenceText(JSON.stringify({ key: zai }))).not.toContain(zai);
    expect(sanitizeEvidenceText('uses Bearer auth')).toBe('uses Bearer auth');
    expect(sanitizeEvidenceText('Bearer ' + 'a'.repeat(15))).toBe('Bearer ' + 'a'.repeat(15));
    expect(sanitizeEvidenceText('Bearer ' + 'a'.repeat(16))).toContain('[redacted]');
  });

  test('performs no network I/O', async () => {
    const source = await readFile('scripts/archive-measurement-evidence.mjs', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect([...imports].sort()).toEqual([
      'node:crypto',
      'node:fs',
      'node:fs/promises',
      'node:os',
      'node:path',
      'yaml',
    ]);
    for (const forbidden of [
      'fetch(',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'XMLHttpRequest',
      'WebSocket',
    ])
      expect(source).not.toContain(forbidden);
  });
});

describe('M8a missing evidence', () => {
  test('files expected but absent are inventoried, and the session index stays unknown', async () => {
    const base = await workspace();
    const journal = join(base, 'journal');
    await mkdir(journal, { recursive: true });
    await writeFile(join(journal, 'present.ndjson'), '{"ok":true}\n');
    const built = (await buildMeasurementBundle({
      runId: 'run-m8a-missing',
      bundleRoot: join(base, 'bundles'),
      roots: [{ name: 'fix', path: journal, files: ['present.ndjson', 'absent.ndjson'] }],
      sessionIndexPath: join(base, 'absent-session-index.json'),
    })) as { bundleDir: string; manifest: Manifest };

    expect(built.manifest.missing).toEqual([
      { root: 'fix', path: 'absent.ndjson', state: 'missing', reason: 'expected file is absent' },
      {
        root: 'session-index',
        path: 'absent-session-index.json',
        state: 'missing',
        reason: 'expected file is absent',
      },
    ]);
    expect(built.manifest.sessionIndex.state).toBe('unknown');
    expect(built.manifest.sessionIndex).not.toHaveProperty('pointer');

    const restored = (await restoreMeasurementBundle(built.bundleDir)) as Restored;
    expect(restored.pointers).toEqual({
      'fix/present.ndjson': join(built.bundleDir, 'files', 'fix', 'present.ndjson'),
    });
    expect(restored.unavailable.map((file) => file.path)).toEqual([
      'absent.ndjson',
      'absent-session-index.json',
    ]);
    expect(restored.sessionIndex.state).toBe('unknown');
    expect(restored.sessionIndex).not.toHaveProperty('sessions');
  });
});

describe('M8a failure evidence', () => {
  test('unsupported and escaping evidence is recorded, never silently skipped', async () => {
    const base = await workspace();
    const journal = join(base, 'journal');
    await mkdir(journal, { recursive: true });
    await writeFile(join(journal, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(base, 'outside.txt'), 'outside\n');
    const built = (await buildMeasurementBundle({
      runId: 'run-m8a-failure',
      bundleRoot: join(base, 'bundles'),
      roots: [{ name: 'fix', path: journal, files: ['binary.bin', '../outside.txt'] }],
    })) as { bundleDir: string; manifest: Manifest };

    expect(entryOf(built.manifest, 'fix', 'binary.bin').state).toBe('unsupported');
    expect(entryOf(built.manifest, 'fix', '../outside.txt').state).toBe('rejected');
    expect(built.manifest.missing).toHaveLength(2);
    expect(built.manifest.sessionIndex.state).toBe('unknown');
    expect(built.manifest).not.toHaveProperty('verdict');

    const restored = (await restoreMeasurementBundle(built.bundleDir)) as Restored;
    expect(restored.pointers).toEqual({});
    expect(restored.unavailable).toHaveLength(2);
  });

  test('rejects a symlinked receipts directory beneath a canonicalized commonDir', async () => {
    const base = await workspace();
    const common = join(base, 'common');
    const outside = join(base, 'outside');
    await mkdir(common);
    await mkdir(outside);
    await writeFile(join(outside, 'receipt.json'), '{"outside":true}');
    await symlink(outside, join(common, 'cq-review-address'));
    await symlink(common, join(base, 'common-alias'));
    const built = (await buildMeasurementBundle({
      runId: 'receipt-link',
      bundleRoot: join(base, 'bundles'),
      gitCommonDir: join(base, 'common-alias'),
    })) as {
      bundleDir: string;
      manifest: Manifest & { receipts: { state: string; reason: string } };
    };
    expect(built.manifest.receipts).toEqual({
      state: 'rejected',
      reason: 'symlink receipt path component',
    });
    expect(built.manifest.files).toEqual([]);
    expect(await fs.readdir(built.bundleDir)).toEqual(['manifest.json']);
    expect(((await restoreMeasurementBundle(built.bundleDir)) as Restored).pointers).toEqual({});
  });

  test('rejects symlinks, caps size, records read failures and missing receipts; uses private modes', async () => {
    const base = await workspace();
    const root = join(base, 'root');
    await mkdir(root);
    await writeFile(join(base, 'outside'), 'fixture');
    await symlink(join(base, 'outside'), join(root, 'link'));
    await symlink(base, join(root, 'parent'));
    await mkdir(join(root, 'directory'));
    await writeFile(join(root, 'large'), '');
    await truncate(join(root, 'large'), 8 * 1024 * 1024 + 1);
    // The marker is split at runtime: a literal PEM begin line in a committed
    // file trips the outgoing denylist scan (class:token-ssh-plumbing), which
    // covers every commit on the branch. Main's convention is the same
    // concatenation (test/ops/review/addressWorker.baseline.test.ts).
    const pemBegin = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
    const pemEnd = '-----END ' + 'OPENSSH PRIVATE KEY-----';
    const pem = [pemBegin, 'fixture-material', pemEnd].join('\n');
    await writeFile(join(root, 'pem'), pem);
    const input = {
      runId: 'safe',
      bundleRoot: join(base, 'bundles'),
      gitCommonDir: join(base, 'common'),
      roots: [
        { name: 'fix', path: root, files: ['link', 'parent/outside', 'directory', 'large', 'pem'] },
      ],
    };
    const built = (await buildMeasurementBundle(input)) as {
      bundleDir: string;
      manifest: Manifest & { receipts: { state: string } };
    };
    for (const path of ['link', 'parent/outside'])
      expect(entryOf(built.manifest, 'fix', path).state).toBe('rejected');
    expect(entryOf(built.manifest, 'fix', 'directory').state).toBe('unavailable');
    expect(entryOf(built.manifest, 'fix', 'large').state).toBe('unsupported');
    expect(built.manifest.receipts.state).toBe('missing');
    const entry = entryOf(built.manifest, 'fix', 'pem');
    expect(entry).toMatchObject({ sanitized: true, redactionCount: 1, sourceSha256: sha256(pem) });
    expect(await readFile(join(built.bundleDir, entry.pointer!), 'utf8')).toBe('[redacted]');
    expect((await stat(built.bundleDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(built.bundleDir, entry.pointer!))).mode & 0o777).toBe(0o600);
    expect((await stat(join(built.bundleDir, 'manifest.json'))).mode & 0o777).toBe(0o600);
    await expect(buildMeasurementBundle(input)).rejects.toMatchObject({ code: 'EEXIST' });
    for (const names of [['fix', 'fix'], ['git-common-dir'], ['session-index'], ['bad/name']]) {
      await expect(
        buildMeasurementBundle({
          ...input,
          runId: 'invalid',
          roots: names.map((name) => ({ name, path: root })),
        }),
      ).rejects.toThrow();
    }
    await expect(stat(join(base, 'bundles', 'invalid'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('sorts roots by code point and records non-file read failures', async () => {
    const base = await workspace();
    await mkdir(join(base, 'nested'));
    await writeFile(join(base, 'nested', 'file'), 'safe');
    await writeFile(join(base, 'first'), 'safe');
    const built = (await buildMeasurementBundle({
      runId: 'writes',
      bundleRoot: join(base, 'bundles'),
      roots: [
        { name: 'a', path: base, files: ['first'] },
        { name: 'Z', path: base, files: ['nested', 'nested/file'] },
      ],
    })) as { manifest: Manifest };
    expect(built.manifest.files.map((file) => file.root)).toEqual(['Z', 'Z', 'a']);
    expect(entryOf(built.manifest, 'Z', 'nested').state).toBe('unavailable');
  });

  test('records write errors and removes staging after a fatal manifest failure', async () => {
    const base = await workspace();
    await writeFile(join(base, 'file'), 'fixture');
    const input = {
      runId: 'writes',
      bundleRoot: join(base, 'bundles'),
      roots: [{ name: 'fix', path: base, files: ['file'] }],
    };
    const { writeFile: original } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (String(path).endsWith('/files/fix/file'))
        throw Object.assign(new Error('fixture'), { code: 'EIO' });
      return original(path, data, options);
    });
    const built = (await buildMeasurementBundle(input)) as { manifest: Manifest };
    expect(entryOf(built.manifest, 'fix', 'file')).toMatchObject({
      state: 'unavailable',
      reason: 'write failed (EIO)',
    });
    spy.mockImplementation(async () => {
      throw Object.assign(new Error('fixture'), { code: 'EIO' });
    });
    await expect(buildMeasurementBundle({ ...input, runId: 'fatal' })).rejects.toMatchObject({
      code: 'EIO',
    });
    await expect(stat(join(base, 'bundles', 'fatal'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(join(base, 'bundles'))).toEqual(['writes']);
    spy.mockImplementation(original);
  });

  test.each(['symlink', 'regular'])(
    'rejects a deterministic %s swap between lstat and open',
    async (kind) => {
      const base = await workspace();
      const root = join(base, 'root');
      await mkdir(root);
      const source = join(root, 'file');
      await writeFile(source, 'safe');
      await writeFile(join(base, 'outside'), 'outside-fixture');
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
        await actual.rename(source, join(root, 'original'));
        if (kind === 'symlink') await symlink(join(base, 'outside'), source);
        else await actual.rename(join(base, 'outside'), source);
        return actual.open(path, flags, mode);
      });
      const built = (await buildMeasurementBundle({
        runId: 'swap',
        bundleRoot: join(base, 'bundles'),
        roots: [{ name: 'fix', path: root, files: ['file'] }],
      })) as { bundleDir: string; manifest: Manifest };
      expect(entryOf(built.manifest, 'fix', 'file')).toMatchObject({ state: 'rejected' });
      expect(await fs.readdir(built.bundleDir)).toEqual(['manifest.json']);
    },
  );

  test('canonicalizes explicit root aliases but rejects symlinks below them', async () => {
    const base = await workspace();
    const root = join(base, 'root');
    await mkdir(root);
    await writeFile(join(root, 'file'), 'safe');
    await symlink(root, join(base, 'alias'));
    await symlink(join(root, 'file'), join(root, 'link'));
    const built = (await buildMeasurementBundle({
      runId: 'alias',
      bundleRoot: join(base, 'bundles'),
      roots: [{ name: 'fix', path: join(base, 'alias'), files: ['file', 'link'] }],
    })) as { manifest: Manifest };
    expect(entryOf(built.manifest, 'fix', 'file').state).toBe('present');
    expect(entryOf(built.manifest, 'fix', 'link').state).toBe('rejected');
  });

  test('names stale reservations and explains recovery without deleting them', async () => {
    const base = await workspace();
    const reservation = join(base, 'stale.building');
    await mkdir(reservation);
    await expect(buildMeasurementBundle({ runId: 'stale', bundleRoot: base })).rejects.toThrow(
      reservation,
    );
    await expect(buildMeasurementBundle({ runId: 'stale', bundleRoot: base })).rejects.toThrow(
      'remove this stale reservation',
    );
    expect((await stat(reservation)).isDirectory()).toBe(true);
  });

  test('a tampered stored file is not resolved', async () => {
    const base = await workspace();
    const journal = join(base, 'journal');
    await mkdir(journal, { recursive: true });
    await writeFile(join(journal, 'evidence.ndjson'), '{"ok":true}\n');
    const built = (await buildMeasurementBundle({
      runId: 'run-m8a-tamper',
      bundleRoot: join(base, 'bundles'),
      roots: [{ name: 'fix', path: journal, files: ['evidence.ndjson'] }],
    })) as { bundleDir: string; manifest: Manifest };

    const entry = entryOf(built.manifest, 'fix', 'evidence.ndjson');
    await writeFile(join(built.bundleDir, entry.pointer!), 'tampered\n');
    const restored = (await restoreMeasurementBundle(built.bundleDir)) as Restored;
    expect(restored.pointers).toEqual({});
    expect(restored.files[0]?.state).toBe('unavailable');
    expect(restored.files[0]?.reason).toContain('checksum');
  });

  test('a hand-edited manifest entry without a pointer stays non-passing', async () => {
    const base = await workspace();
    const journal = join(base, 'journal');
    await mkdir(journal, { recursive: true });
    await writeFile(join(journal, 'evidence.ndjson'), '{"ok":true}\n');
    const sessionIndexPath = join(base, 'session-index.json');
    await writeFile(sessionIndexPath, '{"sessions":[]}\n');
    const built = (await buildMeasurementBundle({
      runId: 'run-m8a-no-pointer',
      bundleRoot: join(base, 'bundles'),
      roots: [{ name: 'fix', path: journal, files: ['evidence.ndjson'] }],
      sessionIndexPath,
    })) as { bundleDir: string; manifest: Manifest };
    const manifestPath = join(built.bundleDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    // Hand-edited: the state still says present but the pointer is gone.
    delete entryOf(manifest, 'fix', 'evidence.ndjson').pointer;
    delete entryOf(manifest, 'session-index', 'session-index.json').pointer;
    delete manifest.sessionIndex.pointer;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const restored = (await restoreMeasurementBundle(built.bundleDir)) as Restored;
    expect(restored.pointers).toEqual({});
    expect(restored.files.map((file) => [file.path, file.state, file.reason])).toEqual([
      ['evidence.ndjson', 'unavailable', 'manifest entry lacks a bundle pointer'],
      ['session-index.json', 'unavailable', 'manifest entry lacks a bundle pointer'],
    ]);
    expect(restored.sessionIndex.state).toBe('unknown');
  });

  test('a stored pointer that symlinks outside the bundle is not resolved', async () => {
    const base = await workspace();
    const journal = join(base, 'journal');
    await mkdir(journal, { recursive: true });
    await writeFile(join(journal, 'evidence.ndjson'), '{"ok":true}\n');
    const built = (await buildMeasurementBundle({
      runId: 'run-m8a-pointer-link',
      bundleRoot: join(base, 'bundles'),
      roots: [{ name: 'fix', path: journal, files: ['evidence.ndjson'] }],
    })) as { bundleDir: string; manifest: Manifest };

    const entry = entryOf(built.manifest, 'fix', 'evidence.ndjson');
    const stored = join(built.bundleDir, entry.pointer!);
    // Same bytes, so only the containment check can reject the pointer.
    const outside = join(base, 'outside-evidence.ndjson');
    await writeFile(outside, await readFile(stored));
    await rm(stored);
    await symlink(outside, stored);

    const restored = (await restoreMeasurementBundle(built.bundleDir)) as Restored;
    expect(restored.pointers).toEqual({});
    expect(restored.files[0]?.state).toBe('unavailable');
    expect(restored.files[0]?.reason).toBe('bundle pointer escapes the bundle');
  });
});
