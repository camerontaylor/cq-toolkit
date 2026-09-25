// The launch spec of the `cq-harness-mcp` server (W1.4, ADR-0002 Annex
// A.3): `process.execPath` + the MODULE-RELATIVE absolute path of the built
// bin. Never PATH, npx or plan data — the server executes host commands,
// so the enforcer that runs must be exactly the one this package shipped
// (P1: plan data never names an executable, as ADR-0002 §2.5 rules for
// `driver.binary`).
import { fileURLToPath } from 'node:url';

/** How to start the server; the manifest JSON is appended as the one final argument. */
export interface HarnessServerLaunch {
  command: string;
  args: string[];
}

/** The shipped server's launch spec, resolved next to this module (dist/harness/mcp/bin.js). */
export function harnessServerLaunch(): HarnessServerLaunch {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./bin.js', import.meta.url))],
  };
}
