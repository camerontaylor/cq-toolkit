// Canonical temporary roots for fixtures. `os.tmpdir()` is a logical path on
// macOS (`/var/folders/...`, where `/var` is a symlink to `/private/var`),
// while the review ownership terminals admit only canonical candidates
// (`realpath(path) === path`). Reach for `realTmpDir` (or `realTmpDirSync`)
// whenever a fixture temp root must already be its own realpath when
// production receives it — a review ownership terminal, a scanner fixture
// root, a driver workspace binding — so fixtures hand production the
// canonical path a real caller would. A root whose spelling production never
// compares (a private log dir, a PATH-only shim directory) may stay with
// plain `mkdtemp`/`mkdtempSync`.
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a fresh temporary directory under `os.tmpdir()` and canonicalise it. */
export async function realTmpDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Sync twin of {@link realTmpDir} for sync fixtures. */
export function realTmpDirSync(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
