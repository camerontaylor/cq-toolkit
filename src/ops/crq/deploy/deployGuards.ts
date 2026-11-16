import { Refused } from './errors.js';
export { Refused };
/** `Hold` (admission marker) and `DeployLock` (host-wide advisory lock) from
 * `apps/crq-python/ops/deploy-runbook.py`. Filesystem and lock primitives are injected;
 * nothing here touches disk, and nothing imports this module yet.
 */

export const MARKER_RELPATH = 'apps/crq-python/state/runner-disabled';
export const LOCK_RELPATH = 'apps/crq-python/state/deploy.lock';

const join = (root: string, rel: string): string => `${root.replace(/\/+$/, '')}/${rel}`;
const dirname = (path: string): string => path.slice(0, path.lastIndexOf('/'));

export interface HoldFs {
  mkdirp(dir: string): Promise<void>;
  /** O_CREAT|O_EXCL write, fsynced; resolves false when the file already exists. */
  createExclusive(path: string, bytes: Uint8Array): Promise<boolean>;
  /** File bytes, or null on any read error (Python `owns` treats OSError as not owned). */
  read(path: string): Promise<Uint8Array | null>;
  unlink(path: string): Promise<void>;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The admission marker, owned by this run's unique bytes. */
export class Hold {
  readonly path: string;
  readonly token: Uint8Array;
  acquired = false;
  constructor(
    root: string,
    private readonly fs: HoldFs,
    /** `<uuid-hex>-<pid>\n`, unique per run. */
    token: string,
  ) {
    this.path = join(root, MARKER_RELPATH);
    this.token = new TextEncoder().encode(token);
  }
  async acquire(): Promise<void> {
    await this.fs.mkdirp(dirname(this.path));
    if (!(await this.fs.createExclusive(this.path, this.token)))
      throw new Refused(
        `admission is already held by ${this.path}; another deploy or a manual hold owns it`,
      );
    this.acquired = true;
  }
  async owns(): Promise<boolean> {
    const bytes = await this.fs.read(this.path);
    return bytes !== null && sameBytes(bytes, this.token);
  }
  async release(): Promise<void> {
    if (!(await this.owns()))
      throw new Refused("cannot release the admission marker: it is not this run's");
    await this.fs.unlink(this.path);
    this.acquired = false;
  }
}

export interface LockHandle {
  release(): Promise<void>;
}
export interface LockFs {
  mkdirp(dir: string): Promise<void>;
  /** Non-blocking exclusive lock (flock LOCK_EX|LOCK_NB) on `path`, creating it if
   * needed. Null when another holder has it. The kernel drops it if the process dies. */
  tryLock(path: string): Promise<LockHandle | null>;
}

/** Held from before the first measurement through the health window and recovery. */
export class DeployLock {
  readonly path: string;
  private handle: LockHandle | null = null;
  constructor(
    root: string,
    private readonly fs: LockFs,
  ) {
    this.path = join(root, LOCK_RELPATH);
  }
  async acquire(): Promise<void> {
    await this.fs.mkdirp(dirname(this.path));
    const handle = await this.fs.tryLock(this.path);
    if (handle === null)
      throw new Refused(
        `another deploy holds the deployment lock ${this.path}; wait for it to finish before starting another`,
      );
    this.handle = handle;
  }
  /** Idempotent. The handle is cleared even when the unlock throws (Python `finally`). */
  async release(): Promise<void> {
    const handle = this.handle;
    if (handle === null) return;
    try {
      await handle.release();
    } finally {
      this.handle = null;
    }
  }
}
