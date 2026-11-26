/**
 * A minimal tar reader (ustar + PAX `x` records) used to compare the members of
 * `untracked.tar` with Python's `tarfile` listing. Reads, never writes.
 */
import { createHash } from 'node:crypto';

export interface TarMember {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly linkname: string;
  readonly mode: number;
  readonly sha256: string | null;
}

function text(block: Buffer, from: number, to: number): string {
  const slice = block.subarray(from, to);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
}

function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = Number(data.subarray(at, space).toString('latin1'));
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    out.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return out;
}

export function readTar(archive: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let pax = new Map<string, string>();
  let at = 0;
  while (at + 512 <= archive.length) {
    const block = archive.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const type = text(block, 156, 157);
    const size = parseInt(text(block, 124, 136), 8);
    const data = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    members.push({
      name: pax.get('path') ?? text(block, 0, 100),
      type,
      size,
      linkname: pax.get('linkpath') ?? text(block, 157, 257),
      mode: parseInt(text(block, 100, 108), 8),
      sha256: type === '0' ? createHash('sha256').update(data).digest('hex') : null,
    });
    pax = new Map();
  }
  return members;
}
