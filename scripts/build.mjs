import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enterResourceScope } from './lib/resource-scope.mjs';
import { invalidateBuild, markBuildComplete } from './ratchet-lib.mjs';

try {
  const scoped = await enterResourceScope(fileURLToPath(import.meta.url), []);
  if (scoped) process.exit(scoped.exit);
  invalidateBuild();
  for (const [command, args] of [
    ['tsc', ['-p', 'tsconfig.build.json']],
    [process.execPath, ['scripts/copy-prompt-assets.mjs']],
  ]) {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (status !== 0) process.exit(status);
  }
  markBuildComplete();
} catch (error) {
  console.error(error.message);
  process.exitCode = error.code === 75 ? 75 : 1;
}
