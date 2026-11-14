import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  pythonUnicode16Space,
  pythonUnicode16SpaceRanges,
  pythonUnicode16Word,
  pythonUnicode16WordRanges,
} from '../../../src/policy/crq/pythonUnicode16.js';

const version = spawnSync(
  'python3.14',
  ['-c', 'import unicodedata; print(unicodedata.unidata_version)'],
  { encoding: 'utf8' },
);
const oracleMissing = version.error && (version.error as NodeJS.ErrnoException).code === 'ENOENT';
describe('inactive Python Unicode 16 tables', () => {
  it('handles representative word and whitespace boundaries', () => {
    for (const ch of ['A', '0', '_', 'λ', '²', '𐀀'])
      expect(pythonUnicode16Word(ch.codePointAt(0) ?? -1)).toBe(true);
    for (const code of [-1, 0x301, 0xd800, 0x110000, 0.5, NaN])
      expect(pythonUnicode16Word(code)).toBe(false);
    for (const code of [9, 0x1c, 0x85, 0x2000, 0x2028, 0x3000])
      expect(pythonUnicode16Space(code)).toBe(true);
    for (const code of [-1, 0xfeff, 0x180e, 0x110000, 0.5, NaN])
      expect(pythonUnicode16Space(code)).toBe(false);
  });
  it('exposes ordered inclusive ranges without exposing mutable internal state', () => {
    for (const ranges of [pythonUnicode16WordRanges(), pythonUnicode16SpaceRanges()]) {
      expect(ranges.length % 2).toBe(0);
      let previous = -1;
      for (let i = 0; i < ranges.length; i += 2) {
        const start = ranges[i] ?? -1;
        const end = ranges[i + 1] ?? -1;
        expect(start).toBeGreaterThan(previous);
        expect(end).toBeGreaterThanOrEqual(start);
        previous = end;
      }
    }
    expect(pythonUnicode16WordRanges()).not.toBe(pythonUnicode16WordRanges());
    expect(pythonUnicode16SpaceRanges()).not.toBe(pythonUnicode16SpaceRanges());
  });
  it.skipIf(Boolean(oracleMissing))(
    'matches Python 3.14 Unicode 16 exhaustively and regenerates the same streams',
    () => {
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe('16.0.0');
      const generator = fileURLToPath(
        new URL('../../../scripts/generate-crq-unicode16.py', import.meta.url),
      );
      const generated = spawnSync('python3.14', [generator], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      expect(generated.status).toBe(0);
      const data: unknown = JSON.parse(generated.stdout);
      if (data === null || typeof data !== 'object' || !('word' in data) || !('space' in data))
        throw new Error('invalid generator output');
      if (typeof data.word !== 'string' || typeof data.space !== 'string')
        throw new Error('invalid generator streams');
      const source = readFileSync(
        new URL('../../../src/policy/crq/pythonUnicode16.ts', import.meta.url),
        'utf8',
      );
      expect(source).toContain(`'${data.word}'`);
      expect(source).toContain(`'${data.space}'`);
      const script =
        'import sys,unicodedata; assert unicodedata.unidata_version == "16.0.0"; sys.stdout.buffer.write(bytes((int(chr(i).isalnum() or i == 95) | (int(chr(i).isspace()) << 1)) for i in range(0x110000)))';
      const oracle = spawnSync('python3.14', ['-c', script], { maxBuffer: 2 * 1024 * 1024 });
      expect(oracle.status).toBe(0);
      expect(oracle.stdout.length).toBe(0x110000);
      for (let code = 0; code < 0x110000; code++) {
        const actual =
          Number(pythonUnicode16Word(code)) | (Number(pythonUnicode16Space(code)) << 1);
        if (actual !== oracle.stdout[code])
          throw new Error(`Unicode mismatch at U+${code.toString(16)}`);
      }
    },
  );
});
