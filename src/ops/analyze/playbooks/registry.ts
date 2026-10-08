// Analyze lane G3 — the PLAYBOOK REGISTRY and the DISPATCH flow: the
// consumer-facing remediation path where an authored playbook's ast-grep
// rule is applied to explicit targets and the playbook's OWN verifier
// decides whether the playbook REMAINS dispatchable.
//
// The dispatch contract, in pinned order, fail-closed at every step:
//   1. REGISTRY LOOKUP — an unknown playbook id is `failed` naming the
//      registered ids. Nothing runs for a name that does not exist.
//   2. QUARANTINE CONSULT — a quarantined playbook is refused (`needs-
//      human`) BEFORE any scan or write, with the quarantine record's
//      reason. A quarantined playbook is NEVER re-dispatched automatically:
//      the refusal is `needs-human` precisely because lifting a quarantine
//      is a human decision (QuarantineLedger.unquarantine — an explicit
//      consumer action; nothing in the codebase calls it).
//   3. THE CODEMOD ENGINE — the playbook's rule (serialized verbatim,
//      JSON.stringify — JSON is a valid YAML form, so this IS the rule the
//      engine accepts as text) runs through `makeAstGrepCodemod` over the
//      injected runner and store: scan → collision check → freshness
//      anchor → apply, with per-file results and the engine's best-effort
//      rollback. The engine runs TWICE inside the approved mutation, both
//      halves under ONE lock hold (the #258 owner ruling, option D): a
//      DRY-RUN as the mutation's PREFLIGHT — after admission, BEFORE the
//      nonce is exercised — so a malformed rule, an unreadable target, a
//      collision or a splice fault refuses the dispatch `failed` with the
//      approval token UNSPENT (a refused op must not burn a human's
//      approval, and a retry with the SAME token is possible once the scan
//      passes); then the real apply AFTER the spend, which re-scans and
//      re-verifies freshness itself, so every plan it writes was computed
//      against bytes it read inside the same hold. The cost is a second
//      scan, accepted by the ruling. The engine's `approved: true` is NO
//      LONGER the authorization: since W4.3 it is only the primitive's
//      INTRA-OP freshness anchor (ADR-0003 §2/§6 keeps that boolean for
//      exactly this), and the authorization is an approval GRANT exercised
//      and consumed around this call under the workspace mutation lock. The
//      pre-apply bytes of every target are captured FIRST, so a
//      non-passing verdict can be rolled back (step 5). A dispatch with no
//      grant bound is refused `needs-human` before the engine runs. An
//      engine fault AFTER the spend (freshness drift between the two scans,
//      a write/rollback fault) is still a `failed` dispatch with the token
//      SPENT — ADR-0003 §4c's crash analysis: burning a token on a failed
//      mutation is safe, replaying it is not — and there is NO quarantine
//      either way: the playbook did not fail its verifier; the machinery
//      failed before one could run.
//   4. THE VERIFIER — the playbook's command runs through the injected
//      verifier (playbooks/verifier.ts) and the verdict decides the
//      dispatch outcome AND the playbook's quarantine state:
//        - 'pass'          → `ok`, outcome 'verified'.
//        - 'fail'          → the playbook is QUARANTINED (a ledger record
//          carrying the verifier's reason), the applied edits are RESTORED
//          (step 5), and the dispatch returns `failed` — a remediation
//          that provably did not hold is a FAILED dispatch. The
//          regressionGate "a definitive verdict is decision output"
//          precedent does NOT apply here, and step 5 is why: because the
//          workspace is returned to its pre-dispatch bytes, there is no
//          applied state left to report as a success, and a bare `ok` is
//          exactly the shape a status-only caller (a plan step, a summary
//          line) reads as "the remediation held".
//        - 'indeterminate' → the dispatch returns `indeterminate` — an
//          unobservable verdict must not PUNISH the playbook (no
//          quarantine) any more than it may PASS it (I5). The edits are
//          restored too, and the prose says plainly that the verdict was
//          unobservable.
//   5. ROLLBACK ON A NON-PASSING VERDICT (W4.3) — a `fail` or an
//      `indeterminate` restores every file the apply rewrote, from the
//      bytes captured before it ran, through the SAME store. The restore
//      report names what was restored and — the part that must never be
//      softened — what is STRANDED (a file the restore could not put
//      back), so the exact on-disk state is always knowable.
//      THE RESTORE IS A MUTATION, so it runs under the SAME workspace
//      mutation lock as the apply (O-6) AND it is CONDITIONAL: it writes the
//      pre-apply bytes back only if the file still holds the exact bytes THIS
//      dispatch wrote. A concurrent approved dispatch of another playbook may
//      legitimately have written the same workspace while this verifier was
//      running, and a blind restore would silently discard that work — a lost
//      update between the ops' own writers, which no amount of "the workspace
//      is under approval" excuses. A file that no longer matches is reported
//      STRANDED, untouched, with the digests on both sides.
//      RESIDUAL, stated rather than hidden: "a pass is the only outcome that
//      leaves the workspace alone" is true of THIS dispatch's own edits, NOT
//      of the workspace under concurrent approved dispatches. Two approved
//      dispatches over overlapping targets can interleave such that B
//      restores A's verifier-failed bytes as its own pre-apply baseline —
//      A's stranded evidence makes the state detectable, and nothing is
//      CLOBBERED (both reports are truthful from their own frame), but a
//      failed remediation can survive on disk. Recorded as a residual in the
//      family NOTES; the fix would fingerprint the pre-apply capture inside
//      the mutation critical section rather than trusting the pre-capture
//      bytes as the restore baseline.
//
// THE TRACE CUT (journal-record shape): every dispatch is supposed to leave
// a journal record, but the kernel journal seam (src/kernel/journal.ts) is
// PLAN-RUN-SHAPED — the frozen JournalEventSchema union has no standalone
// dispatch event, and append() requires event.runId to match the file's
// run; faking a runId/jobId would poison the resume fold's per-job facts.
// So v1 RETURNS the dispatch record in the result instead: the exported
// {@link PlaybookDispatchRecord} shape rides `value.record` on the `ok`
// outcome. The frozen OpResult taxonomy gives `indeterminate` no value slot
// and `failed` no payload slot, so on BOTH non-ok verifier paths the record
// rides `detail`/`error` as serialized JSON (same shape, same reason). An
// early `failed` termination (steps 1–3) records no trace beyond the error
// string — nothing was applied, nothing was quarantined, and the taxonomy
// has no payload slot. The full `trace` query op and a durable dispatch
// journal are post-v1 (recorded in the family NOTES.md).
import type { Op, OpResult } from '../../../kernel/types.js';
import type { RunCheck } from '../../gates/checkRunner.js';
import type { ApprovalAuthority, ApprovedMutation } from '../approval.js';
import {
  approvalInputDigest,
  contentFingerprint,
  DENY_ALL_APPROVALS,
  withApprovedMutation,
  withMutationLock,
} from '../approval.js';
import type { AnalyzeFileStore } from '../analysisStore.js';
import type { CodemodFileApplied, CodemodReport } from '../codemod/astGrep.js';
import { makeAstGrepCodemod } from '../codemod/astGrep.js';
import type { Playbook, VerifierCommand } from './format.js';
import type { QuarantineLedger, QuarantineRecord } from './quarantine.js';
import type { PlaybookVerifierOutcome } from './verifier.js';
import { makePlaybookVerifier } from './verifier.js';

