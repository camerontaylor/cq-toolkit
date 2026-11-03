// Split provenance: test/api-report.test.mjs was split into test/api-report.<subject>.test.mjs files.
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { makeReport } from '../scripts/api-report.mjs';
import { fixture } from './api-report.helpers.mjs';

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
