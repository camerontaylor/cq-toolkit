import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Tests resolve the repository from their own location, so the build must
// target that tree whatever directory Vitest was launched from.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Compiler output can be megabytes on a red build — never truncate evidence. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Build the repository before Vitest collects any tests.
 *
 * Vitest runs global setup once per invocation, including watch mode; watch-mode
 * reruns reuse this build and do not rebuild after a source edit.
 */
export default function globalSetup(): void {
  // npm is a .cmd shim on win32, which must be spawned through a shell.
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: process.platform === 'win32',
    // Global setup runs before collection, so no test deadline exists yet.
    // This generous bound catches a wedged/stalled build as evidence rather
    // than hanging the entire run; I5 requires missing evidence to surface.
    timeout: 600_000,
  });
  if (build.error !== undefined || build.status !== 0) {
    // tsc prints its diagnostics on stdout; npm's own failure lines go to stderr.
    throw new Error(
      `Vitest global setup cannot build dist (npm run build): ${
        build.error?.message ?? `exit ${String(build.status)}`
      }\n${build.stdout ?? ''}${build.stderr ?? ''}`,
    );
  }
}
