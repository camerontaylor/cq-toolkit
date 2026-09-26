/** Type boundary for the standalone JavaScript test-lane helper. */
export const INVENTORY_DOC: string;
export const TEST_EXCLUDE: string[];
export function documentedProcessTestFiles(root: string): string[];
export function allTestFiles(root: string): string[];
export function laneFiles(root: string): { unit: string[]; e2e: string[] };
export function laneArgs(lane: string, root: string): string[];
