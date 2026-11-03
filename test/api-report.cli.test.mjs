// Split provenance: test/api-report.test.mjs was split into test/api-report.<subject>.test.mjs files.
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { makeReport, parseArgs } from '../scripts/api-report.mjs';
import { fixture } from './api-report.helpers.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/api-report.mjs', import.meta.url));

test('draft mode is explicit and default mode remains baseline comparison', () => {
  assert.equal(parseArgs(['--draft']).draft, true);
  assert.equal(parseArgs([]).draft, false);
  assert.throws(() => parseArgs(['--invented']), /unknown argument/);
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
