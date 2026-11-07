#!/usr/bin/env node
// Gate launcher: no raw vitest, no truncation of oversize selections.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isTest } from './lib/affected-tests.mjs';
import { selectRelatedTests } from './lib/related-tests.mjs';

const toPosix = (path) => path.split(sep).join('/');

try {
  const changed = process.argv.slice(2).map((file) => {
    if (isAbsolute(file) || file.startsWith('-'))
      throw new Error('expected repository-relative changed files');
    return toPosix(relative(process.cwd(), resolve(file)));
  });
  if (changed.length === 0) throw new Error('explicit changed files required');
  for (const file of changed) {
    const rel = toPosix(relative(process.cwd(), resolve(file)));
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || file.startsWith('-'))
      throw new Error('expected repository-relative changed files');
  }
  const allTests = ['test', 'lint']
    .flatMap((dir) =>
      readdirSync(dir, { recursive: true }).map((file) => `${dir}/${toPosix(String(file))}`),
    )
    .filter(isTest);
  const selection = selectRelatedTests(changed, allTests);
  if (selection.advisory) {
    console.log(`test:narrow advisory=${JSON.stringify(selection.advisory)}`);
    console.log('test:narrow result="pass" exit=0 files=0 tests=- failed=-');
  } else {
    const run = spawnSync('pnpm', ['test:narrow', ...selection.files], {
      stdio: 'inherit',
      env: { ...process.env, INIT_CWD: process.cwd(), CQ_TEST_NARROW_REPORT: '1' },
    });
    if (run.error || run.signal || run.status === null)
      throw new Error('test:narrow did not complete');
    process.exitCode = run.status;
  }
} catch (error) {
  console.log(`test:narrow result="refused" exit=2 reason=${JSON.stringify(error.message)}`);
  process.exitCode = 2;
}
