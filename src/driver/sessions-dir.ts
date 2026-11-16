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
// lane at one place without touching config files). It is a REGISTERED CQ_*
// key, so an entry/run snapshot wins when one is supplied (or when a run
// context exists); otherwise the snapshot fallback is one fresh read at CALL
// time, so tests can still set it per invocation. An empty/blank value is
// ignored rather than honored (a blank path must never become the store).
// `XDG_STATE_HOME` is FOREIGN, not a CQ_* key: it reads the run's entry
// snapshot (`currentEntryEnv()`), so an ambient change after entry cannot
// move the store; outside a run the live process value is the fallback.

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { currentCqEnv, currentEntryEnv } from '../config/run-env.js';
import type { CqEnv } from '../config/env.js';

/**
 * The default sessions directory: durable, XDG-respecting, one copy.
 * `cqEnv` is the caller's entry/run snapshot; absent, the enclosing run's
 * snapshot applies, and outside a run one fresh read is the live fallback.
 */
export function defaultSessionsDir(cqEnv?: CqEnv): string {
  const override = (cqEnv ?? currentCqEnv()).values['CQ_SESSIONS_DIR'];
  if (typeof override === 'string' && override.trim() !== '') {
    return override.trim();
  }
  const stateHome = currentEntryEnv()['XDG_STATE_HOME'];
  const base =
    stateHome !== undefined && stateHome.trim() !== '' && isAbsolute(stateHome)
      ? stateHome
      : join(homedir(), '.local', 'state');
  return join(base, 'cq', 'sessions');
}
