// The ONE default sessions directory — session-log preservation plan item 1.1
// (plans/session-log-preservation-plan-20261024.md, toolkit-research).
//
// Every lane's private `defaultSessionsDir()` copy (claude-code cli.ts and
// sdk.ts, acp, ai-sdk) collapsed here, and the default itself moved from the
// tmpfs sibling of the harness temp-workspace root to the DURABLE XDG state
// home: `${XDG_STATE_HOME:-~/.local/state}/cq/sessions`. Rationale (feature
// R2): `$TMPDIR/cq-harness/sessions` was lost at reboot on tmpfs hosts — a
// session store that evaporates is the opposite of preserved evidence.
//
// Callers keep their explicit-config overrides (`this.sessionsDir ??`,
// factory `sessionsDirFor`); this helper is only the shared LAST resort.
// `CQ_SESSIONS_DIR` is the environment escape hatch (ops can point every
// lane at one place without touching config files); it is read at CALL
// time, so tests can set it per invocation, and an empty/blank value is
// ignored rather than honored (a blank path must never become the store).

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The default sessions directory: durable, XDG-respecting, one copy.
 */
export function defaultSessionsDir(): string {
  const override = process.env['CQ_SESSIONS_DIR'];
  if (override !== undefined && override.trim() !== '') {
    return override.trim();
  }
  const stateHome = process.env['XDG_STATE_HOME'];
  const base =
    stateHome !== undefined && stateHome.trim() !== ''
      ? stateHome
      : join(homedir(), '.local', 'state');
  return join(base, 'cq', 'sessions');
}
