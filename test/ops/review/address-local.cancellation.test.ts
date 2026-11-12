// Split provenance: test/ops/review/address-local.test.ts was split into
// subject files sharing ./address-local.helpers.ts. This file holds the
// cancellation cases for a single edit and for cancelled siblings.
import { lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeReviewAddress, type ReviewAddressReport } from '../../../src/ops/review/address.js';
import { runLadder } from '../../../src/kernel/governor.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { fixture, useGitleaksPath } from './address-local.helpers.js';

useGitleaksPath();
test('cancelled edit reports an ordinary local branch and finding pointer without publication', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const drivers: DriverFactory = {
    resolve: (request) => {
      const resolved = f.drivers.resolve(request);
      return {
        ...resolved,
        driver: {
          run: async (input) => {
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'CANCELLED PARTIAL\n');
            parent.abort();
            return {
              stopReason: 'aborted',
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          },
        },
      };
    },
  };
  try {
    const governed = await runLadder(
      () =>
        makeReviewAddress({ drivers, initialRecord: f.record })({
          repoRoot: f.repo.root,
          source: 'local',
          journalDir: f.journalDir,
          push: true,
        }),
      {},
      { op: 'review.address', jobKey: 'cancelled-address', attempt: 1 },
      { signal: parent.signal },
    );
    expect(governed.outcome).toBe('completed');
    if (governed.outcome !== 'completed') return;
    const result = governed.value;
    expect(result.status).toBe('needs-human');
    if (result.status === 'ok') return;
    const report = result.report!;
    expect(report.failed).toHaveLength(1);
    const retained = report.failed[0]!;
    expect(retained.gate).toBe('budget');
    expect(f.repo.git('show', `${retained.branch}:src/a.ts`)).toBe('CANCELLED PARTIAL\n');
    const evidence = report.findings[0]!.evidence;
    if (typeof evidence !== 'string') throw new Error('expected legacy evidence text');
    expect(JSON.parse(evidence)).toEqual(retained);
    expect(
      (JSON.parse(await readFile(report.reportPath, 'utf8')) as ReviewAddressReport).failed,
    ).toEqual(report.failed);
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = "BAD";\n');
    expect(f.repo.git('ls-remote', '--heads', 'origin', 'cq-address/*')).toBe('');
  } finally {
    await f.cleanup();
  }
});

// #1194: tracked symlinks, submodule pointers and glob-character file names
// are ordinary repository shapes; cancelling must retain the report anyway.
test.each(['true', 'false'] as const)(
  'cancelled settlement keeps the report across ordinary repo shapes: core.symlinks=%s',
  async (symlinks) => {
    const f = await fixture();
    const parent = new AbortController();
    f.repo.git('config', 'core.symlinks', symlinks);
    await symlink('src/a.ts', join(f.repo.root, 'link.ts'));
    f.repo.git('add', '--', 'link.ts');
    f.repo.git('init', '-q', 'sub');
    await f.repo.write('sub/inner.txt', 'inner\n');
    f.repo.git('-C', 'sub', 'add', '-A');
    f.repo.git('-C', 'sub', 'commit', '-q', '-m', 'inner');
    await f.repo.write('pages/[id].tsx', 'export const page = 1;\n');
    f.record.head = f.repo.commitAll('ordinary repository shapes');
    const drivers: DriverFactory = {
      resolve: (request) => {
        const resolved = f.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            run: async (input) => {
              await writeFile(join(input.workspace!.path, 'src/a.ts'), 'CANCELLED PARTIAL\n');
              parent.abort();
              return {
                stopReason: 'aborted',
                usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
                denials: [],
              };
            },
          },
        };
      },
    };
    try {
      const governed = await runLadder(
        () =>
          makeReviewAddress({ drivers, initialRecord: f.record })({
            repoRoot: f.repo.root,
            source: 'local',
            journalDir: f.journalDir,
            push: true,
          }),
        {},
        { op: 'review.address', jobKey: 'cancelled-shape-address', attempt: 1 },
        { signal: parent.signal },
      );
      expect(governed.outcome).toBe('completed');
      if (governed.outcome !== 'completed') return;
      const result = governed.value;
      expect(result.status).toBe('needs-human');
      if (result.status === 'ok') return;
      const report = result.report!;
      expect(report.failed).toHaveLength(1);
      const retained = report.failed[0]!;
      expect(retained.gate).toBe('budget');
      expect(f.repo.git('show', `${retained.branch}:src/a.ts`)).toBe('CANCELLED PARTIAL\n');
      expect(
        (JSON.parse(await readFile(report.reportPath, 'utf8')) as ReviewAddressReport).failed,
      ).toEqual(report.failed);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
        'export const a = "BAD";\n',
      );
      // The ordinary shapes survive untouched in the caller tree.
      expect(await readFile(join(f.repo.root, 'pages/[id].tsx'), 'utf8')).toBe(
        'export const page = 1;\n',
      );
      expect(await readFile(join(f.repo.root, 'sub/inner.txt'), 'utf8')).toBe('inner\n');
      expect((await lstat(join(f.repo.root, 'link.ts'))).isSymbolicLink()).toBe(true);
      expect(f.repo.git('ls-remote', '--heads', 'origin', 'cq-address/*')).toBe('');
    } finally {
      await f.cleanup();
    }
  },
);

