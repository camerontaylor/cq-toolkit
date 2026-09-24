import { spawnSync } from 'node:child_process';

/**
 * Build the repository before Vitest collects any tests.
 *
 * Vitest runs global setup once per invocation, including watch mode; watch-mode
 * reruns reuse this build and do not rebuild after a source edit.
 */
export default function globalSetup(): void {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (build.error !== undefined) {
    throw new Error(
      `Vitest global setup could not run npm run build: ${build.error.message}\n${build.stderr ?? ''}`,
    );
  }
  if (build.status !== 0) {
    throw new Error(
      `Vitest global setup failed: npm run build exited with status ${String(build.status)}\n${build.stderr ?? ''}`,
    );
  }
}
