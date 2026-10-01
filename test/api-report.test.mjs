import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeReport, parseArgs } from '../scripts/api-report.mjs';

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

test('reports declared package targets and declaration hashes deterministically', async () => {
  const root = await fixture({ '.': './dist/index.js' });
  try {
    await writeFile(path.join(root, 'dist/index.js'), 'export {};\n');
    await writeFile(
      path.join(root, 'dist/index.d.ts'),
      'export declare function run(name: string): boolean;\nexport interface Options { enabled: boolean }\n',
    );
    const first = await makeReport(root);
    const second = await makeReport(root);
    assert.deepEqual(first, second);
    assert.equal(first.entries[0].specifier, '.');
    assert.equal(first.entries[0].declaration, './dist/index.d.ts');
    assert.match(first.entries[0].declarationSha256, /^[a-f0-9]{64}$/);
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
