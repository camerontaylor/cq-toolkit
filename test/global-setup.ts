import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Build-once global setup: one `pnpm run build` per Vitest invocation, before
// collection, so no test pays a hidden build and every test sees the same dist.
//
// Contract with the narrow-test runner (`pnpm test:narrow`): when
// CQ_DIST_PREPARED is exactly `1`, the caller has already made dist fresh
// (scripts/ratchet-lib.mjs ensureDist) and this setup returns without
// building or checking freshness. Any other value — unset, `0`, ... — builds.
// Keep the name and the exact-`1` semantics stable.

// Tests resolve the repository from their own location, so the build must
// target that tree whatever directory Vitest was launched from.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Compiler output can be megabytes on a red build — never truncate evidence. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Global setup runs before collection, so no test deadline exists yet. A
 * wedged tsc must fail the run as evidence instead of blocking Vitest.
 */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** Names that carry credentials; the build needs none of them. */
const CREDENTIAL_NAME = /token|secret|password|passwd|credential|api_?key|private_?key|auth/i;

/**
 * The parent environment minus credential-bearing variables. Live workflows
 * scope tokens to the live test; the build must not inherit them.
 */
export function scrubbedBuildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_NAME.test(name)));
}

/** True only when the caller has declared dist fresh (`CQ_DIST_PREPARED=1`). */
export function distPrepared(env: NodeJS.ProcessEnv): boolean {
  return env['CQ_DIST_PREPARED'] === '1';
}

/**
 * Build the repository before Vitest collects any tests.
 *
 * Vitest runs global setup once per invocation, including watch mode; watch-mode
 * reruns reuse this build and do not rebuild after a source edit.
 */
export default function globalSetup(): void {
  if (distPrepared(process.env)) return;
  // pnpm is a .cmd shim on win32, which must be spawned through a shell.
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: scrubbedBuildEnv(process.env),
    maxBuffer: MAX_BUFFER,
    timeout: BUILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    shell: process.platform === 'win32',
  });
  if (build.error !== undefined || build.status !== 0) {
    // tsc prints its diagnostics on stdout; pnpm's own failure lines go to stderr.
    throw new Error(
      `Vitest global setup cannot build dist (pnpm run build): ${
        build.error?.message ?? `exit ${String(build.status)}`
      }\n${build.stdout ?? ''}${build.stderr ?? ''}`,
    );
  }
}
