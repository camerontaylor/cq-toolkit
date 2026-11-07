import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Known process entry points only. This guard cannot discover a new helper
 * that launches a process transitively; it is a source-derived cross-check
 * of the hand-maintained test/suite-classes.json, not a complete dynamic
 * process detector.
 */
const PROCESS_ENTRY_POINTS = [
  /^import(?!\s+type\b)[^;]*from ['"](node:)?child_process['"]/m,
  /\bspawnAcpProcess\s*\(/,
  /\bspawnManaged\s*\(/,
  /\bmakeSubprocessWorktreeEffects\s*\(/,
  /\bgenerateScratchRepo\s*\(/,
  /\bcreateGitTemplate\s*\(/,
  /\bcloneTemplate\s*\(/,
  /\bcopyRatchetEngine\s*\(/,
  /\brunSweepPlan\s*\(/,
] as const;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const READ_BATCH_SIZE = 8;

type InventoryFiles = {
  entries: (root: string) => Promise<string[]>;
  source: (path: string) => Promise<string>;
};

const inventoryFiles: InventoryFiles = {
  entries: (root) => readdir(root, { recursive: true }),
  source: (path) => readFile(path, 'utf8'),
};

async function processBackedTestFiles(io: InventoryFiles = inventoryFiles): Promise<string[]> {
  const root = join(REPOSITORY_ROOT, 'test');
  const entries = (await io.entries(root)).filter(
    (entry) => entry.endsWith('.test.ts') || entry.endsWith('.test.mjs'),
  );
  const files: string[] = [];
  // Bound concurrent I/O without omitting any file or retaining a cached scan.
  for (let offset = 0; offset < entries.length; offset += READ_BATCH_SIZE) {
    const matches = await Promise.all(
      entries.slice(offset, offset + READ_BATCH_SIZE).map(async (entry) => {
        const path = join(root, entry);
        const source = await io.source(path);
        return PROCESS_ENTRY_POINTS.some((pattern) => pattern.test(source))
          ? relative(REPOSITORY_ROOT, path).replaceAll('\\', '/')
          : null;
      }),
    );
    files.push(...matches.filter((path): path is string => path !== null));
  }
  return files.sort();
}

async function suiteClasses(): Promise<Record<string, string>> {
  const manifest = await readFile(join(REPOSITORY_ROOT, 'test/suite-classes.json'), 'utf8');
  return JSON.parse(manifest) as Record<string, string>;
}

/** Process-backed files the manifest still classifies `pure` (the misclassification check). */
function misclassifiedAsPure(files: string[], classes: Record<string, string>): string[] {
  return files.filter((file) => classes[file] === 'pure');
}

describe('real-process inventory', () => {
  test('the entry-point scan still finds the known process-backed suites', async () => {
    // A scan that silently matched nothing would make the check below vacuous.
    expect(await processBackedTestFiles()).toEqual(
      expect.arrayContaining([
        'test/driver/claude-code/cli.child-process.test.ts',
        'test/ops/ratchet/git.test.ts',
        // `.test.mjs` suites are process-backed too — the manifest registers seven.
        'test/api-report.cli.test.mjs',
      ]),
    );
  });

  test('no file that reaches a process entry point is classified pure', async () => {
    // Unlisted files default to `process` in vitest.config.ts, so only an
    // explicit `pure` entry can put a process-backed file under pure budgets.
    const classes = await suiteClasses();
    expect(misclassifiedAsPure(await processBackedTestFiles(), classes)).toEqual([]);
  });

  test('a process-backed .test.mjs classified pure is caught', async () => {
    // The failure mode the extension filter used to miss: an .mjs suite that
    // spawns a process but is marked `pure` in the manifest.
    const files = await processBackedTestFiles({
      entries: async () => ['fixture.test.mjs'],
      source: async () => ['import { spawnSync }', "from 'node:child_process';"].join(' '),
    });
    expect(files).toEqual(['test/fixture.test.mjs']);
    expect(misclassifiedAsPure(files, { 'test/fixture.test.mjs': 'pure' })).toEqual([
      'test/fixture.test.mjs',
    ]);
  });
});

function signal() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

describe('inventory read batches', () => {
  test('reads every nested test in bounded concurrent batches and sorts normalized matches', async () => {
    const callNames = [
      'spawnAcpProcess',
      'spawnManaged',
      'makeSubprocessWorktreeEffects',
      'generateScratchRepo',
      'createGitTemplate',
      'cloneTemplate',
      'copyRatchetEngine',
      'runSweepPlan',
    ];
    // Assemble fixture calls/imports so this pure suite's own source text
    // does not masquerade as a process-backed test to the real scanner.
    const contents = new Map<string, string>([
      ...callNames.map((name, index): [string, string] => [
        `nested/deeper/${index}.test.ts`,
        `${name}()`,
      ]),
      ['node-import.test.ts', ['import { spawn }', "from 'node:child_process';"].join(' ')],
      ['bare-import.test.ts', ['import { spawn }', "from 'child_process';"].join(' ')],
      ['nested\\windows.test.ts', [callNames[0], '()'].join('')],
      ['nested/deeper/8.test.mjs', [callNames[1], '()'].join('')],
      ['type-only.test.ts', ['import type { ChildProcess }', "from 'child_process';"].join(' ')],
      ...Array.from({ length: 7 }, (_, index): [string, string] => [
        `plain/${index}.test.ts`,
        'export {};',
      ]),
      ['ignored.ts', [callNames[0], '()'].join('')],
      ['ignored.test.ts.snap', [callNames[0], '()'].join('')],
      ['ignored.test.tsx', [callNames[0], '()'].join('')],
    ]);
    const entries = [...contents.keys()].reverse();
    const testEntries = entries.filter(
      (entry) => entry.endsWith('.test.ts') || entry.endsWith('.test.mjs'),
    );
    const root = join(REPOSITORY_ROOT, 'test');
    const releases = testEntries.map(() => signal());
    const batchesStarted = Array.from({ length: Math.ceil(testEntries.length / 8) }, () =>
      signal(),
    );
    const reads: string[] = [];
    let active = 0;
    let peak = 0;
    const scanning = processBackedTestFiles({
      entries: async (directory) => {
        expect(directory).toBe(root);
        return entries;
      },
      source: async (path) => {
        const entry = relative(root, path);
        const index = reads.length;
        reads.push(entry);
        active++;
        peak = Math.max(peak, active);
        batchesStarted[Math.floor(index / 8)]!.release();
        await releases[index]!.ready;
        active--;
        const source = contents.get(entry) ?? contents.get(entry.replaceAll('\\', '/'));
        if (source === undefined) throw new Error(`Unexpected read: ${entry}`);
        return source;
      },
    });

    for (const [batch, started] of batchesStarted.entries()) {
      await started.ready;
      const count = Math.min(8, testEntries.length - batch * 8);
      // The old serial loop has only one pending read here; an unbounded
      // Promise.all starts later batches before these reads are released.
      expect(active).toBe(count);
      expect(reads).toHaveLength(batch * 8 + count);
      for (const release of releases.slice(batch * 8, batch * 8 + count).reverse())
        release.release();
    }

    expect(await scanning).toEqual(
      [
        ...callNames.map((_, index) => `test/nested/deeper/${index}.test.ts`),
        'test/node-import.test.ts',
        'test/bare-import.test.ts',
        'test/nested/windows.test.ts',
        'test/nested/deeper/8.test.mjs',
      ].sort(),
    );
    expect(reads).toEqual(testEntries.map((entry) => relative(root, join(root, entry))));
    expect(peak).toBe(8);
    expect(active).toBe(0);
  });

  test('rejects read failures instead of returning partial matches or starting another batch', async () => {
    const failure = new Error('fixture read failed');
    const entries = Array.from({ length: 9 }, (_, index) => `${index}.test.ts`);
    const reads: string[] = [];
    await expect(
      processBackedTestFiles({
        entries: async () => entries,
        source: async (path) => {
          const entry = relative(join(REPOSITORY_ROOT, 'test'), path);
          reads.push(entry);
          if (entry === '7.test.ts') throw failure;
          return ['spawnManaged', '()'].join('');
        },
      }),
    ).rejects.toBe(failure);
    expect(reads).toEqual(entries.slice(0, 8));
  });

  test('propagates discovery errors without reading any files', async () => {
    const failure = new Error('fixture discovery failed');
    let reads = 0;
    await expect(
      processBackedTestFiles({
        entries: async () => {
          throw failure;
        },
        source: async () => {
          reads++;
          return '';
        },
      }),
    ).rejects.toBe(failure);
    expect(reads).toBe(0);
  });
});
