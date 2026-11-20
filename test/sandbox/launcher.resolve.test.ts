/**
 * resolveLauncher keeps searching PATH when a candidate passes the X_OK probe
 * but cannot be canonicalised (a realpath failure, e.g. a symlink swapped
 * mid-resolution).  Before the fix the first such candidate ended the search
 * and the launcher resolved to `undefined` although a later entry was fine.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const failRealpathFor = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = Object.assign(
    (p: string, ...rest: unknown[]) => {
      if (failRealpathFor.has(String(p))) throw new Error('ENOENT: simulated realpath failure');
      return (actual.realpathSync as (...a: unknown[]) => string)(p, ...rest);
    },
    { native: actual.realpathSync.native },
  );
  return { ...actual, realpathSync };
});

const { resolveLauncher } = await import('../../src/sandbox/launcher.js');

const dirs: string[] = [];
afterEach(() => {
  failRealpathFor.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function exe(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('resolveLauncher PATH search', () => {
  test('continues to the next PATH entry when realpath fails on an earlier candidate', () => {
    const first = realpathSync(mkdtempSync(join(tmpdir(), 'cq-launch-a-')));
    const second = realpathSync(mkdtempSync(join(tmpdir(), 'cq-launch-b-')));
    dirs.push(first, second);
    const bad = exe(first, 'tool');
    const good = exe(second, 'tool');
    failRealpathFor.add(bad);
    const resolved = resolveLauncher('tool', { PATH: [first, second].join(':') });
    expect(resolved).toBe(good);
  });

  test('is undefined when every candidate fails to canonicalise', () => {
    const only = realpathSync(mkdtempSync(join(tmpdir(), 'cq-launch-c-')));
    dirs.push(only);
    failRealpathFor.add(exe(only, 'tool'));
    expect(resolveLauncher('tool', { PATH: only })).toBeUndefined();
  });
});
