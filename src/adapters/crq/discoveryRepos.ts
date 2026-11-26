/**
 * Config -> repositories builder for the tick's push and open-PR discovery.
 * Inactive: it reads nothing but the decoded runner config. Python builds the
 * same two views from `REPOS = repo_registry.parse(CONFIG)` (crq.py:90):
 *
 * - push discovery (`push_current.discover`) walks each non-primary repo whose
 *   `discovery.push` is set, with `quiet = cfg["quiet_minutes"] or
 *   CONFIG["quiet_minutes"]`;
 * - open-PR enrollment runs the primary repo (`crq.enroll`, top-level config,
 *   `runtime_target.DISCOVERY_BRANCHES`) and then each non-primary repo whose
 *   `discovery.pr` is set (`pr_enroll.enroll`).
 *
 * A repo whose flag is off stays in the list with `enabled: false`; the ported
 * passes skip it without any read, as Python's `continue` does.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { DISCOVERY_BRANCHES } from '../../policy/crq/reconcileInventory.js';
import { parseRepos, RepoRegistryError, type RegistryRepo } from '../../policy/crq/repoRegistry.js';
import type { OpenPrRepository } from './openPrDiscoverySource.js';
import type { PushRepository } from './pushDiscoverySource.js';

export interface DiscoveryRepos {
  /** Every parsed non-primary repo, for callers that need rank or scope. */
  readonly registry: readonly RegistryRepo[];
  /** Non-primary repos for `push_current.discover`, in config order. */
  readonly push: readonly PushRepository[];
  /** The primary repo first, then the non-primary repos, for open-PR enrollment. */
  readonly pr: readonly OpenPrRepository[];
}

function configString(config: JsonObject, key: 'repo' | 'clone'): string {
  const value = config.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RepoRegistryError(`config.${key} must be a non-empty string`);
  }
  return key === 'clone' ? value.trim() : value;
}

/** Python `int`/`float` truthiness for the global quiet window; booleans are not numbers. */
function numberOf(value: JsonValue | undefined): number | null {
  if (!(value instanceof JsonNumber)) return null;
  const n = value.kind === 'int' ? Number(value.integer) : value.float;
  return n !== null && Number.isFinite(n) ? n : null;
}

export function buildDiscoveryRepos(config: JsonObject): DiscoveryRepos {
  const registry = parseRepos(config);
  const primary = configString(config, 'repo');
  const globalQuiet = numberOf(config.get('quiet_minutes'));
  const push: PushRepository[] = registry.map((cfg) => {
    // `cfg["quiet_minutes"] or CONFIG["quiet_minutes"]`: only a repo that pushes needs one.
    const quiet = cfg.quietMinutes ?? globalQuiet;
    if (cfg.push && (quiet === null || quiet <= 0)) {
      throw new RepoRegistryError(`repos entry ${cfg.repo}: no usable quiet_minutes in config`);
    }
    return {
      repo: cfg.repo,
      name: cfg.name,
      floor: cfg.floor,
      quietMinutes: quiet ?? 0,
      enabled: cfg.push,
      clone: cfg.clone,
      defaultBranch: cfg.defaultBranch,
    };
  });
  const primaryPr: OpenPrRepository = {
    repo: primary,
    name: primary.split('/').at(-1) ?? primary,
    primary: true,
    enabled: true,
    clone: configString(config, 'clone'),
    defaultBranch: 'main',
    branches: DISCOVERY_BRANCHES,
  };
  const others: OpenPrRepository[] = registry.map((cfg) => ({
    repo: cfg.repo,
    name: cfg.name,
    primary: false,
    enabled: cfg.pr,
    clone: cfg.clone,
    defaultBranch: cfg.defaultBranch,
    branches: [cfg.defaultBranch],
  }));
  return { registry, push, pr: [primaryPr, ...others] };
}
