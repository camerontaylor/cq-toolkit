// Split provenance: test/api-report.test.mjs was split into test/api-report.<subject>.test.mjs files.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

import { makeReport } from '../scripts/api-report.mjs';
import { fixture } from './api-report.helpers.mjs';

test('uses the nearest package scope for aliases and declaration module mode', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        type: 'module',
        exports: { '.': './dist/index.js' },
        imports: { '#dep': './dist/wrong.js' },
      }),
    );
    await mkdir(path.join(root, 'dist/nested/deeper'), { recursive: true });
    await writeFile(path.join(root, 'dist/index.js'), 'export {};');
    await writeFile(path.join(root, 'dist/index.d.ts'), 'export * from "./nested/deeper/api.js";');
    await writeFile(
      path.join(root, 'dist/nested/package.json'),
      JSON.stringify({
        type: 'commonjs',
        imports: { '#dep': { import: './wrong.js', require: './dep.js' } },
      }),
    );
    await writeFile(path.join(root, 'dist/nested/deeper/api.d.ts'), 'export * from "#dep";');
    await writeFile(path.join(root, 'dist/nested/dep.d.ts'), 'export type D = number;');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path }) => path),
      ['./dist/index.d.ts', './dist/nested/deeper/api.d.ts', './dist/nested/dep.d.ts'],
    );
    await writeFile(
      path.join(root, 'dist/nested/package.json'),
      '{"imports":{"#other":"external-package"}}',
    );
    await assert.rejects(makeReport(root), /cannot resolve package import #dep/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('follows relative and package-local module augmentations but ignores quoted examples', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: { '.': './dist/index.js' },
        imports: { '#local': './dist/local.js' },
      }),
    );
    await writeFile(path.join(root, 'dist/index.js'), 'export {};');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      [
        'declare module "./leaf.js" { interface Added { enabled: true } }',
        'declare module "#local" { interface Added { local: true } }',
        'declare module "external-package" { interface Added {} }',
        '// declare module "./missing.js" {}',
        'export type Example = \'declare module "./also-missing.js" {}\';',
      ].join('\n'),
    );
    await writeFile(path.join(root, 'dist/leaf.d.ts'), 'export interface Added {}');
    await writeFile(path.join(root, 'dist/local.d.ts'), 'export interface Added {}');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path }) => path),
      ['./dist/index.d.ts', './dist/leaf.d.ts', './dist/local.d.ts'],
    );
    await writeFile(path.join(root, 'dist/leaf.d.ts'), 'export interface Added { value: number }');
    assert.notDeepEqual(await makeReport(root), report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('records effective package type even when declaration bytes do not change', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};');
    await writeFile(path.join(root, 'dist/index.d.ts'), 'export {};');
    const implicit = await makeReport(root);
    assert.equal(implicit.packageType, 'commonjs');
    for (const type of ['commonjs', 'module']) {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          type,
          exports: { '.': './dist/index.js' },
        }),
      );
      const report = await makeReport(root);
      assert.equal(report.packageType, type);
      assert.deepEqual(report.entries, implicit.entries);
      if (type === 'commonjs') assert.deepEqual(report, implicit);
      else assert.notDeepEqual(report, implicit);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
