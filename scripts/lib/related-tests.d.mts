/** Type boundary for the bounded per-fix mapping. */
export function selectRelatedTests(
  changed: readonly string[],
  allTests: readonly string[],
): {
  files: string[];
  advisory: string | undefined;
};
