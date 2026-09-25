// Executable-owned signal lifecycle. Libraries register cleanup mechanics,
// but only the owning entrypoint changes the host's signal disposition.
const cleanups = new Set<() => (() => void) | undefined>();

/** Register cooperative cleanup and an optional force-kill; dispose when ownership ends. */
export function registerProcessSignalCleanup(prepare: () => (() => void) | undefined): () => void {
  cleanups.add(prepare);
  return () => {
    cleanups.delete(prepare);
  };
}

/**
 * Opt in at executable entrypoints, never at library import time. The signal
 * has already decided termination; this bounded grace executes that decision.
 * Managed MCP children get time to abort their own detached run groups before
 * the final force-kill. Re-raising preserves the ordinary signal exit status.
 */
export function installProcessSignalCleanup(beforeSignal?: () => void): void {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    const force: Array<() => void> = [];
    try {
      beforeSignal?.();
    } finally {
      for (const prepare of cleanups) {
        const kill = prepare();
        if (kill !== undefined) force.push(kill);
      }
      const finish = (): void => {
        for (const kill of force) kill();
        for (const ownedSignal of signals) process.removeListener(ownedSignal, onSignal);
        process.kill(process.pid, signal);
      };
      // Match subprocess DEFAULT_TERM_GRACE_MS. Keep this timer referenced:
      // descendants may survive after all direct children have exited.
      if (force.length > 0) setTimeout(finish, 2_000);
      else finish();
    }
  };
  for (const signal of signals) process.on(signal, onSignal);
}
