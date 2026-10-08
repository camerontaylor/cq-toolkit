import { spawn } from 'node:child_process';
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
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Global setup runs before collection, so no test deadline exists yet. A
 * wedged tsc must fail the run as evidence instead of blocking Vitest.
 */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** Names that carry credentials; the build needs none of them. */
const CREDENTIAL_NAME = /token|secret|password|passwd|credential|api_?key|private_?key|auth/i;

/**
 * Connection-string names (DATABASE_URL, REDIS_URL, SENTRY_DSN, ...) usually
 * embed a password or key inside the value, so the name filter above misses
 * them; the build needs none of them either.
 */
const CONNECTION_NAME = /(?:^|_)(?:database|db|redis|mongo(?:db)?|amqp|broker|dsn)(?:_|$)/i;

/** A URL whose userinfo carries a password (`scheme://user:pass@host`), whatever the variable is named. */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i;

/**
 * Projects inheriting the root config (`extends: true`) may each run this
 * setup, possibly from separate module instances, but always in the one main
 * process: the in-flight build is shared through globalThis so a run builds
 * at most once.
 */
const BUILD_KEY = Symbol.for('cq-toolkit.vitest.global-build');

/**
 * The parent environment minus credential-bearing variables. Live workflows
 * scope tokens to the live test; the build must not inherit them.
 */
export function scrubbedBuildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        !CREDENTIAL_NAME.test(name) &&
        !CONNECTION_NAME.test(name) &&
        !(value !== undefined && URL_WITH_PASSWORD.test(value)),
    ),
  );
}

/** True only when the caller has declared dist fresh (`CQ_DIST_PREPARED=1`). */
export function distPrepared(env: NodeJS.ProcessEnv): boolean {
  return env['CQ_DIST_PREPARED'] === '1';
}

function build(): Promise<void> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    // `pnpm run build` reaches the compiler through a pnpm process and the tsc
    // shim, so a timeout must kill the whole tree: the build leads its own
    // process group and the group is signalled. pnpm is a .cmd shim on win32,
    // which must be spawned through a shell (no process groups there).
    const child = spawn('pnpm', ['run', 'build'], {
      cwd: ROOT,
      env: scrubbedBuildEnv(process.env),
      detached: !windows,
      shell: windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (!windows && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // the group already exited between the deadline and the signal
      }
    }, BUILD_TIMEOUT_MS);
    const fail = (reason: string): void => {
      // tsc prints its diagnostics on stdout; pnpm's own failure lines go to stderr.
      reject(
        new Error(`Vitest global setup cannot build dist (pnpm run build): ${reason}\n${output}`),
      );
    };
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error.message);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) fail(`timed out after ${String(BUILD_TIMEOUT_MS)}ms; process group killed`);
      else if (code !== 0) fail(signal === null ? `exit ${String(code)}` : `signal ${signal}`);
      else resolve();
    });
  });
}

/**
 * Build the repository before Vitest collects any tests.
 *
 * Vitest runs global setup once per invocation, including watch mode; watch-mode
 * reruns reuse this build and do not rebuild after a source edit.
 */
export default function globalSetup(): Promise<void> {
  if (distPrepared(process.env)) return Promise.resolve();
  const shared = globalThis as typeof globalThis & { [BUILD_KEY]?: Promise<void> };
  shared[BUILD_KEY] ??= build();
  return shared[BUILD_KEY];
}
