/**
 * File-backed effects for the fix-PR backlog refresh (repair_tick.py:595-615).
 * Inactive: nothing imports this outside tests. `gh pr list` stays injected
 * (the forge window and gh transport are not owned here).
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type FixPrBacklogDoc, type FixPrBacklogEffects } from '../../queue-runner/fixPrBacklog.js';
import { atomicJsonText } from '../../policy/crq/pythonJson.js';
import { atomicWrite } from './atomic.js';

export interface FileFixPrBacklogInput {
  readonly stateRoot: string;
  /** `gh_json(['pr','list','--repo',REPO,'--state','open','--limit','1000','--json','headRefName'])`. */
  readonly listOpenPrs: () => Promise<unknown>;
  readonly nowMs?: () => number;
}

/** `STATE/repair/fix-pr-backlog.json`. */
export const FIX_PR_BACKLOG_FILE = join('repair', 'fix-pr-backlog.json');

export function fileFixPrBacklogEffects(input: FileFixPrBacklogInput): FixPrBacklogEffects {
  const path = join(input.stateRoot, FIX_PR_BACKLOG_FILE);
  return {
    listOpenPrs: input.listOpenPrs,
    async readEvents() {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(input.stateRoot, 'events.jsonl'));
      } catch {
        return null; // OSError: no events, limit 0
      }
      // Python's strict utf-8 decode raises (not OSError), failing the refresh.
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
    async writeBacklog(doc: FixPrBacklogDoc) {
      await mkdir(join(input.stateRoot, 'repair'), { recursive: true });
      await atomicWrite(path, atomicJsonText(doc));
    },
    nowMs: input.nowMs ?? (() => Date.now()),
  };
}
