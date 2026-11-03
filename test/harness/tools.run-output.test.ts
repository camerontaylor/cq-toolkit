// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the run-output cap/maxBuffer cases
// (issue #18 and the later uncapped-retention pass).
//
// Harness tool-surface tests — PR 10 round-1 fixes 1 and 5, plus issue #18:
//   - fix 1 (HIGH): token-prefix command patterns must NOT bless shell
//     metacharacters (the exec shell interprets what the token prefix never
//     saw); anchored re: patterns are the documented escape hatch.
//   - fix 5 (MED): pre-existing symlinks pointing outside the workspace are
//     denied on read/edit (realpath re-check; the TOCTOU window stays
//     documented, not tested — it is not deterministically exercisable).
//   - issue #18: exec's maxBuffer is sized above the output cap so a noisy
//     command returns a TRUNCATED RESULT (capOutput truncates), never the
//     1 MiB default's string-code rejection dressed up as a run failure.
//
// NO EXTERNAL BINARIES (review round 3, finding 1): every ALLOWED case
// actually EXECUTES through /bin/sh, so its command must be shell BUILTINS
// only (echo / printf / exit / true / false). DENIED cases never execute —
// their command strings may name whatever the judgment is about.
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { withScratch } from './tools.helpers.js';

// ---------------------------------------------------------------------------
// Issue #18 — exec maxBuffer sized above the output cap: capOutput truncates,
// exec's 1 MiB default never turns noisy output into a 'run failed' denial.
// ---------------------------------------------------------------------------

describe('run output: maxBuffer sized above the cap (issue #18)', () => {
  test('a command emitting > 1 MiB returns a truncated RESULT, not a run-failed denial', async () => {
    await withScratch(async (scratchDir) => {
      // cap 600k chars → maxBuffer = 600_000 * 4 + 64KiB ≈ 2.4 MB (bytes vs
      // chars): the ~1.5 MB output fits the buffer — where exec's 1 MiB
      // DEFAULT would reject with a string-code error — and capOutput
      // truncates it. The probe is a PURE-BUILTIN /bin/sh while-loop with
      // printf (review thread: no external binary; timed in-process at
      // ~0.4 s per run, 3× consistent — far under the 2.5 s budget), so the
      // no-external-binaries convention holds with NO exception.
      const capConfig: HarnessConfig = {
        ...defaultHarnessConfig,
        tools: {
          ...defaultHarnessConfig.tools,
          bash: {
            enabled: true,
            commandPatterns: ['re:^i=0; while.*cap-probe.*$'],
            timeoutMs: 30_000,
            maxOutputChars: 600_000,
          },
        },
      };
      const run = buildTools(capConfig, scratchDir).find((t) => t.name === 'bash');
      const result = await run?.execute({
        command: `i=0; while [ $i -lt 11000 ]; do printf 'cap-probe line %05d ${'x'.repeat(110)}\\n' "$i"; i=$((i+1)); done`,
      });
      expect(result?.ok).toBe(true); // the old default made this a denial
      if (result?.ok) {
        expect(result.exitCode).toBe(0);
        expect(result.truncated).toBe(true);
        expect(result.output.length).toBeLessThanOrEqual(600_000);
        expect(result.output).toContain('exit 0');
      }
    });
  }, 30_000);
});

describe('run output retention without a cap (improvement pass)', () => {
  test('an uncapped config still bounds memory: past 1 MiB per stream the output is truncated', async () => {
    await withScratch(async (scratchDir) => {
      const config = {
        ...defaultHarnessConfig,
        tools: {
          ...defaultHarnessConfig.tools,
          bash: { enabled: true, commandPatterns: ['head'], timeoutMs: 20_000 },
        },
      };
      const run = buildTools(config, scratchDir).find((t) => t.name === 'bash');
      const result = await run?.execute({ command: 'head -c 3000000 /dev/zero' });
      expect(result?.ok).toBe(true);
      if (result?.ok !== true) return;
      expect(result.truncated).toBe(true);
      expect(result.output.length).toBeLessThan(1_200_000);
    });
  }, 30_000);
});
