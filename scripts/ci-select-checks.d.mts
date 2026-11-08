export interface CheckSelection {
  typescript: boolean;
  python: boolean;
}
export function classifyPaths(paths: readonly string[]): CheckSelection;
export function selectChecks(options: {
  event?: string;
  base?: string;
  head?: string;
  cwd?: string;
}): CheckSelection;
