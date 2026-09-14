// T1.3 slice 2 — THE I8 grep check (ws-a invariant I8: rescue/escalation
// policy and the decision to abort live in the KERNEL, never in the driver).
//
// What is scanned, as source text (not imports — a transitive ban is the
// linter's job; this is the ownership ratchet):
//   1. src/driver/** must contain NO `setTimeout` and NO `AbortController`,
//      EXCLUDING src/driver/<name>/process.ts — process-lifecycle helpers
//      (T1.5's SIGTERM→SIGKILL ladder) may own timers, because there the
//      kernel has already DECIDED to kill and the helper only executes.
//      Drivers never decide WHEN to abort; they receive signals.
//   2. src/kernel/** contains no `setTimeout`/`AbortController` OUTSIDE
//      governor.ts — the governor is the kernel's ONE wall-clock owner
//      (I8: the governor decides WHEN to abort).
//
// Today this is nearly vacuous on the driver side (src/driver holds only the
// frozen types.ts) — so the scan asserts it actually SAW files (≥1 scanned,
// types.ts among them, and that the governor genuinely owns the kernel side):
// a ratchet that can silently pass on an empty directory is not a ratchet.
// It gains teeth in T1.4/T1.5/T1.6 as real driver implementations and
// process helpers land.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const DRIVER_DIR = join(SRC, 'driver');
const KERNEL_DIR = join(SRC, 'kernel');

/** The banned primitives: wall-clock scheduling and cancellation roots. */
const PATTERN = /setTimeout|AbortController/;

/** The one exclusion: src/driver/<name>/process.ts (T1.5's kill-ladder home). */
const PROCESS_HELPER = /^driver\/[^/]+\/process\.ts$/;

/** Every .ts source under `dir`, sorted (relative to src/), recursively. */
async function tsFilesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        found.push(full);
      }
    }
  }
  await walk(dir);
  return found.sort();
}

describe('I8 hygiene — the grep check', () => {
  test('src/driver/** owns no setTimeout/AbortController outside process.ts helpers', async () => {
    const files = await tsFilesUnder(DRIVER_DIR);
    // The scan cannot silently pass on an empty directory:
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files).toContain(join(DRIVER_DIR, 'types.ts')); // the frozen seam was scanned
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      if (PROCESS_HELPER.test(rel)) continue; // T1.5 SIGTERM→SIGKILL helpers may own timers
      const text = await readFile(file, 'utf8');
      if (PATTERN.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('the kernel keeps ONE wall-clock owner: governor.ts', async () => {
    const files = await tsFilesUnder(KERNEL_DIR);
    expect(files.length).toBeGreaterThanOrEqual(5); // types, schema, runner, journal, manifest, output, governor, rescue
    const offenders: string[] = [];
    let governorOwnsTheWallClock = false;
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const hit = PATTERN.test(text);
      if (file.endsWith(join('kernel', 'governor.ts'))) {
        governorOwnsTheWallClock = hit; // the ladder must genuinely live there
      } else if (hit) {
        offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]); // no other kernel file schedules time or roots cancellation
    expect(governorOwnsTheWallClock).toBe(true); // and the governor does — teeth today
  });
});
