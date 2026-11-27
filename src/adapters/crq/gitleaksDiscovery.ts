/**
 * `shutil.which("gitleaks", path=...)` (Python 3.14, `crq.py:643`) over an explicit `PATH`
 * string. One helper behind the three offline discovery copies (`fileReviewGitleaks`,
 * `repairPreparation`, `authorSnapshotInstall`); differentially pinned by
 * `gitleaks_discovery_vectors.py`. Inactive: no production caller chooses the `PATH`.
 *
 * Python's rule per entry is `os.path.exists(f) and os.access(f, X_OK) and not os.path.isdir(f)`:
 * every filesystem error (ENOENT, ENOTDIR, EACCES, ELOOP, ENAMETOOLONG, an embedded NUL)
 * only means "not this entry", so this helper never throws.
 *
 * Deviations from Python, each pinned by a named test:
 * - the result is absolute (the cwd prefixed to a relative or empty entry, joined
 *   to `gitleaks` with no lexical normalisation, so `link/..` resolves through the symlink as in
 *   Python), where Python returns the relative join; the file named is the same;
 * - `emptyEntries: 'skip'` (`repairPreparation` only) ignores empty entries, where Python
 *   joins `''` to the current directory. Stricter, never more permissive;
 * - an unset `PATH` searches {@link DEFAULT_SEARCH_PATH}, the glibc `CS_PATH` that Python
 *   3.14 reads through `os.confstr` (other libcs may differ).
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';

/** `os.confstr('CS_PATH')` on glibc, what `shutil.which` searches when `PATH` is unset. */
export const DEFAULT_SEARCH_PATH = '/bin:/usr/bin';

export interface GitleaksDiscoveryOptions {
  /**
   * Directory a relative (or, unless skipped, empty) entry is resolved against. A test seam only:
   * no production caller passes it (they all use the process cwd); it lets the differential run
   * without `chdir`. Not a supported production input.
   */
  readonly cwd?: string;
  /** `'cwd'` (Python): an empty entry means the current directory. `'skip'`: ignore it. */
  readonly emptyEntries?: 'cwd' | 'skip';
}

/** The first executable non-directory `gitleaks` on `path`, or `null`. `''` finds nothing. */
export function findGitleaksOnPath(
  path: string | undefined,
  options: GitleaksDiscoveryOptions = {},
): string | null {
  const search = path ?? DEFAULT_SEARCH_PATH;
  if (search === '') return null;
  const cwd = options.cwd ?? process.cwd();
  for (const entry of search.split(delimiter)) {
    if (entry === '' && options.emptyEntries === 'skip') continue;
    // No lexical normalisation: `os.path.join` keeps `link/..` and the kernel then resolves it
    // through the symlink. A relative entry is only prefixed with the cwd.
    const dir = entry === '' ? cwd : isAbsolute(entry) ? entry : `${cwd}/${entry}`;
    const candidate = dir.endsWith('/') ? `${dir}gitleaks` : `${dir}/gitleaks`;
    try {
      const stats = statSync(candidate);
      accessSync(candidate, constants.X_OK);
      if (!stats.isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
