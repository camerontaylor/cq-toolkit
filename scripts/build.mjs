import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enterResourceScope } from './lib/resource-scope.mjs';
import { invalidateBuild, markBuildComplete } from './ratchet-lib.mjs';

try {
  const scoped = await enterResourceScope(fileURLToPath(import.meta.url), []);
  if (scoped) process.exit(scoped.exit);
  invalidateBuild();
  // A signal can land after a child exits 0 but before its 'exit' event runs;
  // child.kill() is then a no-op and the loop would carry on. Record it.
  let interrupted = null;
  for (const [command, args] of [
    ['tsc', ['-p', 'tsconfig.build.json']],
    [process.execPath, ['scripts/copy-prompt-assets.mjs']],
    [process.execPath, ['scripts/emit-queue-runner-capabilities.mjs']],
  ]) {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.once(signal, () => {
        interrupted ??= signal;
        child.kill(signal);
      });
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (status !== 0) process.exit(status);
    if (interrupted) process.exit(1);
  }
  markBuildComplete();
} catch (error) {
  console.error(error.message);
  process.exitCode = error.code === 75 ? 75 : 1;
}
