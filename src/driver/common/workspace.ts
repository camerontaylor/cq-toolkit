import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { SessionRecord, SessionStore } from '../../harness/session.js';
import { describeError } from '../error-text.js';
import { DispatchError } from '../errors.js';
import type { WorkspaceBinding } from '../types.js';

/** Validate a caller binding before dispatch and resolve directory aliases. */
export function boundWorkspacePath(workspace: WorkspaceBinding, lane: string): string {
  if (!isAbsolute(workspace.path)) {
    throw new DispatchError(
      'config',
      `${lane}: workspace.path must be absolute, got '${workspace.path}'`,
    );
  }
  try {
    const real = realpathSync(workspace.path);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
    return real;
  } catch (err) {
    throw new DispatchError(
      'config',
      `${lane}: workspace.path '${workspace.path}' does not name an existing directory — ${describeError(err)}`,
    );
  }
}

/**
 * Refuse a sessions directory at or inside a bound workspace (Annex A:
 * the per-session binding file must live outside the model-editable
 * tree). Resolves directory aliases first (`realpathSync` follows
 * symlinks), so a `<workspace>/link -> <outside>` alias is accepted while
 * a `<workspace>/inside` dir — or a symlink to one — is refused. A
 * not-yet-existing sessions dir resolves through its nearest existing
 * ancestor (the store creates the dir at first write), so a refusal lands
 * BEFORE any session file is written. A relative sessions dir resolves
 * against the process cwd — always outside a bound (absolute, existing)
 * workspace in practice, but compared the same way. Throws a structured
 * 'config' DispatchError naming both paths.
 */
export function assertSessionsDirOutsideWorkspace(
  sessionsDir: string,
  boundWorkspace: string,
  lane: string,
): void {
  const realWorkspace = realpathSync(boundWorkspace);
  const realSessions = realpathOfExistingOrNearestAncestor(sessionsDir);
  if (isInsideDir(realSessions, realWorkspace)) {
    throw new DispatchError(
      'config',
      `${lane}: sessionsDir '${sessionsDir}' resolves inside the bound workspace ` +
        `('${realSessions}' is at or under '${realWorkspace}') — the session binding ` +
        `file must live outside the model-editable tree`,
    );
  }
}

/**
 * Resolve `dir`, following symlinks; when it does not yet exist (the store
 * creates it at first write), resolve the nearest existing ancestor and
 * re-append the missing tail — so every EXISTING segment is compared in
 * realpath space and a refusal lands before any session file is written.
 */
function realpathOfExistingOrNearestAncestor(dir: string): string {
  const missing: string[] = [];
  let current = resolve(dir);
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current)
        throw new DispatchError('config', `sessions: cannot resolve '${dir}'`);
      missing.push(relative(parent, current));
      current = parent;
    }
  }
}

/** True when `candidate` is at or under `parent` (both realpathed absolute paths). */
function isInsideDir(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent + '/');
}

/** Resume old records whose workspace may predate realpath normalization. */
export async function resumedRecordOrThrow(
  store: SessionStore,
  sessionRef: string,
  boundWorkspace: string | undefined,
  lane: string,
): Promise<SessionRecord> {
  const record = await store.load(sessionRef);
  if (record === undefined) {
    // A sessionRef naming no stored session is a caller misconfiguration
    // like the other pre-dispatch validation rows — structured 'config'
    // (seam v2 §2.2), never an unclassified lane defect.
    throw new DispatchError(
      'config',
      `${lane}: unknown sessionRef '${sessionRef}' — no recorded session to resume`,
    );
  }
  let recordedWorkspace = record.workspace;
  try {
    recordedWorkspace = realpathSync(recordedWorkspace);
  } catch {
    // A removed workspace still permits unbound resume; retain its recorded identity.
  }
  if (boundWorkspace !== undefined && recordedWorkspace !== boundWorkspace) {
    throw new DispatchError(
      'config',
      `${lane}: workspace '${boundWorkspace}' does not match session '${sessionRef}' (recorded workspace '${record.workspace}')`,
    );
  }
  return record;
}
