// Kernel error classes the CLI maps to exit codes by CLASS (ADR-0003 §2.9:
// the refusals are "mapped from a typed error class the CLI catches, never by
// message matching"). The message text stays byte-identical contract for
// narration and tests; the class is the structured datum the exit-code
// decision reads, so a message edit can never silently move an exit code.
// Imports nothing: this file is the kernel's error vocabulary, imported by
// journal.ts, runner.ts and the CLI's run-plan mapping alike.

/**
 * The plan lock is held by a live run (`journal: plan locked by …`, both the
 * same-host and the foreign-host refusal). The refusal is TRANSIENT — the
 * holder may release, abort or die — so the CLI maps it to exit 3
 * (needs-human / retry later), never 2: automation treats 2 as a permanent
 * usage error and would never retry (ADR-0003 §2.9). Thrown by
 * `acquirePlanLock`'s reclamation judgment in journal.ts, before the
 * contender touches any shared history.
 */
export class PlanLockRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanLockRefusedError';
  }
}

/**
 * A governed-ledger refusal whose message names the operator's resolution —
 * an explicit opt-in or a flag change, so the INVOCATION is the defective
 * input: an ungoverned run over governed history, the ungoverned-over-governed
 * marker on a plan with no governed history, a governed run over v1 journals
 * with unaccounted dispatches, a cap raise over the last governed cap
 * (ADR-0003 §2.9: "a missing `--opt-in`" → 2). Thrown by `runPlan` before
 * anything is emitted or claimed; the CLI maps it to exit 2 (usage) by this
 * class, never by the `runPlan: ` message prefix the other kernel input
 * classes still match.
 */
export class GovernanceOptInRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceOptInRefusedError';
  }
}
