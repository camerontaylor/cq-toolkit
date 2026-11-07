import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateScratchRepo } from './generate.js';

describe('generateScratchRepo', () => {
  it('seeds the repo at a relative path without nesting', async () => {
    const parent = mkdtempSync(join(tmpdir(), 't080-'));
    const cwd = process.cwd();
    process.chdir(parent);
    try {
      await generateScratchRepo('rel-repo');
      expect(existsSync(join(parent, 'rel-repo', '.git'))).toBe(true);
      expect(existsSync(join(parent, 'rel-repo', 'rel-repo'))).toBe(false);
      const log = execFileSync('git', ['-C', join(parent, 'rel-repo'), 'log', '--oneline'], {
        encoding: 'utf8',
      });
      expect(log).toContain('seed: scratch fixture repo');
    } finally {
      process.chdir(cwd);
    }
  });
});
