import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface LegacyReviewHint {
  path: string;
  branch: string;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Read only the requested key; old maps remain untouched and are never authority. */
export async function readLegacyReviewHint(
  sources: readonly string[],
  pr: number,
): Promise<LegacyReviewHint | undefined> {
  let selected: LegacyReviewHint | undefined;
  let selectedCanonical: string | undefined;
  const seen = new Set<string>();
  for (const path of sources) {
    const source = resolve(path);
    const canonicalSource = await canonicalPath(source);
    if (seen.has(canonicalSource)) continue;
    seen.add(canonicalSource);
    let file;
    try {
      file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1_048_576)
        throw new Error(`legacy review registry invalid or oversized: ${source}`);
      const bytes = Buffer.alloc(1_048_577);
      let length = 0;
      while (length < bytes.length) {
        const part = await file.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (length > 1_048_576) throw new Error(`legacy review registry oversized: ${source}`);
      let map: unknown;
      try {
        map = JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown;
      } catch (cause) {
        throw new Error(`legacy review registry corrupt: ${source}`, { cause });
      }
      if (!map || typeof map !== 'object' || Array.isArray(map))
        throw new Error(`legacy review registry is not an object: ${source}`);
      if (!Object.hasOwn(map, String(pr))) continue;
      const hint = (map as Record<string, unknown>)[String(pr)];
      if (
        !hint ||
        typeof hint !== 'object' ||
        Array.isArray(hint) ||
        typeof (hint as LegacyReviewHint).path !== 'string' ||
        !isAbsolute((hint as LegacyReviewHint).path) ||
        typeof (hint as LegacyReviewHint).branch !== 'string' ||
        !(hint as LegacyReviewHint).branch
      )
        throw new Error(`legacy review registry invalid entry for PR ${pr}: ${source}`);
      const candidate = hint as LegacyReviewHint;
      const canonical = await canonicalPath(candidate.path);
      if (selectedCanonical && canonical !== selectedCanonical)
        throw new Error(`conflicting legacy review registry entry for PR ${pr}: ${source}`);
      selected = { path: candidate.path, branch: candidate.branch };
      selectedCanonical = canonical;
    } finally {
      await file.close();
    }
  }
  return selected;
}
