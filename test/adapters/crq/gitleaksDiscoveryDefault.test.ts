/**
 * The unset-PATH search order of `findGitleaksOnPath(undefined)`, observed through the
 * candidates it stats (no real file is read), against the order live Python 3.14 searches
 * when `PATH` is unset (`os.confstr('CS_PATH')`, patched to a marker so the order is visible).
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { oraclePython } from '../../helpers/oraclePython.js';

const statted: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (path: string) => {
      statted.push(path);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
});
const { findGitleaksOnPath } = await import('../../../src/adapters/crq/gitleaksDiscovery.js');

describe('unset PATH search order', () => {
  it('searches /bin before /usr/bin, as Python does', () => {
    expect(findGitleaksOnPath(undefined)).toBeNull();
    expect(statted).toEqual(['/bin/gitleaks', '/usr/bin/gitleaks']);
    const live = spawnSync(
      oraclePython(),
      ['-I', '-c', 'import os;print(os.confstr("CS_PATH").split(os.pathsep))'],
      { encoding: 'utf8' },
    );
    expect(live.stdout.trim()).toBe("['/bin', '/usr/bin']");
  });
});
