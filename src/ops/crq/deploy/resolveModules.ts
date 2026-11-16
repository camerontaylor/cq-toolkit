/**
 * Extraction and resolution of the target revision's ops modules, over
 * injected git/fs/loader seams.
 *
 * Ports `materialize_ops`, `load_module` and `Run.resolve_modules` from
 * `apps/crq-python/ops/deploy-runbook.py`. Inactive and unimported: nothing
 * here runs git, writes a file or loads code; the caller supplies every effect.
 */
import { createHash } from 'node:crypto';

/** Python `Refused`: a precondition failed. */
export class Refused extends Error {
  override name = 'Refused';
}
/** Python `OSError`: what an injected module load throws when unreadable. */
export class OSError extends Error {
  override name = 'OSError';
}

/** The ops modules the deploy takes from the target revision, in extraction order. */
export const TARGET_OPS_MODULES = ['prepare-host.py', 'deploy-controller.py'] as const;
export const OPS_RELPATH = 'apps/crq-python/ops/';

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Refused(message);
}

export interface MaterializeEffects {
  /** `mkdir(mode=0o700, parents=True, exist_ok=True)`. */
  mkdirPrivateAll(dir: string): void;
  /** `git_bytes(root, 'show', '<sha>:<relpath>')`; throws `Refused` when git fails. */
  gitShowBytes(sha: string, relpath: string): Promise<Uint8Array>;
  /** `O_CREAT|O_EXCL|O_WRONLY` at 0600, write, flush, fsync. Throws when the file exists. */
  writeExclusive(path: string, data: Uint8Array): void;
}

/**
 * Python `materialize_ops`: write each named module of `sha` into a private
 * directory outside the checkout and return `{name: sha256}` in name order.
 */
export async function materializeOps(
  effects: MaterializeEffects,
  sha: string,
  names: readonly string[],
  destination: string,
): Promise<Record<string, string>> {
  effects.mkdirPrivateAll(destination);
  const digests: Record<string, string> = {};
  const base = destination.endsWith('/') ? destination : `${destination}/`;
  for (const name of names) {
    const data = await effects.gitShowBytes(sha, OPS_RELPATH + name);
    effects.writeExclusive(base + name, data);
    digests[name] = createHash('sha256').update(data).digest('hex');
  }
  return digests;
}

export interface LoadModuleEffects<M> {
  /**
   * Load the module at `path`. Returns `null` when no loader exists for it
   * (Python `spec is None`); throws {@link OSError} when unreadable.
   */
  loadModule(name: string, path: string): Promise<M | null>;
}

/** Python `load_module`. */
export async function loadModule<M>(
  effects: LoadModuleEffects<M>,
  name: string,
  path: string,
): Promise<M> {
  try {
    const module = await effects.loadModule(name, path);
    if (module === null) throw new Refused(`cannot load ${name} from ${path}`);
    return module;
  } catch (error) {
    if (error instanceof OSError) throw new Refused(`unreadable module ${name}: ${error.message}`);
    throw error;
  }
}

/** What the helper module reports about its `verify_target(…, tag=…)` parameter. */
export type VerifyTargetTag =
  /** The module has no `verify_target`. */
  | 'absent'
  /** `verify_target` has a `tag` parameter with a default. */
  | 'defaulted'
  /** `tag` is missing, or required (no default). */
  | 'required';

export interface ResolveModulesEffects<H, C> extends MaterializeEffects, LoadModuleEffects<H | C> {
  /** `inspect.signature(helper.verify_target).parameters['tag']`, summarised. */
  verifyTargetTag(helper: H): VerifyTargetTag;
}

export interface ResolveModulesResult<H, C> {
  readonly digests: Record<string, string>;
  readonly helper: H;
  readonly controller: C;
}

/**
 * Python `Run.resolve_modules`: materialise the target's `prepare-host.py` and
 * `deploy-controller.py`, load whichever of helper/controller the run does not
 * already hold, and refuse a helper whose `verify_target` still requires a tag.
 */
export async function resolveModules<H, C>(
  effects: ResolveModulesEffects<H, C>,
  target: string,
  opsDir: string,
  current: { readonly helper: H | null; readonly controller: C | null },
): Promise<ResolveModulesResult<H, C>> {
  const digests = await materializeOps(effects, target, TARGET_OPS_MODULES, opsDir);
  const base = opsDir.endsWith('/') ? opsDir : `${opsDir}/`;
  const helper =
    current.helper ??
    ((await loadModule(effects, 'crq_deploy_runbook_helper', `${base}prepare-host.py`)) as H);
  const controller =
    current.controller ??
    ((await loadModule(
      effects,
      'crq_deploy_runbook_controller',
      `${base}deploy-controller.py`,
    )) as C);
  require_(
    effects.verifyTargetTag(helper) !== 'required',
    "the target revision's prepare-host.verify_target still requires an annotated tag, " +
      'so a tagless deploy and its automatic rollback are impossible with it; ' +
      'deploy a target that contains the tagless-helper change first. Nothing has been switched.',
  );
  return { digests, helper, controller };
}
