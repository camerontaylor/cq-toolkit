// Analyze lane G3 — the playbook VERIFIER: run a playbook's verifier
// command through the INJECTED subprocess runner (the gates' RunCheck seam
// — the same seam the codemod engine and every gates op use), and map the
// observed exit onto a three-way verdict that decides whether the playbook
// REMAINS DISPATCHABLE:
//
//   exit 0                    → 'pass'          — the remediation held
//   numeric non-zero exit     → 'fail'          — the remediation did not
//   null exit (unobservable)  → 'indeterminate' — NO verdict exists
//
// Invariants honored here:
//   - I5 (non-passing evidence): an UNOBSERVABLE exit (timeout kill,
//     signal, spawn failure, output overflow — RawCheckOutput.exitCode
//     null) is NEVER a pass and NEVER a fail. Passing it would certify an
//     unverified remediation; failing it would punish a playbook on
//     evidence that does not exist. The dispatch layer (playbooks/
//     registry.ts) reports an indeterminate verdict honestly and leaves the
//     playbook's quarantine state UNTOUCHED.
//   - A `fail` reason carries the CAPTURED OUTPUT EXCERPT (stdout then
//     stderr, trimmed, bounded): a verifier that failed with diagnostics
//     must hand those diagnostics to the human who now has to judge the
//     quarantined playbook — the reason is the quarantine record's payload.
//   - The module is pure with respect to processes: the ONLY execution
//     crosses the injected runner, so tests inject fakes and never spawn.
import type { RawCheckOutput, RunCheck } from '../../gates/checkRunner.js';
import type { VerifierCommand } from './format.js';

/** The captured-output excerpt bound for fail/indeterminate reasons. */
const EXCERPT_MAX_CHARS = 200;

/** The verifier's verdict on one playbook's applied remediation. */
export type PlaybookVerifierOutcome =
  | { verdict: 'pass'; exitCode: number }
  | { verdict: 'fail'; exitCode: number; reason: string }
  | { verdict: 'indeterminate'; exitCode: null; reason: string };

/**
 * Build the verifier over an injected runner. The mapping is TOTAL and in
 * decision order: a runner-level crash (a rejected seam — the shipped
 * subprocess runner never rejects, but injected ones may) is
 * `indeterminate` (nothing was observed); an unobservable exit code is
 * `indeterminate` with the captured excerpt; exit 0 is `pass`; any numeric
 * non-zero exit is `fail` with the captured excerpt in the reason.
 */
export function makePlaybookVerifier(
  run: RunCheck,
): (command: VerifierCommand) => Promise<PlaybookVerifierOutcome> {
  return async (command) => {
    let raw: RawCheckOutput;
    try {
      raw = await run(command);
    } catch (err) {
      return {
        verdict: 'indeterminate',
        exitCode: null,
        reason: `playbook verifier: the runner crashed before the verifier could complete — ${messageOf(err)}`,
      };
    }
    if (raw.exitCode === null) {
      const excerpt = excerptOf(raw.stdout, raw.stderr);
      return {
        verdict: 'indeterminate',
        exitCode: null,
        reason: `playbook verifier: the exit code was unobservable (timeout kill, signal, spawn failure, or output overflow) — no verdict exists, and an unobservable verdict is never a pass (I5)${excerpt === '' ? '' : `; captured output: ${excerpt}`}`,
      };
    }
    if (raw.exitCode === 0) {
      return { verdict: 'pass', exitCode: 0 };
    }
    const excerpt = excerptOf(raw.stdout, raw.stderr);
    return {
      verdict: 'fail',
      exitCode: raw.exitCode,
      reason: `playbook verifier: exited ${String(raw.exitCode)} — the applied remediation did not hold${excerpt === '' ? '' : `; captured output: ${excerpt}`}`,
    };
  };
}

/** Trimmed stdout-then-stderr excerpt, bounded to {@link EXCERPT_MAX_CHARS}. */
function excerptOf(stdout: string, stderr: string): string {
  const combined = `${stdout.trim()}${stderr.trim() === '' ? '' : `\n${stderr.trim()}`}`;
  return combined.slice(0, EXCERPT_MAX_CHARS);
}

/** Error message of an unknown throwable, for indeterminate reasons. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
