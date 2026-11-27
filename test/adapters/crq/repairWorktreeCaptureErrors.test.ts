/**
 * `spawn` in repairWorktreeCapture.ts maps `spawnSync` failures onto the Python
 * exception types `subprocess.run` raises: a timeout is `TimeoutExpired` (a
 * `SubprocessError`, neither `OSError` nor `RuntimeError`), a missing `git` is
 * `FileNotFoundError` (an `OSError` subclass).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync,
}));

import { untrackedDirectories } from '../../../src/adapters/crq/repairWorktreeCapture.js';
import { isPyError, PyError } from '../../../src/queue-runner/pyErrors.js';

function failWith(code: string, message: string): void {
  spawnSync.mockReturnValue({
    error: Object.assign(new Error(message), { code }),
    status: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
}

function thrownBy(fn: () => unknown): PyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PyError);
    return e as PyError;
  }
  throw new Error('expected a PyError');
}

describe('git spawn failures', () => {
  beforeEach(() => spawnSync.mockReset());

  it('raises TimeoutExpired on a timeout, not RuntimeError or OSError', () => {
    failWith('ETIMEDOUT', 'spawnSync git ETIMEDOUT');
    const error = thrownBy(() => untrackedDirectories('/nowhere'));
    expect(error.kind).toBe('TimeoutExpired');
    expect(isPyError(error, 'RuntimeError')).toBe(false);
    expect(isPyError(error, 'OSError')).toBe(false);
    expect(error.message).toMatch(/^Command '\['git', .*\]' timed out after \d+ seconds$/);
  });

  it('raises FileNotFoundError, an OSError, when git is missing', () => {
    failWith('ENOENT', 'spawnSync git ENOENT');
    const error = thrownBy(() => untrackedDirectories('/nowhere'));
    expect(error.kind).toBe('FileNotFoundError');
    expect(isPyError(error, 'OSError')).toBe(true);
    expect(isPyError(error, 'ValueError')).toBe(false);
  });

  it('keeps any other spawn failure a plain OSError', () => {
    failWith('EACCES', 'spawnSync git EACCES');
    expect(thrownBy(() => untrackedDirectories('/nowhere')).kind).toBe('OSError');
  });
});
