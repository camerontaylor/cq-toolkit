import { lintArgs, ownedFiles, run } from './lib/owned-files.mjs';

let lintStatus = 0;

try {
  const files = ownedFiles(process.argv.slice(2));
  if (files.length === 0) console.log('fix: only deleted files; no files to rewrite');
  else {
    // --fix includes safe fixes only. Suggestions and dangerous fixes are
    // deliberately excluded; formatting receives the exact same argv list.
    const lint = run('node_modules/oxlint/bin/oxlint', [...lintArgs, '--fix', ...files]);
    lintStatus = lint;
    if (lint > 1) throw new Error(`Oxlint exited ${lint}`);
    const format = run('node_modules/oxfmt/bin/oxfmt', files);
    if (format !== 0) throw new Error(`Oxfmt exited ${format}`);
  }
  // A dependent outside the owned set can break: always check the package.
  process.exitCode = run('scripts/ratchet-typecheck.mjs', []) || lintStatus;
} catch (error) {
  console.error(`fix: ${error.message}`);
  process.exitCode = 1;
}
