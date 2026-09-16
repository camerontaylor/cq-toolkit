// Governor config defaults vs the DD-1 write-up — T1.6 slice 3.
//
// The spike-derived default lives in src/kernel/governor.config.ts (the
// single source of truth for code) and is DOCUMENTED in
// docs/dd-1-abort-spike.md (the single source of truth for the write-up).
// This test pins the two together: it parses the documented default out of
// the doc (regex `DEFAULT_ABORT_GRACE_MS = <n>`) and asserts the exported
// constant equals it — the code cannot drift from the measurement write-up
// silently, and the doc cannot change without the code following. Parsing
// (rather than restating a literal here) keeps ONE authoritative number in
// the doc; a third restatement in this file is exactly the drift this test
// exists to prevent.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { DEFAULT_ABORT_GRACE_MS } from '../../src/kernel/governor.config.js';
import { DEFAULT_KILL_GRACE_MS } from '../../src/kernel/governor.js';

const DOC = fileURLToPath(new URL('../../docs/dd-1-abort-spike.md', import.meta.url));

describe('DD-1 governor config — code matches the measurement write-up', () => {
  test('DEFAULT_ABORT_GRACE_MS equals the value documented in docs/dd-1-abort-spike.md', async () => {
    const text = await readFile(DOC, 'utf8');
    const matches = [...text.matchAll(/export const DEFAULT_ABORT_GRACE_MS = (\d+)/g)];
    // Exactly one code-style statement of the default in the doc — the
    // spike-derived block. More than one would make the pin ambiguous.
    expect(matches.length).toBe(1);
    const documented = Number(matches[0]?.[1]);
    expect(Number.isFinite(documented)).toBe(true);
    expect(documented).toBeGreaterThan(0);
    expect(DEFAULT_ABORT_GRACE_MS).toBe(documented);
  });

  test('the exported constant is the measured value (≈2.5× the ~2.0 s worst cooperative settle)', () => {
    // The spike measured the claude-agent lane's cooperative abort settle at
    // 2006/2008 ms — the default must EXCEED it with headroom (the pre-spike
    // 2000 sat exactly at the measurement, zero headroom).
    expect(DEFAULT_ABORT_GRACE_MS).toBe(5_000);
    expect(DEFAULT_ABORT_GRACE_MS).toBeGreaterThanOrEqual(2_500);
  });

  test('DEFAULT_KILL_GRACE_MS is unchanged (the spike gathered no SIGKILL-resistance evidence)', () => {
    expect(DEFAULT_KILL_GRACE_MS).toBe(5_000);
  });
});
