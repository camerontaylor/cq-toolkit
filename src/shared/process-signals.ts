// Executable-owned signal lifecycle. Libraries register cleanup mechanics,
// but only the owning entrypoint changes the host's signal disposition.
const cleanups = new Set<() => (() => void) | undefined>();
let cleanupStarted = false;

/** Once stopping, retain owned groups until the final sweep, even after leaders exit. */
export function processSignalCleanupStarted(): boolean {
  return cleanupStarted;
}

/** Register cooperative cleanup and an optional force-kill; dispose when ownership ends. */
export function registerProcessSignalCleanup(prepare: () => (() => void) | undefined): () => void {
  cleanups.add(prepare);
  return () => {
    if (!cleanupStarted) cleanups.delete(prepare);
  };
}

/** Begin cleanup for current ownership and snapshot its final force-kill operations. */
export function prepareProcessSignalCleanup(): Array<() => void> {
  cleanupStarted = true;
  const force: Array<() => void> = [];
  for (const prepare of cleanups) {
    const kill = prepare();
    if (kill !== undefined) force.push(kill);
  }
  return force;
}
