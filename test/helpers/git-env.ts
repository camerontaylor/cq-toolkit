/**
 * Configuration-isolation controls a test runner may export so fixture git
 * calls never read host config (hooksPath, signing, aliases). They select no
 * repository, so the scrub keeps them.
 */
const GIT_CONFIG_ISOLATION_VARS: ReadonlySet<string> = new Set([
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
]);

/**
 * Process environment minus inherited repository-context `GIT_*` variables.
 * Run from a git hook, `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` would
 * override `-C` and point fixture git calls at the outer repository or index.
 * Config-isolation variables are retained so host Git config stays disabled.
 */
export function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && !GIT_CONFIG_ISOLATION_VARS.has(key)) delete env[key];
  return env;
}
