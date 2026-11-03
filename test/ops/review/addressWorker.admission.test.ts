import { describe, expect, test } from 'vitest';
import { finding, fixture } from './addressWorker.helpers.js';

describe('review.address verified admission fence', () => {
  test('preflight refuses an unverified parent before checks or model dispatch', async () => {
    let reads = 0;
    const f = await fixture(undefined, '', {
      gitHook: (args, run) => {
        if (args.at(-2) === 'rev-parse' && args.at(-1) === 'HEAD' && ++reads === 2)
          return Promise.resolve({ code: 0, stdout: 'f'.repeat(40), stderr: '' });
        return run(args);
      },
    });
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.reason).toBe('unexpected baseline head outside engine');
      expect(f.calls()).toBe(0);
      expect(f.attempts).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  test('cancellation while preparing historical bookkeeping prevents admission after await', async () => {
    const parent = new AbortController();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(undefined, '', {
      parentSignal: parent.signal,
      prepareBookkeeping: async () => {
        enter();
        await held;
      },
    });
    let admitted = false;
    const pending = f.engine.withVerifiedHead!(async () => {
      admitted = true;
    });
    const refused = expect(pending).rejects.toThrow(/parent cancelled/);
    try {
      await entered;
      parent.abort();
      release();
      await refused;
      expect(admitted).toBe(false);
      expect(f.calls()).toBe(0);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.repo.git('diff', '--cached', '--name-only')).toBe('');
    } finally {
      parent.abort();
      release();
      await Promise.allSettled([pending, refused]);
      await f.cleanup();
    }
  });

  test.each(['before', 'during'] as const)(
    'external HEAD movement %s admission refuses',
    async (timing) => {
      const f = await fixture();
      let admitted = false;
      const external = async () => {
        await f.repo.write('README.md', 'external admission movement\n');
        f.repo.commitAll('outside admission engine');
      };
      try {
        await f.engine.withVerifiedHead!(async (head) => {
          expect(head).toBe(f.initial);
        });
        if (timing === 'before') await external();
        await expect(
          f.engine.withVerifiedHead!(async () => {
            admitted = true;
            if (timing === 'during') await external();
          }),
        ).rejects.toThrow(/admission head.*outside engine/);
        expect(admitted).toBe(timing === 'during');
        expect(f.calls()).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('cancellation during admission refuses the result and queued callback', async () => {
    const parent = new AbortController();
    const f = await fixture(undefined, '', { parentSignal: parent.signal });
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let queuedAdmitted = false;
    const first = f.engine.withVerifiedHead!(async () => {
      entered();
      await held;
    });
    const firstRefused = expect(first).rejects.toThrow(/parent cancelled/);
    let queued: Promise<unknown> | undefined;
    try {
      await entry;
      queued = f.engine.withVerifiedHead!(async () => {
        queuedAdmitted = true;
      });
      const queuedRefused = expect(queued).rejects.toThrow(/parent cancelled/);
      parent.abort();
      release();
      await Promise.all([firstRefused, queuedRefused]);
      expect(queuedAdmitted).toBe(false);
      expect(f.calls()).toBe(0);
    } finally {
      parent.abort();
      release();
      await Promise.allSettled([first, ...(queued ? [queued] : [])]);
      await f.cleanup();
    }
  });
});
