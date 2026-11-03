// Split provenance: test/api-report.test.mjs was split into test/api-report.<subject>.test.mjs files.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

import { makeReport } from '../scripts/api-report.mjs';
import { fixture } from './api-report.helpers.mjs';

test('follows relative triple-slash type references to files and directory type entries', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await mkdir(path.join(root, 'dist/types'), { recursive: true });
    await writeFile(path.join(root, 'dist/index.js'), 'export {};');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      [
        '/// <reference types="./extra.d.ts" />',
        '/// <reference types="./types" />',
        '/// <reference types="external-package" />',
        '/* /// <reference types="./missing.d.ts" /> */',
        'export {};',
      ].join('\n'),
    );
    await writeFile(path.join(root, 'dist/extra.d.ts'), 'declare const extra: number;');
    await writeFile(path.join(root, 'dist/types/package.json'), '{"types":"custom.d.ts"}');
    await writeFile(path.join(root, 'dist/types/custom.d.ts'), 'declare const custom: number;');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path }) => path),
      ['./dist/extra.d.ts', './dist/index.d.ts', './dist/types/custom.d.ts'],
    );
    await writeFile(path.join(root, 'dist/extra.d.ts'), 'declare const extra: string;');
    assert.notDeepEqual(await makeReport(root), report);
    await rm(path.join(root, 'dist/extra.d.ts'));
    await assert.rejects(makeReport(root), /cannot resolve package declaration import/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves directory types and typings before index declarations, after file declarations', async () => {
  for (const field of ['types', 'typings']) {
    const root = await fixture({ '.': './dist/index.js' });
    try {
      await mkdir(path.join(root, 'dist/nested'), { recursive: true });
      await writeFile(path.join(root, 'dist/index.js'), 'export {};');
      await writeFile(path.join(root, 'dist/index.d.ts'), 'export * from "./nested";');
      await writeFile(
        path.join(root, 'dist/nested/package.json'),
        JSON.stringify({ [field]: './custom.d.ts' }),
      );
      await writeFile(path.join(root, 'dist/nested/custom.d.ts'), 'export type D = number;');
      await writeFile(path.join(root, 'dist/nested/index.d.ts'), 'export type Wrong = string;');
      const report = await makeReport(root);
      assert.deepEqual(
        report.entries[0].targets[0].declarationGraph.map(({ path }) => path),
        ['./dist/index.d.ts', './dist/nested/custom.d.ts'],
      );
      await writeFile(path.join(root, 'dist/nested/custom.d.ts'), 'export type D = string;');
      assert.notDeepEqual(await makeReport(root), report);
      await writeFile(path.join(root, 'dist/nested.d.ts'), 'export type FileWins = true;');
      assert.deepEqual(
        (await makeReport(root)).entries[0].targets[0].declarationGraph.map(({ path }) => path),
        ['./dist/index.d.ts', './dist/nested.d.ts'],
      );
      await rm(path.join(root, 'dist/nested.d.ts'));
      await writeFile(
        path.join(root, 'dist/nested/package.json'),
        JSON.stringify({ [field]: '../../../outside.d.ts' }),
      );
      await assert.rejects(makeReport(root), /escapes package root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
