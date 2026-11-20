/**
 * `client_health.checkout_sha(root)`: the runner checkout's HEAD commit, read straight from
 * Git metadata (no `git` process) so it works for linked worktrees and packed refs. Any
 * filesystem or decode failure, and any value that is not 40 lowercase hex digits, is null.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** `Path.resolve()`: the real path when it exists, else the lexical absolute path. */
function resolvePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** `Path.read_text()`: strict UTF-8, so a bad byte is Python's `UnicodeDecodeError` (a `ValueError`). */
function readText(path: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Python `str.strip()` over the ASCII-and-Unicode whitespace the checkout files can hold. */
const strip = (text: string): string => text.trim();

export function checkoutSha(root: string): string | null {
  try {
    const top = resolvePath(root);
    let git = join(top, '.git');
    if (isFile(git)) {
      const pointer = strip(readText(git));
      const target = pointer.startsWith('gitdir: ') ? pointer.slice('gitdir: '.length) : pointer;
      git = resolvePath(resolve(top, target));
    }
    let head: string | null = strip(readText(join(git, 'HEAD')));
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      const commonFile = join(git, 'commondir');
      const common = existsSync(commonFile)
        ? resolvePath(resolve(git, strip(readText(commonFile))))
        : git;
      head = null;
      for (const directory of [git, common]) {
        const path = resolve(directory, ref);
        if (isFile(path)) {
          head = strip(readText(path));
          break;
        }
      }
      const packed = join(common, 'packed-refs');
      if (head === null && existsSync(packed)) {
        for (const line of readText(packed).split('\n')) {
          const fields = line.split(/\s+/).filter((field) => field !== '');
          if (fields.length === 2 && fields[1] === ref) {
            head = fields[0] ?? null;
            break;
          }
        }
      }
    }
    return head !== null && /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}
