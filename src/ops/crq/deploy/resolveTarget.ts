/** `resolve_target` from `apps/crq-python/ops/deploy-runbook.py`: the merged main SHA a
 * deploy will apply. A tag is not required; the deployable predicate is that the target
 * is a full commit already contained in `refs/remotes/origin/main`. Git is injected and
 * nothing is fetched or switched unless the caller supplies a runner.
 */
export class Refused extends Error {
  override readonly name = 'Refused';
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface ResolveTargetEffects {
  /** `git -C <root> <args…>`. */
  git(args: readonly string[]): Promise<GitResult>;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const MAIN = 'refs/remotes/origin/main';

/** Python `git(root, *args)` with `check=True`: stdout stripped; a failure is a Refused
 * naming the command and the last stderr line (or the exit code). */
async function gitChecked(effects: ResolveTargetEffects, args: readonly string[]): Promise<string> {
  const r = await effects.git(args);
  if (r.code !== 0) {
    const lines = r.stderr
      .trim()
      .split(/\r?\n/)
      .filter((l) => l !== '');
    throw new Refused(`git ${args.join(' ')} failed: ${lines.at(-1) ?? `exit ${String(r.code)}`}`);
  }
  return r.stdout.trim();
}

export async function resolveTarget(
  requested: string | null,
  fetch: boolean,
  effects: ResolveTargetEffects,
): Promise<string> {
  if (fetch) await gitChecked(effects, ['fetch', '--quiet', 'origin', 'main']);
  let target: string;
  if (requested === null) {
    target = await gitChecked(effects, ['rev-parse', '--verify', `${MAIN}^{commit}`]);
  } else {
    if (!SHA_RE.test(requested)) throw new Refused('--target-sha must be a full 40-hex commit SHA');
    target = requested;
  }
  if ((await effects.git(['cat-file', '-e', `${target}^{commit}`])).code !== 0)
    throw new Refused(
      `target ${target} is not a commit in this checkout; fetch or pass a SHA that exists`,
    );
  if ((await effects.git(['merge-base', '--is-ancestor', target, MAIN])).code !== 0)
    throw new Refused(
      `target ${target} is not merged to origin/main; only a merged main SHA is deployable`,
    );
  return target;
}
