import { describe, expect, test } from 'vitest';
import {
  DeployLock,
  Hold,
  Refused,
  type HoldFs,
  type LockFs,
} from '../../../../src/ops/crq/deploy/deployGuards.js';

function memFs(): HoldFs & { files: Map<string, Uint8Array>; dirs: string[] } {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  return {
    files,
    dirs,
    mkdirp: async (d) => void dirs.push(d),
    createExclusive: async (p, b) => (files.has(p) ? false : (files.set(p, b), true)),
    read: async (p) => files.get(p) ?? null,
    unlink: async (p) => void files.delete(p),
  };
}
const MARKER = '/r/apps/crq-python/state/runner-disabled';

describe('Hold', () => {
  test("acquire creates the parent and the marker with this run's token", async () => {
    const fs = memFs();
    const h = new Hold('/r/', fs, 'tok-1\n');
    await h.acquire();
    expect(fs.dirs).toEqual(['/r/apps/crq-python/state']);
    expect(new TextDecoder().decode(fs.files.get(MARKER))).toBe('tok-1\n');
    expect(h.acquired).toBe(true);
    expect(await h.owns()).toBe(true);
  });
  test('refuses when the marker exists and leaves it and acquired untouched', async () => {
    const fs = memFs();
    fs.files.set(MARKER, new TextEncoder().encode('manual'));
    const h = new Hold('/r', fs, 'tok-1\n');
    await expect(h.acquire()).rejects.toThrow(
      `admission is already held by ${MARKER}; another deploy or a manual hold owns it`,
    );
    expect(h.acquired).toBe(false);
    expect(new TextDecoder().decode(fs.files.get(MARKER))).toBe('manual');
  });
  test('owns is false for foreign bytes (even a prefix) and for an unreadable marker', async () => {
    const fs = memFs();
    const h = new Hold('/r', fs, 'tok-1\n');
    await h.acquire();
    fs.files.set(MARKER, new TextEncoder().encode('tok-1'));
    expect(await h.owns()).toBe(false);
    fs.files.delete(MARKER);
    expect(await h.owns()).toBe(false);
  });
  test('release removes only an owned marker; a foreign one is kept and refused', async () => {
    const fs = memFs();
    const h = new Hold('/r', fs, 'tok-1\n');
    await h.acquire();
    await h.release();
    expect(fs.files.has(MARKER)).toBe(false);
    expect(h.acquired).toBe(false);
    fs.files.set(MARKER, new TextEncoder().encode('someone else'));
    h.acquired = true;
    const err = await h.release().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refused);
    expect((err as Error).message).toBe(
      "cannot release the admission marker: it is not this run's",
    );
    expect(fs.files.has(MARKER)).toBe(true);
    expect(h.acquired).toBe(true);
  });
});

function lockFs(held: boolean) {
  const log: string[] = [];
  const fs: LockFs = {
    mkdirp: async (d) => void log.push(`mkdir ${d}`),
    tryLock: async (p) =>
      held ? null : (log.push(`lock ${p}`), { release: async () => void log.push('unlock') }),
  };
  return { fs, log };
}
describe('DeployLock', () => {
  test('acquires the state lock file and releases once, idempotently', async () => {
    const { fs, log } = lockFs(false);
    const l = new DeployLock('/r', fs);
    await l.acquire();
    await l.release();
    await l.release();
    expect(log).toEqual([
      'mkdir /r/apps/crq-python/state',
      'lock /r/apps/crq-python/state/deploy.lock',
      'unlock',
    ]);
  });
  test('refuses when another deploy holds it, and release is then a no-op', async () => {
    const { fs, log } = lockFs(true);
    const l = new DeployLock('/r', fs);
    await expect(l.acquire()).rejects.toThrow(
      'another deploy holds the deployment lock /r/apps/crq-python/state/deploy.lock; wait for it to finish before starting another',
    );
    await l.release();
    expect(log).not.toContain('unlock');
  });
  test('a throwing unlock still clears the handle', async () => {
    let calls = 0;
    const fs: LockFs = {
      mkdirp: async () => {},
      tryLock: async () => ({
        release: async () => {
          calls++;
          throw new Error('boom');
        },
      }),
    };
    const l = new DeployLock('/r', fs);
    await l.acquire();
    await expect(l.release()).rejects.toThrow('boom');
    await l.release();
    expect(calls).toBe(1);
  });
});