/**
 * The op-boundary cap for a JSON-dispatched verifier whose authored command
 * omits `timeoutMs` (the gates registry's 600_000ms op-boundary default —
 * see the call site in {@link makePlaybookDispatchOp} for the
 * boundary-vs-library distinction).
 */
const DISPATCH_VERIFIER_TIMEOUT_MS = 600_000;

/**
 * The playbook registry: register (REFUSES a duplicate id — the global
 * uniqueness the format schema deliberately does not check), get, list.
 * In-memory, deterministic (list sorted by id); process-scoped in v1 (the
 * composition binds one instance — see quarantine.ts for the cut).
 *
 * SNAPSHOT DISCIPLINE (no mutation aliasing): the registry stores and
 * returns DEEP COPIES of every playbook — a caller mutating the object it
 * registered (or one it got back from get/list) can never change what a
 * later dispatch executes. The playbook is the recorded remediation
 * decision; its bytes at dispatch time must be the bytes that were
 * registered.
 */
export interface PlaybookRegistry {
  /**
   * Register a validated playbook. Throws (RangeError) on a duplicate id —
   * the op boundary maps the refusal to `failed` naming the id. Stores a
   * deep copy; the returned value is the registered snapshot.
   */
  register(playbook: Playbook): Playbook;
  /** A copy of the registered playbook with this id, or undefined. */
  get(id: string): Playbook | undefined;
  /** Copies of all registered playbooks, sorted by id. */
  list(): Playbook[];
  /**
   * Run `task` in the dispatch slot for the playbook id — with IN-FLIGHT
   * REJECTION, not queueing: when a task for the SAME id arrives while the
   * previous one is still unsettled, it is refused with a
   * {@link DispatchInFlightError} WITHOUT running (a queued duplicate would
   * re-apply the rule once the in-flight dispatch passed). Tasks for
   * DIFFERENT ids are unserialized. When the in-flight dispatch settles
   * (either way), the slot frees and a NEW — deliberate — dispatch proceeds
   * normally. This is the dispatch op's double-apply guard, and it is
   * unconditional: a same-playbook duplicate can never reach the engine.
   * Process-scoped, like the registry itself (the cross-process story is
   * the same process-scoped cut recorded in the family NOTES).
   *
   * FREE-BEFORE-CONTINUATION: the slot is freed on the SAME chain the
   * caller awaits (the returned promise settles only after the free), so a
   * SEQUENTIAL second dispatch — the direct SDK caller that awaits the
   * first promise and then dispatches again — can never observe the slot
   * as still occupied. The outcome (or rejection reason) rides verbatim.
   */
  withDispatch<T>(id: string, task: () => Promise<T>): Promise<T>;
}

/**
 * Thrown by {@link PlaybookRegistry.withDispatch} when a dispatch of the
 * same playbook arrives while another is unsettled; the dispatch op maps it
 * to `needs-human` verbatim.
 */
export class DispatchInFlightError extends Error {
  readonly playbookId: string;
  constructor(playbookId: string) {
    super(
      `a dispatch of playbook '${playbookId}' is already in flight; wait for it to settle — a queued duplicate would re-apply the rule`,
    );
    this.name = 'DispatchInFlightError';
    this.playbookId = playbookId;
  }
}

