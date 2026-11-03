// Split provenance: test/api-report.test.mjs was split into test/api-report.<subject>.test.mjs files.
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';

import { makeReport } from '../scripts/api-report.mjs';
import { fixture } from './api-report.helpers.mjs';

test('reports deterministic hashes for the reachable declaration graph', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(path.join(root, 'dist/index.d.ts'), 'export * from "./public.js";\n');
    await writeFile(path.join(root, 'dist/public.d.ts'), 'export { run } from "./leaf.js";\n');
    await writeFile(path.join(root, 'dist/leaf.d.ts'), 'export declare function run(): void;\n');
    const first = await makeReport(root);
    const second = await makeReport(root);
    assert.deepEqual(first, second);
    assert.equal(first.entries[0].specifier, '.');
    assert.deepEqual(
      first.entries[0].targets[0].declarationGraph.map(({ path: declaration }) => declaration),
      ['./dist/index.d.ts', './dist/leaf.d.ts', './dist/public.d.ts'],
    );
    assert.match(first.entries[0].targets[0].declarationGraph[0].sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores imports quoted inside declaration comments', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      [
        '/**',
        ' * @example',
        ' * import { ghost } from "./missing.js";',
        ' */',
        '// export * from "./also-missing.js";',
        'export * from "./leaf.js";',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(root, 'dist/leaf.d.ts'), 'export declare function run(): void;\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path: declaration }) => declaration),
      ['./dist/index.d.ts', './dist/leaf.d.ts'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('follows import attributes, escaped specifiers, template interpolations and JSON', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      [
        'export type A = import("./a.js", { with: { "resolution-mode": "import" } }).A;',
        'export * from "./fo\\u006f.js";',
        'export type T = `x${import("./t.js").T}y`;',
        'import data from "./data.json";',
        'export { data };',
        '',
      ].join('\n'),
    );
    for (const name of ['a', 'foo', 't']) {
      await writeFile(path.join(root, `dist/${name}.d.ts`), 'export {};\n');
    }
    await writeFile(path.join(root, 'dist/data.json'), '{"a":1}\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path: declaration }) => declaration),
      [
        './dist/a.d.ts',
        './dist/data.json',
        './dist/foo.d.ts',
        './dist/index.d.ts',
        './dist/t.d.ts',
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('follows bare triple-slash reference paths as file-relative', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      '/// <reference path="extra.d.ts" />\nexport {};\n',
    );
    await writeFile(path.join(root, 'dist/extra.d.ts'), 'declare const extra: number;\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path: declaration }) => declaration),
      ['./dist/extra.d.ts', './dist/index.d.ts'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores import-like text inside string literal types', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      'export type Label = \'import("./missing.js")\';\nexport * from "./leaf.js";\n',
    );
    await writeFile(path.join(root, 'dist/leaf.d.ts'), 'export declare function run(): void;\n');
    const report = await makeReport(root);
    assert.deepEqual(
      report.entries[0].targets[0].declarationGraph.map(({ path: declaration }) => declaration),
      ['./dist/index.d.ts', './dist/leaf.d.ts'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts a directly exported JSON file as its own declaration-graph leaf', async () => {
  const root = await fixture({ './package.json': './package.json' });
  try {
    const report = await makeReport(root);
    const [target] = report.entries[0].targets;
    assert.equal(target.declaration, './package.json');
    assert.deepEqual(
      target.declarationGraph.map(({ path: declaration }) => declaration),
      ['./package.json'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
