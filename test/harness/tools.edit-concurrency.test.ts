// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the F1 concurrent-edit and
// admission-ordering cases and carries the hoisted node:fs/promises gate mock
// verbatim. It re-declares the `F1 edit correctness` describe wrapper so every
// moved case keeps its original vitest title path; the case bodies are
// byte-identical.
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi, afterEach } from 'vitest';
import type { PathLike } from 'node:fs';

// The hoisted fs gate never leaks across tests (file-level, covers every describe).
afterEach(() => {
  gateRealpath(undefined);
  releaseWriteFileHold();
});

// realpath gate for admission-order tests: vi.mock is HOISTED above the
// imports, so these variables are initialized by the factory (which runs at
// mock-install time); when the gate is unset, realpath passes straight
// through to the ORIGINAL captured below — never through the mock itself.
const {
  gateRealpath,
  gatedRealpath,
  setOriginalRealpath,
  armWriteFileHold,
  releaseWriteFileHold,
  gatedWriteFile,
  setOriginalWriteFile,
} = vi.hoisted(() => {
  const state: {
    gate?: ((real: () => Promise<string>) => Promise<string>) | undefined;
    original?: (path: PathLike) => Promise<string>;
    writeHold?:
      | {
          suffix: string;
          entered: () => void;
          enteredPromise: Promise<void>;
          release: () => void;
          releasePromise: Promise<void>;
        }
      | undefined;
    writeHoldRelease?: (() => void) | undefined;
    originalWriteFile?:
      | ((
          path: PathLike,
          data: string | Uint8Array,
          options?: { encoding?: string } | string,
        ) => Promise<void>)
      | undefined;
  } = {};
  const gatedRealpath = async (path: PathLike): Promise<string> => {
    const real = () => {
      const original = state.original;
      if (original === undefined) throw new Error('original realpath not captured');
      return original(path);
    };
    return state.gate === undefined ? real() : state.gate(real);
  };
  const gatedWriteFile = async (
    path: PathLike,
    data: string | Uint8Array,
    options?: { encoding?: string } | string,
  ): Promise<void> => {
    const original = state.originalWriteFile;
    if (original === undefined) throw new Error('original writeFile not captured');
    const hold = state.writeHold;
    if (hold === undefined || !String(path).endsWith(hold.suffix)) {
      return original(path, data, options);
    }
    hold.entered();
    await hold.releasePromise;
    return original(path, data, options);
  };
  return {
    gatedRealpath,
    gateRealpath: (gate: ((real: () => Promise<string>) => Promise<string>) | undefined): void => {
      state.gate = gate;
    },
    setOriginalRealpath: (original: (path: PathLike) => Promise<string>): void => {
      state.original = original;
    },
    gatedWriteFile,
    setOriginalWriteFile: (
      original: (
        file: PathLike,
        data: string | Uint8Array,
        options?: { encoding?: string; mode?: number; flag?: string } | string,
      ) => Promise<void>,
    ): void => {
      state.originalWriteFile = original as (
        path: PathLike,
        data: string | Uint8Array,
        options?: { encoding?: string } | string,
      ) => Promise<void>;
    },
    armWriteFileHold: (suffix: string): Promise<void> => {
      let enteredResolve!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      let releaseResolve!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      state.writeHold = {
        suffix,
        entered: enteredResolve,
        enteredPromise,
        release: releaseResolve,
        releasePromise,
      };
      state.writeHoldRelease = releaseResolve;
      return enteredPromise;
    },
    releaseWriteFileHold: (): void => {
      state.writeHoldRelease?.();
      state.writeHold = undefined;
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  setOriginalRealpath(actual.realpath);
  setOriginalWriteFile(actual.writeFile as Parameters<typeof setOriginalWriteFile>[0]);
  return {
    ...actual,
    realpath: (path: PathLike): Promise<string> => gatedRealpath(path),
    writeFile: (
      path: PathLike,
      data: string | Uint8Array,
      options?: { encoding?: string } | string,
    ): Promise<void> => gatedWriteFile(path, data, options),
  };
});
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { defaultTools, withScratch } from './tools.helpers.js';

describe('F1 edit correctness', () => {
  test('a SYMLINKED WORKSPACE ROOT itself: TWO concurrent ordered edits through buildTools(aliasRoot)', async () => {
    await withScratch(async (scratchDir) => {
      const realRoot = join(scratchDir, 'real-root');
      const aliasRoot = join(scratchDir, 'alias-root');
      await mkdir(realRoot, { recursive: true });
      await symlink(realRoot, aliasRoot);
      await writeFile(join(realRoot, 't.txt'), 'a\n', 'utf8');
      // ONE alias buildTools call: its prior-read ledger is per buildTools,
      // so the read and both edits come from the SAME instance.
      const toolsAlias = buildTools(defaultHarnessConfig, aliasRoot);
      const editAlias = toolsAlias.find((c) => c.name === 'edit');
      const readAlias = toolsAlias.find((c) => c.name === 'read');
      if (editAlias === undefined || readAlias === undefined) throw new Error('missing tools');
      await readAlias.execute({ path: 't.txt' });
      const [first, second] = await Promise.all([
        editAlias.execute({ file_path: 't.txt', old_string: 'a', new_string: 'b' }),
        editAlias.execute({ file_path: 't.txt', old_string: 'b', new_string: 'c' }),
      ]);
      expect(first.ok, first.ok ? '' : first.denial.reason).toBe(true);
      expect(second.ok, second.ok ? '' : second.denial.reason).toBe(true);
      await expect(readFile(join(realRoot, 't.txt'), 'utf8')).resolves.toBe('c\n');
    });
  });

  test('unrelated-file BODIES remain independent: a held a.txt write does not block b.txt settling', async () => {
    await withScratch(async (scratchDir) => {
      const a = join(scratchDir, 'a.txt');
      const b = join(scratchDir, 'b.txt');
      await writeFile(a, 'a\n', 'utf8');
      await writeFile(b, 'b\n', 'utf8');
      const tools = defaultTools(scratchDir);
      await tools.read.execute({ path: 'a.txt' });
      await tools.read.execute({ path: 'b.txt' });

      // Hold a.txt's WRITE (inside its body, after the preflight): b.txt's
      // edit must SETTLE while a's body is still in flight — body
      // independence, which preflight-level delays cannot prove.
      const holdEntered = armWriteFileHold('a.txt');
      const editA = tools.edit
        .execute({ file_path: 'a.txt', old_string: 'a', new_string: 'x' })
        .finally(() => {
          releaseWriteFileHold();
        });
      await holdEntered;
      const editB = await tools.edit.execute({
        file_path: 'b.txt',
        old_string: 'b',
        new_string: 'y',
      });
      // b settles WHILE a's body write is still held:
      expect(editB.ok, editB.ok ? '' : editB.denial.reason).toBe(true);
      await expect(readFile(b, 'utf8')).resolves.toBe('y\n');
      // Release a; it completes normally.
      releaseWriteFileHold();
      const settledA = await editA;
      expect(settledA.ok, settledA.ok ? '' : settledA.denial.reason).toBe(true);
      await expect(readFile(a, 'utf8')).resolves.toBe('x\n');
    });
  });

  describe('F1 admission ordering (macOS concurrent-edit race fix)', () => {
    test('arrival order survives async preflight: the second call cannot start its read before the first is admitted', async () => {
      await withScratch(async (scratchDir) => {
        const file = join(scratchDir, 'serial.txt');
        await writeFile(file, 'a\n', 'utf8');
        const tools = defaultTools(scratchDir);
        await tools.read.execute({ path: 'serial.txt' });

        // Deterministic gate: the FIRST caller's realpath is HELD. A deferred
        // signalled by the mock itself records when the first caller entered
        // the held realpath; the second caller is started only after that.
        let firstEntered!: () => void;
        const firstEnteredPromise = new Promise<void>((resolve) => {
          firstEntered = resolve;
        });
        let releaseFirst!: () => void;
        const firstCanResolve = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let probeCalls = 0;
        gateRealpath(async (real) => {
          probeCalls++;
          const result = real();
          if (probeCalls === 1) {
            firstEntered();
            await firstCanResolve;
          }
          return result;
        });

        const first = tools.edit.execute({
          file_path: 'serial.txt',
          old_string: 'a',
          new_string: 'b',
        });
        // The first caller is now HELD inside its realpath.
        await firstEnteredPromise;
        const second = tools.edit.execute({
          file_path: 'serial.txt',
          old_string: 'b',
          new_string: 'c',
        });
        // Drain microtasks, then assert the second caller has NOT entered its
        // realpath (ordered admission holds it behind the first).
        await new Promise((resolve) => setTimeout(resolve, 0));
        const probesWhileHeld = probeCalls;
        // With ordered admission the second's preflight cannot begin while
        // the first holds the admission turn.
        try {
          expect(probesWhileHeld).toBe(1);
        } finally {
          releaseFirst();
          gateRealpath(undefined);
        }

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.ok, firstResult.ok ? '' : firstResult.denial.reason).toBe(true);
        expect(secondResult.ok, secondResult.ok ? '' : secondResult.denial.reason).toBe(true);
        await expect(readFile(file, 'utf8')).resolves.toBe('c\n');
      });
    });

    test('mixed descendant aliases serialize edits to one canonical file in arrival order', async () => {
      await withScratch(async (scratchDir) => {
        // A descendant alias INSIDE the workspace: `alias` → `real`. Two calls
        // addressing the SAME canonical file through DIFFERENT aliases must
        // serialize (the queue re-keys to the canonical path).
        const workspace = join(scratchDir, 'ws');
        await mkdir(join(workspace, 'real'), { recursive: true });
        await symlink(join(workspace, 'real'), join(workspace, 'alias'));
        const tools = buildTools(defaultHarnessConfig, workspace);
        const byName = (name: 'read' | 'edit') => {
          const tool = tools.find((candidate) => candidate.name === name);
          if (tool === undefined) throw new Error(`missing ${name}`);
          return tool;
        };
        const read = byName('read');
        const edit = byName('edit');

        // Create and read through the real path.
        await writeFile(join(workspace, 'real', 't.txt'), 'a\n', 'utf8');
        await read.execute({ path: 'real/t.txt' });

        // Edit via the alias FIRST (first admission turn), then
        // via the real path. Both must succeed in arrival order: the canonical
        // re-key must not let the second bypass the first.
        const [viaAlias, viaReal] = await Promise.all([
          edit.execute({ file_path: 'alias/t.txt', old_string: 'a', new_string: 'b' }),
          edit.execute({ file_path: 'real/t.txt', old_string: 'b', new_string: 'c' }),
        ]);
        expect(viaAlias.ok, viaAlias.ok ? '' : viaAlias.denial.reason).toBe(true);
        expect(viaReal.ok, viaReal.ok ? '' : viaReal.denial.reason).toBe(true);
        await expect(readFile(join(workspace, 'real', 't.txt'), 'utf8')).resolves.toBe('c\n');
      });
    });
  });
});
