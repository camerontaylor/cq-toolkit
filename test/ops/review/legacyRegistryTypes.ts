/** In-memory test fixture shape; production no longer stores shared maps. */
export interface WorktreeRegistryEntry {
  path: string;
  branch: string;
  createdAt: number;
}
export type RegistryMap = Record<string, WorktreeRegistryEntry>;
