/** Type boundary for the standalone JavaScript selection helper. */
export const NON_IMPORT_MAP: readonly (readonly [RegExp, readonly RegExp[]])[];
export const INERT: readonly RegExp[];
export function isTest(path: string): boolean;
export function selectAffected(input: {
  changed: readonly string[];
  allTests: readonly string[];
  related: readonly string[] | null;
  missing?: readonly string[];
}): { files: string[]; fallback: boolean; reason: string };
