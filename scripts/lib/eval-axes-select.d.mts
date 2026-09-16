/** Type boundary for the standalone JavaScript selection helper. */
export const EVAL_AXES_PROVIDER_KEYS: { zai: string; deepseek: string };
export function selectCells<T extends { lane: string; model: string }>(
  cells: T[],
  argv: readonly string[],
): T[];
export function requiredKeys(
  selected: readonly { provider: string }[],
  neededKey: Readonly<Record<string, string | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): { missing: string[]; unmapped: string | null };
