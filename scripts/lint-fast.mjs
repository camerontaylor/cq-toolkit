import { lintArgs, ownedFiles, run } from './lib/owned-files.mjs';

try {
  const files = ownedFiles(process.argv.slice(2));
  if (files.length === 0) console.log('lint:fast: only deleted files; nothing to lint');
  else process.exitCode = run('node_modules/oxlint/bin/oxlint', [...lintArgs, ...files]);
} catch (error) {
  console.error(`lint:fast: ${error.message}`);
  process.exitCode = 1;
}
