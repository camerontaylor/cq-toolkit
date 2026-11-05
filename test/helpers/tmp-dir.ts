// Canonical temporary roots for fixtures. `os.tmpdir()` is a logical path on
// macOS (`/var/folders/...`, where `/var` is a symlink to `/private/var`), while
// the review ownership terminals admit only canonical candidates
// (`realpath(path) === path`). Fixtures must hand production the same canonical
// paths a real caller would, so every temp root goes through this helper.
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a fresh temporary directory under `os.tmpdir()` and canonicalise it. */
export async function realTmpDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}
