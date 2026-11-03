// Split provenance: test/api-report.test.mjs was split into test/api-report.<subject>.test.mjs files.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

import { makeReport } from '../scripts/api-report.mjs';
import { fixture } from './api-report.helpers.mjs';

test('preserves conditional export keys and targets instead of deduplicating branches', async () => {
  const root = await fixture({
    '.': { import: './dist/esm.js', require: './dist/cjs.cjs' },
  });
  try {
    await writeFile(path.join(root, 'dist/esm.js'), 'export {};\n');
    await writeFile(path.join(root, 'dist/esm.d.ts'), 'export {};\n');
    await writeFile(path.join(root, 'dist/cjs.cjs'), 'module.exports = {};\n');
    await writeFile(path.join(root, 'dist/cjs.d.cts'), 'export {};\n');
    const report = await makeReport(root);
    assert.deepEqual(report.entries[0].exportMap, {
      import: './dist/esm.js',
      require: './dist/cjs.cjs',
    });
    assert.deepEqual(
      report.entries[0].targets.map(({ conditions, target }) => ({
        conditions,
        target,
      })),
      [
        { conditions: ['import'], target: './dist/esm.js' },
        { conditions: ['require'], target: './dist/cjs.cjs' },
      ],
    );

    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: {
          '.': { require: './dist/cjs.cjs', import: './dist/esm.js' },
        },
      }),
    );
    assert.notDeepEqual(await makeReport(root), report);

    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: {
          '.': { import: './dist/cjs.cjs', require: './dist/esm.js' },
        },
      }),
    );
    assert.notDeepEqual(await makeReport(root), report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts string exports, explicit types conditions, and rejects wildcard targets', async () => {
  const root = await fixture('./dist/index.js');
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(path.join(root, 'dist/index.d.ts'), 'export {};\n');
    assert.equal((await makeReport(root)).entries[0].specifier, '.');

    await mkdir(path.join(root, 'types'), { recursive: true });
    await writeFile(path.join(root, 'types/shared.d.ts'), 'export {};\n');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: { '.': { types: './types/shared.d.ts', import: './dist/other.js' } },
      }),
    );
    await writeFile(path.join(root, 'dist/other.js'), 'export {};\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets.map(({ declaration }) => declaration),
      ['./types/shared.d.ts', './types/shared.d.ts'],
    );

    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', exports: { './f/*': './dist/*.js' } }),
    );
    await assert.rejects(makeReport(root), /unsupported wildcard target/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('treats an all-condition exports object as the root entry', async () => {
  const root = await fixture({ import: './dist/index.js', default: './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(path.join(root, 'dist/index.d.ts'), 'export {};\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries.map(({ specifier }) => specifier),
      ['.'],
    );
    assert.deepEqual(
      report.entries[0].targets.map(({ conditions }) => conditions),
      [['import'], ['default']],
    );

    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', exports: { '.': './dist/index.js', import: './x.js' } }),
    );
    await assert.rejects(makeReport(root), /mixes subpath and condition keys/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves nested types condition maps per runtime branch', async () => {
  const root = await fixture({
    '.': {
      types: { import: './types/index.d.mts', require: './types/index.d.cts' },
      import: './dist/index.mjs',
      require: './dist/index.cjs',
    },
  });
  try {
    await mkdir(path.join(root, 'types'), { recursive: true });
    await writeFile(path.join(root, 'dist/index.mjs'), 'export {};\n');
    await writeFile(path.join(root, 'dist/index.cjs'), 'module.exports = {};\n');
    await writeFile(path.join(root, 'types/index.d.mts'), 'export {};\n');
    await writeFile(path.join(root, 'types/index.d.cts'), 'export {};\n');
    const report = await makeReport(root);
    const byTarget = Object.fromEntries(
      report.entries[0].targets.map(({ target, declaration }) => [target, declaration]),
    );
    assert.equal(byTarget['./dist/index.mjs'], './types/index.d.mts');
    assert.equal(byTarget['./dist/index.cjs'], './types/index.d.cts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips null export targets, maps .jsx, and allows dotted filenames', async () => {
  const root = await fixture({
    '.': { import: './dist/index.jsx', default: './dist/foo..js' },
    './internal': null,
  });
  try {
    await writeFile(path.join(root, 'dist/index.jsx'), 'export {};\n');
    await writeFile(path.join(root, 'dist/index.d.ts'), 'export {};\n');
    await writeFile(path.join(root, 'dist/foo..js'), 'export {};\n');
    await writeFile(path.join(root, 'dist/foo..d.ts'), 'export {};\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries.map(({ specifier, targets }) => [specifier, targets.length]),
      [
        ['.', 2],
        ['./internal', 0],
      ],
    );
    assert.equal(report.entries[1].exportMap, null);
    assert.equal(report.entries[0].targets[0].declaration, './dist/index.d.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an earlier matching export condition wins over a later types sibling', async () => {
  for (const earlier of ['default', 'import']) {
    const root = await fixture({
      '.': { [earlier]: './dist/index.js', types: './dist/later.d.ts' },
    });
    try {
      await writeFile(path.join(root, 'dist/index.js'), 'export {};');
      await writeFile(path.join(root, 'dist/index.d.ts'), 'export * from "./leaf.js";');
      await writeFile(path.join(root, 'dist/leaf.d.ts'), 'export type Visible = string;');
      await writeFile(path.join(root, 'dist/later.d.ts'), 'export {};');
      const report = await makeReport(root);
      assert.equal(report.entries[0].targets[0].declaration, './dist/index.d.ts');
      assert.deepEqual(
        report.entries[0].targets[0].declarationGraph.map(({ path }) => path),
        ['./dist/index.d.ts', './dist/leaf.d.ts'],
      );
      await writeFile(path.join(root, 'dist/leaf.d.ts'), 'export type Visible = number;');
      assert.notDeepEqual(await makeReport(root), report);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
