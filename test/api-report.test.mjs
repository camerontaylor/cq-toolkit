import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { makeReport, parseArgs } from '../scripts/api-report.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/api-report.mjs', import.meta.url));

async function fixture(exports) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cq-api-report-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', exports }));
  await mkdir(path.join(root, 'dist'), { recursive: true });
  return root;
}

test('draft mode is explicit and default mode remains baseline comparison', () => {
  assert.equal(parseArgs(['--draft']).draft, true);
  assert.equal(parseArgs([]).draft, false);
  assert.throws(() => parseArgs(['--invented']), /unknown argument/);
});

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

// Spawns the CLI per assertion; allow headroom on loaded hosts.
test('CLI baseline comparison detects re-export leaf and side-effect augmentation edits', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      'import "./augmentation.js";\nexport * from "./leaf.js";\n',
    );
    const augmentationPath = path.join(root, 'dist/augmentation.d.ts');
    await writeFile(
      augmentationPath,
      'declare global { interface Window { cq?: boolean } }\nexport {};\n',
    );
    const leafPath = path.join(root, 'dist/leaf.d.ts');
    await writeFile(leafPath, 'export declare function run(): void;\n');
    const baselinePath = path.join(root, 'approved-api-report.json');
    await writeFile(baselinePath, `${JSON.stringify(await makeReport(root), null, 2)}\n`);

    const matches = spawnSync(process.execPath, [scriptPath, '--baseline', baselinePath], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(matches.status, 0, matches.stderr);
    assert.match(matches.stdout, /matches baseline/);

    await writeFile(leafPath, 'export declare function run(value: string): boolean;\n');
    const drifts = spawnSync(process.execPath, [scriptPath, '--baseline', baselinePath], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(drifts.status, 1);
    assert.match(drifts.stderr, /differs from baseline/);

    await writeFile(leafPath, 'export declare function run(): void;\n');
    await writeFile(
      augmentationPath,
      'declare global { interface Window { cq?: boolean; enabled: true } }\nexport {};\n',
    );
    const augmentationDrifts = spawnSync(
      process.execPath,
      [scriptPath, '--baseline', baselinePath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(augmentationDrifts.status, 1);
    assert.match(augmentationDrifts.stderr, /differs from baseline/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test('fails closed when a declared export target or declaration is absent', async () => {
  const missingTarget = await fixture({ './missing': './dist/missing.js' });
  try {
    await assert.rejects(makeReport(missingTarget), /ENOENT/);
  } finally {
    await rm(missingTarget, { recursive: true, force: true });
  }

  const missingDeclaration = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(missingDeclaration, 'dist/index.js'), 'export {};\n');
    await assert.rejects(makeReport(missingDeclaration), /ENOENT/);
  } finally {
    await rm(missingDeclaration, { recursive: true, force: true });
  }
});

test('rejects export targets that escape the package root', async () => {
  const root = await fixture({ '.': '../outside.js' });
  try {
    await assert.rejects(makeReport(root), /unsafe or non-relative target/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects export targets and declarations that resolve through symlinks outside the package', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'cq-api-report-outside-'));
  try {
    const outsideTarget = path.join(outside, 'index.js');
    await writeFile(outsideTarget, 'export {};\n');
    await symlink(outsideTarget, path.join(root, 'dist/index.js'));
    await assert.rejects(makeReport(root), /resolves outside package root/);

    await rm(path.join(root, 'dist/index.js'));
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    const outsideDeclaration = path.join(outside, 'index.d.ts');
    await writeFile(outsideDeclaration, 'export {};\n');
    await symlink(outsideDeclaration, path.join(root, 'dist/index.d.ts'));
    await assert.rejects(makeReport(root), /resolves outside package root/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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

// Spawns the CLI per assertion; allow headroom on loaded hosts.
test('CLI draft mode marks the report and default mode fails without a baseline', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(path.join(root, 'dist/index.d.ts'), 'export {};\n');
    const draft = spawnSync(process.execPath, [scriptPath, '--draft'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(draft.status, 0, draft.stderr);
    const report = JSON.parse(draft.stdout);
    assert.equal(report.draft, true);
    assert.equal(report.baselineStatus, 'not-established');

    const missing = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /baseline is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

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
