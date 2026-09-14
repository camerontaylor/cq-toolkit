// Extracted from scripts/demo-eval-axes.mjs so the vitest suite can cover
// --only selection + the credential gate WITHOUT the script's dist
// dependency (CI runs tests before build). Pure functions only: no
// process.env/argv access inside this module — the script passes both in.

// `--only <substring>` runs just the matching cells (e.g. the single-cell
// compat-wire retry of glm × ai-sdk) — spend discipline for targeted reruns.
// A missing value, or a value matching NO cell, is a loud usage error —
// never a silent full run.
export const EVAL_AXES_PROVIDER_KEYS = { zai: 'ZAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };

export function selectCells(cells, argv) {
  const onlyIndex = argv.indexOf('--only');
  if (onlyIndex === -1) return cells;
  const only = argv[onlyIndex + 1];
  const valid = cells.map((c) => `${c.lane}/${c.model}`);
  if (only === undefined || !cells.some((c) => `${c.lane}/${c.model}`.includes(only))) {
    throw new Error(
      `demo-eval-axes: ${only === undefined ? '--only requires a value' : `no cell matches '${only}'`} — valid cells: ${valid.join(', ')}`,
    );
  }
  return cells.filter((c) => `${c.lane}/${c.model}`.includes(only));
}

// Credential validation runs AFTER cell selection: --only may select
// cells that never contact every provider, so only the providers the
// selected cells actually touch are required. Fails closed on an unmapped
// provider: a provider absent from neededKey would otherwise silently need
// no key and run unauthenticated.
export function requiredKeys(selected, neededKey, env) {
  const unmappedCell = selected.find((c) => neededKey[c.provider] === undefined);
  const missing = [
    ...new Set(
      selected
        .map((c) => neededKey[c.provider])
        .filter((k) => k !== undefined && (env[k] ?? '') === ''),
    ),
  ];
  return { missing, unmapped: unmappedCell === undefined ? null : unmappedCell.provider };
}