/** Build a playbook registry. Seeds are registered in order (duplicates throw). */
export function makePlaybookRegistry(initial?: readonly Playbook[]): PlaybookRegistry {
  const byId = new Map<string, Playbook>();
  // The per-id dispatch slots: an entry exists exactly while that
  // playbook's dispatch is UNSETTLED, and is removed on settlement so the
  // next — deliberate — dispatch proceeds normally through the quarantine
  // check.
  const inFlight = new Map<string, Promise<unknown>>();
  const stored = (playbook: Playbook): Playbook => {
    const copy = structuredClone(playbook);
    byId.set(copy.id, copy);
    return structuredClone(copy);
  };
  for (const playbook of initial ?? []) {
    if (byId.has(playbook.id)) {
      throw new RangeError(`playbook registry: duplicate id '${playbook.id}' in seed`);
    }
    stored(playbook);
  }
  return {
    register: (playbook) => {
      if (byId.has(playbook.id)) {
        throw new RangeError(
          `playbook registry: a playbook with id '${playbook.id}' is already registered — ids are globally unique; pick a new id`,
        );
      }
      return stored(playbook);
    },
    get: (id) => {
      const playbook = byId.get(id);
      return playbook === undefined ? undefined : structuredClone(playbook);
    },
    list: () =>
      [...byId.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((playbook) => structuredClone(playbook)),
    withDispatch: <T>(id: string, task: () => Promise<T>): Promise<T> => {
      if (inFlight.has(id)) {
        return Promise.reject(new DispatchInFlightError(id));
      }
      // RE-ENTRANCY: the slot is installed — as a never-settling
      // PLACEHOLDER — BEFORE task() runs, so a task that synchronously
      // re-enters withDispatch for its own id observes the slot and is
      // refused, never double-run. The placeholder is replaced by the
      // settled envelope the moment the task returns its promise; if the
      // task throws synchronously (no promise at all), the placeholder slot
      // is freed and the throw propagates.
      type Outcome = { ok: true; value: T } | { ok: false; reason: unknown };
      inFlight.set(id, new Promise<Outcome>(() => {}));
      let settled: Promise<Outcome>;
      try {
        settled = task().then(
          (value) => ({ ok: true as const, value }),
          (reason: unknown) => ({ ok: false as const, reason }),
        );
      } catch (err) {
        inFlight.delete(id);
        throw err;
      }
      // FREE-BEFORE-CONTINUATION: the slot is freed ON the chain the caller
      // awaits. The RETURNED promise is derived from the settled envelope
      // with freeSlot FIRST, so freeSlot always runs before any caller
      // continuation, and the value/reason is then re-delivered verbatim.
      // (Freeing on a SIDE chain — `void settled.then(freeSlot, freeSlot)`
      // — let the caller's continuation win the microtask race, spuriously
      // rejecting the next sequential dispatch.)
      const freeSlot = (): void => {
        if (inFlight.get(id) === settled) inFlight.delete(id);
      };
      inFlight.set(id, settled);
      return settled.then((outcome) => {
        freeSlot();
        if (outcome.ok) {
          return outcome.value;
        }
        throw outcome.reason;
      });
    },
  };
}

/** JSON-serializable input of the `analyze.playbookRegister` op. */
export interface PlaybookRegisterInput {
  /** The validated playbook asset (PlaybookSchema at the dispatch boundary). */
  playbook: Playbook;
}

/** The register op's report. */
export interface PlaybookRegistered {
  id: string;
  /** How many playbooks are registered after this one. */
  total: number;
}

/**
 * Build the `analyze.playbookRegister` op over an injected playbook
 * registry. A duplicate id is a `failed` refusal (the registry's throw,
 * mapped) — registration is how a playbook becomes dispatchable, and a
 * silent overwrite would swap the asset under an id a consumer already
 * dispatched.
 */
export function makePlaybookRegisterOp(
  playbooks: PlaybookRegistry,
): Op<PlaybookRegisterInput, PlaybookRegistered> {
  return async (input) => {
    try {
      playbooks.register(input.playbook);
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      status: 'ok',
      value: { id: input.playbook.id, total: playbooks.list().length },
    };
  };
}

/** Input of the `analyze.playbookQuarantineList` op: the empty object. */
export type PlaybookQuarantineListInput = Record<string, never>;

/** The quarantine-list op's report: the live records, sorted by playbook id. */
export interface PlaybookQuarantineListReport {
  records: QuarantineRecord[];
}

/**
 * Build the `analyze.playbookQuarantineList` op over an injected ledger:
 * the read-only view of the quarantine lane (what a consumer checks before
 * investigating, and the acceptance surface for "quarantined playbooks stay
 * listed"). Pure data out; the ledger is not mutated.
 */
export function makePlaybookQuarantineListOp(
  quarantine: QuarantineLedger,
): Op<PlaybookQuarantineListInput, PlaybookQuarantineListReport> {
  return async () => ({
    status: 'ok',
    value: { records: quarantine.records() },
  });
}

/** JSON-serializable input of the `analyze.playbookDispatch` op. */
export interface PlaybookDispatchInput {
  /** The registered playbook to dispatch. */
  playbookId: string;
  /** The containment root: every target resolves inside it (the store binding). */
  dir: string;
  /** The files to remediate (at least one — an unscoped sweep is refused). */
  targets: string[];
  /** Wall-clock cap for the engine's scan subprocess; the registry boundary defaults it to 600_000ms. */
  timeoutMs?: number;
}

/** The injected seams of the dispatch op (all tests inject fakes). */
export interface PlaybookDispatchDeps {
  playbooks: PlaybookRegistry;
  quarantine: QuarantineLedger;
  /** The runner for BOTH the engine's scans and the verifier command. */
  run: RunCheck;
  /** The store binding for the containment root (the registry binds the path store over `input.dir`). */
  storeFor: (input: PlaybookDispatchInput) => AnalyzeFileStore;
  /**
   * The ADR-0003 approval seam, DEFAULTING TO THE DENY-ALL authority: with
   * nothing bound, a dispatch is refused `needs-human` at the mutation and
   * the engine's internal `approved: true` authorizes nothing. The
   * registry adapter that binds the kernel's verified approvals is #238's
   * file and is deliberately NOT edited here; until it lands, this default
   * is the honest fail-closed state rather than the bypass W4.3 removed.
   */
  approval?: ApprovalAuthority;
}

/**
 * The dispatch TRACE RECORD — the exported journal-record SHAPE (module
 * header, THE TRACE CUT): plain serializable data, discriminated by `kind`,
 * that a future durable dispatch journal would append and a future `trace`
 * query op would filter on. v1 returns it in the dispatch result instead
 * (value.record; the detail string on the indeterminate outcome).
 */
export interface PlaybookDispatchRecord {
  kind: 'playbook-dispatch';
  playbookId: string;
  targets: string[];
  plannedEdits: number;
  unfixedMatches: number;
  files: Array<{ file: string; edits: number; digestAfter: string }>;
  verifier: PlaybookVerifierOutcome;
  outcome: 'verified' | 'verifier-failed' | 'verifier-indeterminate';
  quarantined: boolean;
  /**
   * The step-5 rollback evidence. Present ONLY on the non-passing
   * outcomes, where the applied edits were restored; absent on 'verified',
   * where nothing was rolled back and there is nothing to report.
   */
  restore?: PlaybookRestoreReport;
}

/**
 * The step-5 rollback report (W4.3). `stranded` is the load-bearing field:
 * a file the restore could NOT put back is not folded into `restored`, and
 * its presence means the workspace is NOT the pre-dispatch state the prose
 * otherwise claims.
 */
export interface PlaybookRestoreReport {
  /** The files the apply rewrote (the restore's candidate set). */
  attempted: string[];
  /** The files whose pre-apply bytes were written back. */
  restored: string[];
  /** The files that could NOT be restored, with the fault for each. */
  stranded: Array<{ file: string; error: string }>;
}

/** The dispatch report for the ONE `ok` outcome: the verifier passed. */
export interface PlaybookDispatchOutcome {
  outcome: 'verified';
  playbookId: string;
  targets: string[];
  plannedEdits: number;
  unfixedMatches: number;
  files: CodemodFileApplied[];
  note?: string;
  record: PlaybookDispatchRecord;
}

/**
 * The evidence for a NON-PASSING verdict. Since W4.3 both variants are
 * non-`ok` (a `fail` dispatch is `failed`, an `indeterminate` one is
 * `indeterminate`), and the frozen OpResult taxonomy gives neither a
 * payload slot — so this shape rides `error`/`detail` as serialized JSON
 * on the same trace cut the dispatch record already uses. It is exported so
 * a consumer can parse the JSON it finds there.
 */
export interface PlaybookDispatchUnverified {
  outcome: 'verifier-failed' | 'verifier-indeterminate';
  playbookId: string;
  targets: string[];
  plannedEdits: number;
  unfixedMatches: number;
  /** The files the apply rewrote — restored afterwards (see {@link restore}). */
  files: CodemodFileApplied[];
  note?: string;
  /** True exactly on 'verifier-failed': the observed failure WROTE the quarantine record. */
  quarantined: boolean;
  /** The verifier's reason — on 'verifier-failed' the same string the ledger record carries. */
  verifierReason: string;
  /** The step-5 rollback evidence for the restore that followed the verdict. */
  restore: PlaybookRestoreReport;
  record: PlaybookDispatchRecord;
}

/**
 * Build the `analyze.playbookDispatch` op over the injected seams. The
 * pinned contract is the module header; the two load-bearing state
 * transitions are: a verifier FAIL writes the quarantine record (fail
 * closed — the very next dispatch consults it and refuses), and a verifier
 * INDETERMINATE writes nothing (an unobservable verdict neither passes nor
 * punishes).
 *
 * IN-FLIGHT REJECTION (the double-apply guarantee is unconditional): the
 * whole sequence runs in the registry's per-playbook-id dispatch slot
 * ({@link PlaybookRegistry.withDispatch}), and a dispatch of the SAME
 * playbook that arrives while another is UNSETTLED is refused `needs-human`
 * IMMEDIATELY — without running the engine or the verifier — so a duplicate
 * can never re-apply a non-idempotent rule, whatever the in-flight
 * dispatch's verdict turns out to be (serialization would merely queue the
 * duplicate and re-apply after a PASS). After the in-flight dispatch
 * settles, the slot frees and a NEW dispatch proceeds normally through the
 * quarantine check: a deliberate consumer re-dispatch of a passed playbook
 * is an explicit action, the same trust level as the first. Different
 * playbooks dispatch unserialized. Process-scoped, the same cut as the
 * registry and ledger themselves.
 */
/** The dispatch flow's full result type (the in-flight-rejecting wrapper returns it). */
type PlaybookDispatchResult = OpResult<PlaybookDispatchOutcome>;

export function makePlaybookDispatchOp(
  deps: PlaybookDispatchDeps,
): Op<PlaybookDispatchInput, PlaybookDispatchOutcome> {
  const dispatchOnce = async (input: PlaybookDispatchInput): Promise<PlaybookDispatchResult> => {
    // ---- 1. Registry lookup (before anything runs).
    const playbook = deps.playbooks.get(input.playbookId);
    if (playbook === undefined) {
      const registered = deps.playbooks.list().map((entry) => entry.id);
      return {
        status: 'failed',
        error: `unknown playbook id '${input.playbookId}' — registered: ${registered.join(', ') || '(none)'}`,
      };
    }
    // ---- 2. Quarantine consult — fail closed BEFORE any scan or write.
    if (deps.quarantine.isQuarantined(playbook.id)) {
      const reason = deps.quarantine.reasonOf(playbook.id);
      return {
        status: 'needs-human',
        reason: `playbook '${playbook.id}' is quarantined and is never re-dispatched automatically${reason === undefined ? '' : ` — quarantine reason: ${reason}`}; lifting the quarantine is an explicit consumer action (QuarantineLedger.unquarantine), never an automatic one`,
      };
    }
    // ---- 3. The codemod engine (scan → collision → freshness → apply),
    // through the exported engine factory — the wire logic is NOT
    // duplicated here. The store is resolved up front so a containment
    // fault fails before the engine's first read.
    let store: AnalyzeFileStore;
    try {
      store = deps.storeFor(input);
    } catch (err) {
      return {
        status: 'failed',
        error: `playbook dispatch: ${messageOf(err)}`,
      };
    }
    const targets = [...new Set(input.targets)].sort();
    // ---- 3a. PRE-APPLY CAPTURE (W4.3, step 5's precondition). The bytes
    // every target holds RIGHT NOW, before the engine can touch anything.
    // Without this the only outcomes are "the edits stay" and "the edits
    // are wrong on disk forever": a verifier failure has nothing to restore
    // from, which is precisely the state W4.3 closes. A read fault here is
    // `failed` with nothing written — the capture is the precondition, not
    // an optimization.
    const preApply = new Map<string, Uint8Array>();
    for (const file of targets) {
      try {
        preApply.set(file, await store.readBytes(file));
      } catch (err) {
        return {
          status: 'failed',
          error: `playbook dispatch: could not capture the pre-apply bytes of '${file}', which the rollback on a non-passing verifier verdict depends on — nothing was written (${messageOf(err)})`,
        };
      }
    }
    // ---- 3b. THE MUTATION BOUNDARY (ADR-0003 §4c). The engine call IS
    // the write, and it is reached only through `withApprovedMutation`:
    // the grant is re-checked against the CURRENT workspace state and its
    // nonce spent in one critical section of the workspace mutation lock,
    // held through the engine's whole mutating call. The engine's own
    // `approved: true` is the intra-op freshness anchor, not the
    // authorization — the plan-JSON-shaped boolean cannot reach a byte on
    // disk through this path (A16).
    //
    // THE PREFLIGHT (the #258 owner ruling, option D): the engine's scan
    // runs as the approved mutation's `preflight` — INSIDE the lock, after
    // admission, BEFORE the nonce is exercised — as a DRY-RUN, so every
    // pre-spend refusal (a malformed rule, an unreadable target, a
    // collision, a splice fault) fails the dispatch with the token UNSPENT
    // instead of burning it. The apply after the spend re-scans and
    // re-verifies freshness itself inside the same hold, so the plan it
    // writes is always computed against bytes it read under the lock; the
    // scan and the mutation share one hold with no gap between them.
    // Set when the preflight refused (or faulted): the dispatch outcome is
    // then the engine-fault shape (`failed` — the playbook did not fail its
    // verifier), never an approval refusal, and the nonce is UNSPENT.
    let preflightRefusal: string | undefined;
    const subject = {
      op: 'analyze.playbookDispatch',
      workspace: input.dir,
      targets,
      // The RESOLVED playbook's rule and verifier are digested too, not only
      // its id: the registry is process-scoped and re-registrable, so an id
      // alone would let a token approved for one rule authorize another
      // registered under the same name.
      inputDigest: approvalInputDigest({
        playbookId: input.playbookId,
        rule: playbook.rule,
        verifier: playbook.verifier,
        dir: input.dir,
        targets,
        timeoutMs: input.timeoutMs,
      }),
    };
    // The try wraps the AWAIT itself, not the destructuring below: a
    // PostApplyReadFault is thrown from inside the write callback, so it
    // surfaces as a rejection of withApprovedMutation, after the lock has
    // been released.
    // Set on entering the write callback, i.e. once the exercise granted —
    // what separates an acquire-side lock fault (token UNSPENT, nothing
    // written) from a release-side one (token spent, edits may be on disk).
    let writeEntered = false;
    let approved: ApprovedMutation<{
      engine: OpResult<CodemodReport>;
      applied: Map<string, string>;
    }>;
    try {
      approved = await withApprovedMutation(
        deps.approval ?? DENY_ALL_APPROVALS,
        subject,
        async (
          scope,
        ): Promise<{
          engine: OpResult<CodemodReport>;
          applied: Map<string, string>;
        }> => {
          writeEntered = true;
          // NESTED COMPOSITION (ADR-0003 §6): the engine primitive receives
          // the scope for the approval THIS dispatch already exercised, so the
          // inner write runs under the already-held lock and already-consumed
          // nonce WITHOUT exercising a second approval — which would throw on
          // at-most-once. A scope is not a bypass: it is minted only inside
          // this critical section, is not serializable, and carries no nonce.
          const engine = await makeAstGrepCodemod(
            deps.run,
            () => store,
            undefined,
            scope,
          )({
            dir: input.dir,
            rule: JSON.stringify(playbook.rule),
            files: targets,
            dryRun: false,
            // NOT the authorization: the primitive's intra-op freshness
            // anchor, which ADR-0003 §2/§6 keeps. The authorization is the
            // grant consumed above.
            approved: true,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          });
          // THE POST-APPLY FINGERPRINTS, read back INSIDE the same critical
          // section that wrote them. They are what step 5's conditional
          // restore compares against, so "the file still holds what I
          // wrote" is answered from bytes this dispatch itself produced,
          // not from a digest the engine reported and never re-read.
          const written = new Map<string, string>();
          if (engine.status === 'ok' && engine.value.mode === 'applied') {
            for (const file of engine.value.files) {
              try {
                written.set(file.file, contentFingerprint(await store.readBytes(file.file)));
              } catch (err) {
                throw new PostApplyReadFault(file.file, messageOf(err));
              }
            }
          }
          return { engine, applied: written };
        },
        // THE PREFLIGHT CALLBACK (option D): the SAME engine, DRY-RUN —
        // scan, collision check, freshness anchor and diff/splice
        // computation, all read-only — over the exact inputs the apply
        // would use. `ok` (including the honest zero-edit dry-run) lets the
        // exercise proceed; anything else is captured as the dispatch's
        // `failed` refusal and returned as the preflight verdict that keeps
        // the nonce unspent. No scope is passed here, and none is needed: a
        // scope asserts an approval already consumed, which is false at
        // preflight time, and a dry-run writes nothing.
        async () => {
          const plan = await makeAstGrepCodemod(
            deps.run,
            () => store,
          )({
            dir: input.dir,
            rule: JSON.stringify(playbook.rule),
            files: targets,
            dryRun: true,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          });
          if (plan.status === 'ok') return { ok: true as const };
          // A dry-run answers ok/failed in practice (no approval gate on a
          // dry-run, no write phase), but the frozen OpResult taxonomy
          // allows the other statuses, so each contributes the reason it
          // actually carries — never an invented one.
          preflightRefusal =
            plan.status === 'failed'
              ? plan.error
              : plan.status === 'needs-human'
                ? plan.reason
                : plan.status === 'indeterminate'
                  ? plan.detail
                  : 'the engine returned no plan (budget exhausted)';
          return { ok: false as const, reason: preflightRefusal };
        },
      );
    } catch (err) {
      // A post-apply read fault lands here: the apply DID happen, and the
      // one thing we can no longer prove is what the file holds, so no
      // rollback is attempted. Saying so beats restoring blind.
      if (err instanceof PostApplyReadFault) {
        return {
          status: 'failed',
          error: `playbook dispatch: the remediation was applied, but re-reading '${err.file}' to fingerprint the applied bytes FAILED (${err.message}) — the rollback on a non-passing verifier verdict cannot be proven safe, so NO restore was attempted and the workspace holds the applied edits; inspect it by hand before re-dispatching`,
        };
      }
      // A LOCK FAULT is a RESULT, not an escape (the applyRemediation and
      // restoreTargets rule): a release fault can follow a completed engine
      // write, and rejecting would leave applied-but-unverified edits on disk
      // with no evidence. No verifier or restore runs — the section's
      // exclusivity is unproven, so neither could be trusted.
      const tokenFate = writeEntered
        ? 'the approval WAS exercised, so the token is spent'
        : 'the approval was NOT exercised (the fault hit before the write), so the token is UNSPENT';
      return {
        status: 'failed',
        error: `playbook dispatch: the workspace mutation lock faulted during the approved apply of playbook '${playbook.id}' — ${messageOf(err)}. ${tokenFate}; the targets were ${targets.map((file) => `'${file}'`).join(', ')} and NO verifier or rollback ran — a lock fault proves neither that the edits landed nor that they did not, so inspect the workspace before re-dispatching; this is NOT an approval refusal`,
      };
    }
    if (approved.status === 'needs-human') {
      // A PREFLIGHT REFUSAL rode the needs-human shape out of the approved
      // mutation (that is its contract), but at this op boundary it is an
      // ENGINE fault, not an approval refusal: the playbook did not fail
      // its verifier, the machinery failed before one could run — and, the
      // whole point of the preflight, the machinery failed WITHOUT burning
      // the single-use approval.
      if (preflightRefusal !== undefined) {
        return {
          status: 'failed',
          error: `playbook dispatch: the preflight scan refused the approved apply of playbook '${playbook.id}' before the approval token was spent — ${preflightRefusal} — nothing was written, the nonce is UNSPENT (a retry with the SAME token is possible once the scan passes), and NO verifier or rollback ran; the playbook did not fail its verifier: the machinery failed before one could run`,
        };
      }
      return {
        status: 'needs-human',
        reason: `${approved.reason}; playbook '${playbook.id}' was not dispatched and no target of '${targets.length}' was read for modification — re-approve against the current workspace state to dispatch it`,
      };
    }
    const engineResult: OpResult<CodemodReport> = approved.value.engine;
    const postApply: Map<string, string> = approved.value.applied;
    if (engineResult.status !== 'ok') {
      // Unreachable by construction (approved: true, dryRun: false — and the
      // engine never returns budget-exhausted/indeterminate), but the frozen
      // taxonomy allows them, so they pass through honestly rather than
      // being collapsed into a fabricated verdict. The token is spent by
      // now: ADR-0003 §4c's crash analysis makes a burn safe, a replay
      // unsafe.
      return engineResult;
    }
    const applied = engineResult.value;
    if (applied.mode !== 'applied') {
      // Unreachable: dispatch always runs the apply mode (dryRun: false).
      return {
        status: 'failed',
        error: 'playbook dispatch: the engine returned a dry-run report',
      };
    }
    const files = applied.files;
    // ---- 4. The playbook's own verifier decides the outcome.
    // OP-BOUNDARY DEFAULTS for the two authored-optional command fields
    // (both documented on the format's VerifierCommand — the asset keeps
    // them optional at the LIBRARY level, playbooks/format.ts):
    //   - timeoutMs: the gates registry's op-boundary precedent — a
    //     JSON-dispatched verifier whose playbook omits the timeout would
    //     otherwise run UNCAPPED; the gates' 600_000ms default applies HERE.
    //   - cwd: an authored command without `cwd` would inherit the
    //     DISPATCHING process's cwd, so a verifier could exit 0 against the
    //     wrong tree — a VACUOUS PASS. The dispatch defaults an omitted cwd
    //     to the analysis `dir` (the containment root the remediation just
    //     rewrote); an authored cwd passes through verbatim.
    const authoredCommand = playbook.verifier.command;
    const verifierCommand: VerifierCommand = {
      ...authoredCommand,
      ...(authoredCommand.timeoutMs === undefined
        ? { timeoutMs: DISPATCH_VERIFIER_TIMEOUT_MS }
        : {}),
      ...(authoredCommand.cwd === undefined ? { cwd: input.dir } : {}),
    };
    const verifier = await makePlaybookVerifier(deps.run)(verifierCommand);
    // The trace record carries the file rows in the exported SHAPE — the
    // engine's per-file diffs stay in the report, never bloat a trace line.
    const recordFiles = files.map((file) => ({
      file: file.file,
      edits: file.edits,
      digestAfter: file.digestAfter,
    }));
    if (verifier.verdict === 'pass') {
      const record: PlaybookDispatchRecord = {
        kind: 'playbook-dispatch',
        playbookId: playbook.id,
        targets,
        plannedEdits: applied.plannedEdits,
        unfixedMatches: applied.unfixedMatches,
        files: recordFiles,
        verifier,
        outcome: 'verified',
        quarantined: false,
      };
      return {
        status: 'ok',
        value: {
          outcome: 'verified',
          playbookId: playbook.id,
          targets,
          plannedEdits: applied.plannedEdits,
          unfixedMatches: applied.unfixedMatches,
          files,
          ...(applied.note === undefined ? {} : { note: applied.note }),
          record,
        },
      };
    }
    if (verifier.verdict === 'fail') {
      // The one quarantine entry path: an OBSERVED verifier failure. The
      // ledger record carries the verifier's reason verbatim — the evidence.
      deps.quarantine.quarantine(playbook.id, verifier.reason);
      // STEP 5: a remediation that provably did not hold is rolled back to
      // the pre-dispatch bytes before the status is decided, and the status
      // is NOT `ok` — see the module header for why the regressionGate
      // "verdict as decision output" precedent no longer applies. The
      // restore is CONDITIONAL and LOCKED: see `restoreTargets`. It spends
      // no nonce — the one write here that does not — and is bounded by a
      // content-fingerprint guard instead (STRANDED when bytes moved).
      const restore = await restoreTargets(
        deps.approval ?? DENY_ALL_APPROVALS,
        store,
        input.dir,
        preApply,
        files.map((file) => file.file),
        postApply,
      );
      const record: PlaybookDispatchRecord = {
        kind: 'playbook-dispatch',
        playbookId: playbook.id,
        targets,
        plannedEdits: applied.plannedEdits,
        unfixedMatches: applied.unfixedMatches,
        files: recordFiles,
        verifier,
        outcome: 'verifier-failed',
        quarantined: true,
        restore,
      };
      const unverified: PlaybookDispatchUnverified = {
        outcome: 'verifier-failed',
        playbookId: playbook.id,
        targets,
        plannedEdits: applied.plannedEdits,
        unfixedMatches: applied.unfixedMatches,
        files,
        ...(applied.note === undefined ? {} : { note: applied.note }),
        quarantined: true,
        verifierReason: verifier.reason,
        restore,
        record,
      };
      return {
        status: 'failed',
        error:
          `playbook '${playbook.id}': the verifier FAILED (${verifier.reason}) — the applied remediation did not hold. ${restoreProse(restore)} The playbook is QUARANTINED (quarantined: true); lifting the quarantine is an explicit human action. ` +
          `Dispatch evidence: ${JSON.stringify(unverified)}`,
      };
    }
    // 'indeterminate': an unobservable verdict must not punish the playbook
    // (module header) — NO quarantine record is written. The edits are
    // restored anyway (step 5): an unobservable verdict is not a licence to
    // leave unverified changes on disk, and leaving them there is what
    // forced the old "do NOT blindly re-run" warning. The frozen OpResult
    // taxonomy gives this status no value slot, so the trace record rides
    // `detail` as serialized JSON ({@link PlaybookDispatchRecord}).
    const restore = await restoreTargets(
      deps.approval ?? DENY_ALL_APPROVALS,
      store,
      input.dir,
      preApply,
      files.map((file) => file.file),
      postApply,
    );
    const record: PlaybookDispatchRecord = {
      kind: 'playbook-dispatch',
      playbookId: playbook.id,
      targets,
      plannedEdits: applied.plannedEdits,
      unfixedMatches: applied.unfixedMatches,
      files: recordFiles,
      verifier,
      outcome: 'verifier-indeterminate',
      quarantined: false,
      restore,
    };
    const unverified: PlaybookDispatchUnverified = {
      outcome: 'verifier-indeterminate',
      playbookId: playbook.id,
      targets,
      plannedEdits: applied.plannedEdits,
      unfixedMatches: applied.unfixedMatches,
      files,
      ...(applied.note === undefined ? {} : { note: applied.note }),
      quarantined: false,
      verifierReason: verifier.reason,
      restore,
      record,
    };
    return {
      status: 'indeterminate',
      detail:
        `playbook '${playbook.id}': the verifier's verdict is unobservable (${verifier.reason}) — ${restoreProse(restore)} The playbook is NOT quarantined (an unobservable verdict never punishes a playbook — I5)${restore.stranded.length === 0 ? ', and re-running the dispatch is now safe because the workspace is back at its pre-dispatch bytes' : ', but do NOT re-dispatch until the stranded files are inspected and repaired — re-applying the rule over them may not be idempotent'}. ` +
        `Dispatch evidence: ${JSON.stringify(unverified)}`,
    };
  };
  // IN-FLIGHT REJECTION (module header): each dispatch runs in the
  // registry's per-playbook-id slot; a same-playbook dispatch arriving
  // while another is unsettled is refused needs-human WITHOUT running —
  // never queued — so a duplicate can never re-apply the rule after a
  // PASS. Different playbooks stay unserialized.
  return (input) =>
    deps.playbooks
      .withDispatch(input.playbookId, () => dispatchOnce(input))
      .catch((err) => {
        if (err instanceof DispatchInFlightError) {
          return {
            status: 'needs-human',
            reason: `${err.message}; re-dispatch deliberately once the in-flight dispatch settles (a deliberate re-dispatch of a passed playbook is an explicit action, the same trust level as the first)`,
          } satisfies PlaybookDispatchResult;
        }
        throw err;
      });
}

/**
 * STEP 5: restore the pre-apply bytes of every file the apply rewrote,
 * through the SAME store the apply used (so containment, and the fault
 * behavior, are identical).
 *
 * TWO properties, both load-bearing, and the second one is a correction of
 * the first version of this function:
 *
 *  1. IT RUNS UNDER THE MUTATION LOCK. A restore is a write; running it
 *     after the lock was released at the end of the apply let a concurrent
 *     approved dispatch of ANOTHER playbook interleave its apply with this
 *     one's rollback.
 *  2. IT IS CONDITIONAL ON THE POST-APPLY BYTES (`expected`, the
 *     fingerprints read back inside the apply's own critical section). A
 *     file whose current bytes no longer match what THIS dispatch wrote
 *     belongs to someone else's edit — a concurrent playbook, a human, a
 *     hook — and a blind restore would silently delete it. Such a file is
 *     reported STRANDED, UNTOUCHED, with both digests, and the prose then
 *     refuses to claim the workspace is at its pre-dispatch state.
 *
 * The per-file outcome is honest in both directions: a file that could not
 * be restored (write fault) and a file deliberately not restored (conflict)
 * are both STRANDED, because from the caller's point of view they are the
 * same fact — "this file is not back to the pre-dispatch bytes, and here is
 * why".
 *
 * AND A LOCK FAULT IS A RESULT, NOT AN EXCEPTION. The mutation lock is a
 * real filesystem primitive, and it throws in three ordinary ways: the
 * waiter budget is exhausted (another writer holds it), the release fails,
 * or the artifact is compromised while held. Letting any of those reject
 * out of here would escape the op with NO result and NO evidence — the worst
 * possible outcome, because the applied edits are already on disk and the
 * caller would be left knowing nothing about them. So a lock fault is
 * caught and reported: EVERY applied file is marked STRANDED, because a
 * section whose exclusivity cannot be proven proves no restore, even one
 * whose bytes were already written back before the fault.
 */
async function restoreTargets(
  authority: ApprovalAuthority,
  store: AnalyzeFileStore,
  workspace: string,
  preApply: ReadonlyMap<string, Uint8Array>,
  rewritten: readonly string[],
  expected: ReadonlyMap<string, string>,
): Promise<PlaybookRestoreReport> {
  const restored: string[] = [];
  const stranded: Array<{ file: string; error: string }> = [];
  const ordered = [...rewritten].sort();
  const run = async (): Promise<void> => {
    for (const file of ordered) {
      const before = preApply.get(file);
      if (before === undefined) {
        // A file the apply reported but the capture did not hold: nothing to
        // restore from, and saying so is the honest report.
        stranded.push({ file, error: 'no pre-apply capture for this file' });
        continue;
      }
      // COMPARE BEFORE WRITE: the guard that keeps this restore from
      // clobbering a concurrent writer.
      let current: Uint8Array;
      try {
        current = await store.readBytes(file);
      } catch (err) {
        stranded.push({
          file,
          error: `could not read the current bytes to compare — ${messageOf(err)}`,
        });
        continue;
      }
      const currentFingerprint = contentFingerprint(current);
      const appliedFingerprint = expected.get(file);
      if (appliedFingerprint !== undefined && currentFingerprint !== appliedFingerprint) {
        stranded.push({
          file,
          error: `another writer changed this file while the verifier ran (this dispatch wrote ${String(appliedFingerprint)}, the file now holds ${currentFingerprint}) — NOT restored, because overwriting it would discard that writer's work`,
        });
        continue;
      }
      if (appliedFingerprint === undefined) {
        stranded.push({
          file,
          error: 'no post-apply fingerprint for this file, so a conditional restore is impossible',
        });
        continue;
      }
      try {
        await store.writeBytes(file, before);
        restored.push(file);
      } catch (err) {
        stranded.push({ file, error: messageOf(err) });
      }
    }
  };
  let held: { ok: true; value: void } | { ok: false; reason: string };
  try {
    held = await withMutationLock(authority, workspace, run);
  } catch (err) {
    // A LOCK FAULT (acquire exhausted, release failed, artifact
    // compromised). Nothing is claimed as restored: a section whose
    // exclusivity cannot be proven proves no restore, and every applied
    // file — including one whose bytes were already written back before the
    // fault — is reported with the reason, so the caller can never read a
    // clean rollback out of a run whose lock broke.
    return {
      attempted: ordered,
      restored: [],
      stranded: ordered.map((file) => ({
        file,
        error: `the workspace mutation lock faulted during the rollback (${messageOf(err)}) — the restore could not be run to a provable completion, so this file is not claimed as restored even if its pre-dispatch bytes were already written back`,
      })),
    };
  }
  if (!held.ok) {
    // No lock bound: the restore cannot be made safe, so it is NOT run and
    // every file is reported stranded with the reason.
    return {
      attempted: ordered,
      restored: [],
      stranded: ordered.map((file) => ({ file, error: held.reason })),
    };
  }
  return { attempted: ordered, restored, stranded };
}

/**
 * A post-apply re-read fault: the apply happened and the workspace is in an
 * unknown-to-us state, so no rollback may be attempted.
 */
class PostApplyReadFault extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'PostApplyReadFault';
  }
}

/**
 * The rollback prose, split by the one fact a reader must not have to
 * infer: a fully restored workspace is back at its pre-dispatch bytes; a
 * restore with a STRANDED file is NOT, and says which file.
 */
function restoreProse(restore: PlaybookRestoreReport): string {
  if (restore.stranded.length === 0) {
    return `the applied edits were ROLLED BACK to their pre-dispatch bytes (${restore.restored.length} file(s) restored) and the workspace is back at its pre-dispatch state.`;
  }
  return `the applied edits were ROLLED BACK where possible, but the restore FAILED for ${restore.stranded.map((entry) => `${entry.file} (${entry.error})`).join(', ')} — those files are STRANDED and the workspace is NOT at its pre-dispatch state; restored: ${restore.restored.length === 0 ? 'none' : restore.restored.join(', ')}.`;
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