test('cancelled siblings settle their actual writes before any terminal pin, restore or report', async () => {
  const f = await fixture();
  const parent = new AbortController();
  let release!: () => void, started!: () => void, firstSettled!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const both = new Promise<void>((done) => {
    started = done;
  });
  const first = new Promise<void>((done) => {
    firstSettled = done;
  });
  let active = 0;
  const drivers: DriverFactory = {
    resolve(request) {
      const resolved = f.drivers.resolve(request);
      return {
        ...resolved,
        driver: {
          run: async (input) => {
            const file = input.prompt.includes('"id":"seed-b"') ? 'src/b.ts' : 'src/a.ts';
            await writeFile(join(input.workspace!.path, file), `CANCELLED ${file}\n`);
            if (++active === 2) started();
            await both;
            if (file === 'src/a.ts') {
              parent.abort();
              firstSettled();
            } else {
              await held;
              // This awaited late write belongs to the actual driver lifetime.
              await writeFile(join(input.workspace!.path, file), 'SIBLING FINAL\n');
            }
            return {
              stopReason: 'aborted',
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          },
        },
      };
    },
  };
  await f.repo.write('src/b.ts', 'BASE B\n');
  f.record.head = f.repo.commitAll('sibling cancellation fixture');
  f.record.findings.push({ ...f.record.findings[0]!, id: 'seed-b', file: 'src/b.ts' });
  const pending = runLadder(
    () =>
      makeReviewAddress({ drivers, initialRecord: f.record })({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
        push: true,
        concurrency: 2,
      }),
    {},
    { op: 'review.address', jobKey: 'sibling-cancelled-address', attempt: 1 },
    { signal: parent.signal },
  );
  try {
    await first;
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('CANCELLED src/a.ts\n');
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
    await expect(readFile(join(f.journalDir, 'review-address-report.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    release();
    const result = await pending;
    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') return;
    expect(result.value.status).toBe('needs-human');
    if (result.value.status === 'ok') return;
    expect(result.value.report!.failed).toHaveLength(2);
    const retained = result.value.report!.failed;
    expect(retained.map((row) => f.repo.git('show', `${row.sha}:${row.file}`)).sort()).toEqual(
      ['CANCELLED src/a.ts\n', 'SIBLING FINAL\n'].sort(),
    );
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = "BAD";\n');
    expect(await readFile(join(f.repo.root, 'src/b.ts'), 'utf8')).toBe('BASE B\n');
    expect(
      (JSON.parse(await readFile(result.value.report!.reportPath, 'utf8')) as ReviewAddressReport)
        .failed,
    ).toEqual(retained);
    expect(f.repo.git('ls-remote', '--heads', 'origin', 'cq-address/*')).toBe('');
  } finally {
    release();
    await Promise.allSettled([pending]);
    await f.cleanup();
  }
});
