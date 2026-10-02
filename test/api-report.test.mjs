import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
});

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
