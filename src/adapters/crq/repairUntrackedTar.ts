/**
 * The `untracked.tar` of `crq_repair.retain.retain`
 * (apps/crq-python/crq_repair/retain.py:93-100):
 * `tarfile.open(path, 'w', dereference=False)` plus
 * `archive.add(path, arcname=name, recursive=False)` per untracked name.
 *
 * A minimal POSIX ustar writer with PAX records for names the ustar fields
 * cannot hold. Entry NAMES, TYPES, SIZES, MODES, LINK TARGETS and CONTENT match
 * Python's archive; header bytes are not byte-identical (Python adds a PAX
 * `mtime` record carrying the float mtime and fills `uname`/`gname`), so the
 * archive digest, and with it the `retained-<token>` directory name, differs
 * from Python's for the same tree. The digest is self-consistent: it is the
 * SHA-256 of these exact bytes and `cleanup_harvested` only recomputes it.
 *
 * Python semantics kept: a regular file with `st_nlink > 1` seen before under
 * another name becomes a hard-link entry (no data); symlinks are stored, never
 * followed; any other file type raises `UnsupportedUntracked`.
 */
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import { PyError } from '../../queue-runner/pyErrors.js';

const BLOCK = 512;
/** `tarfile.RECORDSIZE` (`BLOCKSIZE * 20`): the archive is zero-padded to it. */
const RECORD = 10240;

function field(value: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  out.write(value, 0, length, 'latin1');
  return out;
}

function octal(value: number, length: number): Buffer {
  return field(value.toString(8).padStart(length - 1, '0') + '\0', length);
}

function header(
  name: string,
  mode: number,
  uid: number,
  gid: number,
  size: number,
  mtime: number,
  type: string,
  linkname: string,
): Buffer {
  const block = Buffer.alloc(BLOCK);
  const parts: [number, Buffer][] = [
    [0, field(name, 100)],
    [100, octal(mode, 8)],
    [108, octal(uid, 8)],
    [116, octal(gid, 8)],
    [124, octal(size, 12)],
    [136, octal(mtime, 12)],
    [156, field(type, 1)],
    [157, field(linkname, 100)],
    [257, field('ustar\0', 6)],
    [263, field('00', 2)],
  ];
  for (const [offset, bytes] of parts) bytes.copy(block, offset);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  octal(sum, 7).copy(block, 148);
  block[155] = 0x20;
  return block;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
}

/** One PAX record: `"<len> <key>=<value>\n"`, `len` counting itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, 'utf8');
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return Buffer.concat([Buffer.from(String(length)), body]);
}

const ASCII = /^[^\u0080-\u{10ffff}]*$/u;

function entry(
  name: string,
  linkname: string,
  type: string,
  mode: number,
  uid: number,
  gid: number,
  mtime: number,
  data: Buffer,
): Buffer {
  const records: Buffer[] = [];
  if (name.length > 100 || !ASCII.test(name)) records.push(paxRecord('path', name));
  if (linkname.length > 100 || !ASCII.test(linkname)) records.push(paxRecord('linkpath', linkname));
  const chunks: Buffer[] = [];
  if (records.length > 0) {
    const pax = Buffer.concat(records);
    chunks.push(header('././@PaxHeader', 0o644, 0, 0, pax.length, 0, 'x', ''), padded(pax));
  }
  chunks.push(
    header(name.slice(0, 100), mode, uid, gid, data.length, mtime, type, linkname.slice(0, 100)),
    padded(data),
  );
  return Buffer.concat(chunks);
}

/**
 * Archive `names` (relative to `wt`) in order. Throws `UnsupportedUntracked`
 * for the first entry that is neither a regular file nor a symlink, before
 * anything is written, as Python's partial archive is discarded with its
 * capture directory.
 */
export function untrackedTar(wt: string, names: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  const inodes = new Map<string, string>();
  for (const name of names) {
    const path = join(wt, name);
    const stat = lstatSync(path);
    const mode = stat.mode & 0o7777;
    const mtime = Math.floor(stat.mtimeMs / 1000);
    if (stat.isSymbolicLink()) {
      chunks.push(
        entry(name, readlinkSync(path), '2', mode, stat.uid, stat.gid, mtime, Buffer.alloc(0)),
      );
    } else if (stat.isFile()) {
      const inode = `${stat.dev}:${stat.ino}`;
      const first = stat.nlink > 1 ? inodes.get(inode) : undefined;
      if (first !== undefined && first !== name) {
        chunks.push(entry(name, first, '1', mode, stat.uid, stat.gid, mtime, Buffer.alloc(0)));
      } else {
        if (stat.nlink > 1) inodes.set(inode, name);
        chunks.push(entry(name, '', '0', mode, stat.uid, stat.gid, mtime, readFileSync(path)));
      }
    } else {
      throw new PyError(
        'UnsupportedUntracked',
        'unsupported untracked file type; worktree retained',
      );
    }
  }
  const body = Buffer.concat([...chunks, Buffer.alloc(BLOCK * 2)]);
  const rest = body.length % RECORD;
  return rest === 0 ? body : Buffer.concat([body, Buffer.alloc(RECORD - rest)]);
}
