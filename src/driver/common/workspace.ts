import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
