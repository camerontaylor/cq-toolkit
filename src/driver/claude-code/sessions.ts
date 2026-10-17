// Session-sidecar helpers for the Claude Code lane — Phase 1.9 (shared by
// BOTH transports; consolidated verbatim from the former subprocess and
// claude-agent lanes, whose sidecar protocol was already identical).
//
// THE SIDECAR (issue #26, design (b)): the substrate's OWN session id —
// the `--resume`/`Options.resume` handle for the NEXT run on the SAME
// sessionRef — is stored as `<sessionsDir>/<sessionId>.cq-cli-session`:
// a SIDECAR, not a record message (role 'tool' in a session record means A
// TOOL RAN — the handle must not masquerade as one), and NOT in the
// workspace: the workspace is MODEL-VISIBLE — the earlier placement there
// was a tamper vector (the model could read or alter its own resume handle
// through the very tools the policy hands it). Relocated beside the session
// records and keyed by sessionId, the handle is exactly as precise and no
// longer reachable by the model. Both transports read and write the SAME
// file with the SAME id vocabulary, so a session record created by one
// transport resumes honestly on the other (the CLI and SDK drive the same
// substrate session store).
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { SessionRecord, SessionStore } from '../../harness/session.js';

/**
 * The file-name SUFFIX of the substrate-session sidecar — the resume handle
 * for the NEXT run on the SAME sessionRef, stored as
 * `<sessionsDir>/<sessionId>.cq-cli-session`.
 */
export const CLI_SESSION_FILE = '.cq-cli-session';

/** Session-message toolName under which CLI-transport narration is recorded. */
export const CLI_NARRATION_TOOL = 'cli-narration';

/** Session-message toolName under which SDK-transport narration is recorded. */
export const SDK_NARRATION_TOOL = 'agent-narration';

/**
 * The substrate session id recorded by a prior run of THIS session — the
 * resume argument of the current run — read from the store sidecar
 * `<sessionsDir>/<sessionId>.cq-cli-session`. Missing/unreadable →
 * undefined (an honest workspace-only continuation, never a fabricated
 * resume).
 */
export async function readCliSessionId(
  sessionsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(sessionsDir, `${sessionId}${CLI_SESSION_FILE}`), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined; // no sidecar — nothing to resume substrate-side
  }
}

/**
 * Persist the substrate session id a run observed as the NEXT run's resume
 * handle — best-effort: a failed write costs a workspace-only continuation,
 * never this run's verdict. Stored beside the session records, keyed by
 * sessionId (issue #26) — NOT in the model-visible workspace (the tamper
 * vector) — and 0o600 like the records it sits beside (never
 * world-readable). Skipped when the observed id is the one the run resumed
 * from (nothing new to record).
 */
export async function writeCliSessionId(
  store: SessionStore,
  record: SessionRecord,
  observedSessionId: string | undefined,
  resumedFrom: string | undefined,
): Promise<void> {
  if (observedSessionId === undefined || observedSessionId === resumedFrom) return;
  try {
    await writeFile(
      join(store.sessionsDir, `${record.sessionId}${CLI_SESSION_FILE}`),
      `${observedSessionId}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // deliberately swallowed — resume degrades honestly (no resume handle)
  }
}
