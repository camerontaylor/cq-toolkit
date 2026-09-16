// Analyze lane G2 — the family's injected file-store seam and its shipped
// adapter: everything the remediation slice touches on disk (reading a
// sidecar, digesting target files, rewriting remediated sources, publishing
// the report pair) crosses THIS interface, so tests inject in-memory stores
// and never touch a real filesystem. The shipped {@link pathAnalysisFileStore}
// is the lane's only node:fs piece, bound by the registry importers through
// dynamic imports — the ledger lane's registry-bound store pattern
// (src/ops/ledger/store.ts), simplified for this family's needs.
//
// Trust surface, on REAL paths (the captureBaseline containment rule, the
// ledger store's two-stage shape):
//   - The store is created per dispatch around ONE existing root directory.
//     `root` must resolve (realpath — a missing root refuses the store
//     outright), and every read target's REAL path must be a STRICT
//     descendant of the resolved root (never the root itself, never
//     escaping): a target reached THROUGH an intermediate symlink that
//     resolves outside the root is refused, never read or written.
//     Comparing realpath-to-realpath keeps a root reached via a symlinked
//     ancestor (macOS /var → /private/var) a normalization, not a refusal.
//   - Writes are deliberately NOT mkdir -p: the target's parent directory
//     must already exist and resolve inside the root (an intermediate
//     symlink planted under the root fails the parent realpath), so the
//     render op wraps within an existing directory and the apply op rewrites
//     existing sources — this seam cannot create directory trees.
//   - Reads go through the target's REAL path, so a file-level symlink that
//     points outside the root is refused before a byte is returned. Writes
//     land on (realParent + basename); the remediation path only ever writes
//     a file it first read through this same store (read-through-realpath
//     refused the escape before the write), and a time-of-read-to-time-of-
//     write symlink swap remains an accepted residual of the same class the
//     ledger store documents for its own window.
//
// Residual limitations, documented: all fs work is sync under async
// signatures (the ledger store's v1 tradeoff — the touched files are small,
// and the ops are async at the Op boundary regardless); containment is
// per-operation, not atomic across a read→write pair (the accepted TOCTOU
// window above); and the store has no locking — the sidecar contract's
// staleness re-digest, not mutual exclusion, is what keeps concurrent
// remediation honest.
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The injected I/O seam of the analyze remediation slice — the ONE place the
 * family touches files. Tests inject in-memory fakes; production binds
 * {@link pathAnalysisFileStore}. All paths are interpreted relative to the
 * store's root (absolute paths must resolve to strict descendants of it).
 */
export interface AnalyzeFileStore {
  /** Read a file as UTF-8 text. Throws (with a clear message) when the file is missing or escapes the root. */
  readText(path: string): Promise<string>;
  /** Read a file's exact UTF-8 bytes (the byte-exactness rewrites need). Same fault behavior as readText. */
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * Write bytes to a file, creating or truncating it. NEVER creates parent
   * directories: the parent must already exist inside the root, so a wrong
   * path is a fault, not a tree.
   */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** True exactly when the path resolves to an existing directory inside the root. */
  isDirectory(path: string): Promise<boolean>;
}

/** Thrown by {@link pathAnalysisFileStore} operations on any containment or fs fault. */
export class AnalysisStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisStoreError';
  }
}

/**
 * The shipped store: a containment-checked node:fs adapter over ONE existing
 * root directory. See the module header for the full trust surface. The
 * registry importers bind it INPUT-DRIVEN —
 * `(input) => pathAnalysisFileStore(input.dir)` — so the root crosses the
 * plain-JSON op boundary and the same op serves any directory.
 */
export function pathAnalysisFileStore(root: string): AnalyzeFileStore {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (err) {
    throw new AnalysisStoreError(
      `analysis store: root does not resolve — '${root}' does not exist (${messageOf(err)})`,
    );
  }
  if (!statSync(rootReal).isDirectory()) {
    throw new AnalysisStoreError(`analysis store: root is not a directory — '${root}'`);
  }

  /** Stage-A resolve for READS: realpath the target, require a strict descendant of the root. */
  const resolveReadable = (path: string): string => {
    const targetAbs = resolve(root, path);
    let real: string;
    try {
      real = realpathSync(targetAbs);
    } catch (err) {
      throw new AnalysisStoreError(
        `analysis store: '${path}' does not resolve inside root '${root}' (${messageOf(err)})`,
      );
    }
    const fault = strictDescendantFault(rootReal, real);
    if (fault !== null) {
      throw new AnalysisStoreError(
        `${fault} — an intermediate symlink escapes the root; refusing to read it`,
      );
    }
    return real;
  };

  // Every store method is an `async` FUNCTION (not a sync body returning
  // Promise.resolve): a containment fault must surface as a REJECTED
  // promise, never a synchronous throw across the seam, so callers can
  // treat the store uniformly with `await` + try/catch.
  const store: AnalyzeFileStore = {
    readBytes: async (path) => {
      const real = resolveReadable(path);
      try {
        return readFileSync(real);
      } catch (err) {
        throw new AnalysisStoreError(
          `analysis store: could not read '${path}' — ${messageOf(err)}`,
        );
      }
    },
    readText: async (path) => Buffer.from(await store.readBytes(path)).toString('utf8'),
    writeBytes: async (path, bytes) => {
      // No mkdir, ever: the parent must already exist, and its REAL path
      // (stage-B containment) must keep the target a strict descendant of
      // the root — an intermediate symlink planted under the root fails
      // here, before any byte lands.
      const targetAbs = resolve(root, path);
      let realParent: string;
      try {
        realParent = realpathSync(dirname(targetAbs));
      } catch (err) {
        throw new AnalysisStoreError(
          `analysis store: parent directory of '${path}' does not exist — this store never mkdir -p (${messageOf(err)})`,
        );
      }
      const fault = strictDescendantFault(rootReal, join(realParent, basename(targetAbs)));
      if (fault !== null) {
        throw new AnalysisStoreError(
          `${fault} — an intermediate symlink escapes the root; refusing to write it`,
        );
      }
      try {
        writeFileSync(join(realParent, basename(targetAbs)), bytes);
      } catch (err) {
        throw new AnalysisStoreError(
          `analysis store: could not write '${path}' — ${messageOf(err)}`,
        );
      }
    },
    isDirectory: async (path) => {
      try {
        // Unlike file targets, the DIRECTORY check allows the root itself
        // (the render op verifies its own working dir). Escapes still
        // return false, never throw — a non-resolving or escaping path is
        // simply not a usable directory.
        const real = realpathSync(resolve(root, path));
        const rel = relative(rootReal, real);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false;
        return statSync(real).isDirectory();
      } catch {
        return false;
      }
    },
  };
  return store;
}

/**
 * The captureBaseline descent rule, on REAL paths: `candidate` must be a
 * strict descendant of `rootReal` — non-empty relative form (never the root
 * itself), never escaping upward ('..', compared against the separator so a
 * root-child literally named '..foo' stays legal), never absolute. Returns
 * the fault message naming both paths, or null when contained.
 */
function strictDescendantFault(rootReal: string, candidate: string): string | null {
  const rel = relative(rootReal, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `'${candidate}' does not resolve to a strict descendant of root '${rootReal}'`;
  }
  return null;
}

/** Error message of an unknown throwable, for fault messages. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
