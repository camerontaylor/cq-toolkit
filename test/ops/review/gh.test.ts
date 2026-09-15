// E1 round-2 — the gh runner's UTF-8 contract (R2-10): stdout/stderr are
// accumulated as Buffers and decoded ONCE on close, so a multi-byte UTF-8
// character split across two pipe chunks survives intact (chunk-wise
// decoding would replace it with U+FFFD).
//
// The split writer is generated at runtime into a temp dir (not a repo
// fixture) and spawned through the real makeGhRunner seam.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { makeGhRunner } from '../../../src/ops/review/gh.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('makeGhRunner UTF-8 handling', () => {
  test('a multi-byte UTF-8 character split across two pipe chunks survives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gh-utf8-'));
    tempDirs.push(dir);
    const bin = join(dir, 'split-writer.mjs');
    // '日' is U+65E5 = 0xe6 0x97 0xa5. The two writes are separated by a
    // timer so they arrive as two distinct 'data' chunks with the
    // character's bytes straddling the boundary.
    await writeFile(
      bin,
      [
        '#!/usr/bin/env node',
        'import process from "node:process";',
        'process.stdout.write(Buffer.from([0x61, 0xe6, 0x97]));',
        'setTimeout(() => {',
        '  process.stdout.write(Buffer.from([0xa5, 0x62]));',
        '  process.exit(0);',
        '}, 20);',
        '',
      ].join('\n'),
    );
    await chmod(bin, 0o755);
    const run = makeGhRunner({ bin });
    const res = await run([]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('a\u65e5b');
  }, 10_000);
});
