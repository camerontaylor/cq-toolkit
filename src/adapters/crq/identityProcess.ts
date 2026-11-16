/**
 * The real process seam for `crq_review_identity`: `subprocess.run(argv, capture_output=True,
 * text=True, input=..., timeout=..., env=...)` over `spawnSync`. A spawn failure maps to a
 * `ProcessLaunchError` (`ENOENT` is Python's `FileNotFoundError`; everything else, including
 * a timeout, is the generic `other`), so the pure layer only ever sees safe reason codes.
 */
import { spawnSync } from 'node:child_process';
import { currentEntryEnv } from '../../config/run-env.js';
import { JsonNumber } from '../../policy/crq/jsonValue.js';
import { ProcessLaunchError, type IdentityDeps } from '../../policy/crq/reviewIdentity.js';

export function nodeIdentityDeps(): IdentityDeps {
  return {
    run(argv, options) {
      const [command, ...args] = argv;
      if (command === undefined) throw new ProcessLaunchError('other', 'empty argv');
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        input: options.inputText ?? undefined,
        timeout: options.timeoutSec * 1000,
        env: options.env === null ? currentEntryEnv() : { ...options.env },
      });
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        throw new ProcessLaunchError(code === 'ENOENT' ? 'missing' : 'other', code ?? 'error');
      }
      return {
        returncode: JsonNumber.int(BigInt(result.status ?? -1)),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    now: () => Date.now() / 1000,
    env: Object.fromEntries(
      Object.entries(currentEntryEnv()).filter((e): e is [string, string] => e[1] !== undefined),
    ),
  };
}
