// Split provenance: test/api-report.test.mjs was split into test/api-report.<subject>.test.mjs files.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

import { makeReport } from '../scripts/api-report.mjs';
import { fixture } from './api-report.helpers.mjs';

test('follows package-internal # imports and ignores external aliases', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: { '.': './dist/index.js' },
        imports: {
          '#model': './dist/model.js',
          '#lib/*': { types: './dist/lib/*.d.ts' },
          '#ext': 'some-package',
        },
      }),
    );
    await mkdir(path.join(root, 'dist/lib'), { recursive: true });
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      'export type { Model } from "#model";\nexport type { X } from "#lib/x";\nexport type { E } from "#ext";\n',
    );
    await writeFile(path.join(root, 'dist/model.d.ts'), 'export type Model = string;\n');
    await writeFile(path.join(root, 'dist/lib/x.d.ts'), 'export type X = number;\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path: declaration }) => declaration),
      ['./dist/index.d.ts', './dist/lib/x.d.ts', './dist/model.d.ts'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves overlapping # import patterns by specificity, not declaration order', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: { '.': './dist/index.js' },
        imports: { '#*': './dist/broad/*.js', '#lib/*': './dist/lib/*.js' },
      }),
    );
    await mkdir(path.join(root, 'dist/lib'), { recursive: true });
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(path.join(root, 'dist/index.d.ts'), 'export type { X } from "#lib/x";\n');
    await writeFile(path.join(root, 'dist/lib/x.d.ts'), 'export type X = number;\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path: declaration }) => declaration),
      ['./dist/index.d.ts', './dist/lib/x.d.ts'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves conditional # imports using the containing declaration module mode', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: {
          '.': {
            import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
            require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
          },
        },
        imports: {
          '#dep': { import: './dist/dep.mjs', require: './dist/dep.cjs' },
        },
      }),
    );
    for (const file of ['index.mjs', 'index.cjs']) {
      await writeFile(path.join(root, 'dist', file), 'export {};\n');
    }
    await writeFile(path.join(root, 'dist/index.d.mts'), 'export type { D } from "#dep";\n');
    await writeFile(path.join(root, 'dist/index.d.cts'), 'export type { D } from "#dep";\n');
    await writeFile(path.join(root, 'dist/dep.d.mts'), 'export type D = string;\n');
    await writeFile(path.join(root, 'dist/dep.d.cts'), 'export type D = number;\n');
    const report = await makeReport(root);
    const graphs = Object.fromEntries(
      report.entries[0].targets.map(({ conditions, declarationGraph }) => [
        conditions[0],
        declarationGraph.map(({ path: declaration }) => declaration),
      ]),
    );
    assert.deepEqual(graphs.import, ['./dist/dep.d.mts', './dist/index.d.mts']);
    assert.deepEqual(graphs.require, ['./dist/dep.d.cts', './dist/index.d.cts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
