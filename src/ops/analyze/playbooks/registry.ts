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
//      rollback. The engine primitive's `approved: true` is satisfied
//      INTERNALLY here, and that is not a bypass: the gates that matter for
//      a playbook dispatch live AROUND the engine — the quarantine consult
//      before it, the playbook's own verifier after it — and dispatch is a
//      consumer-invoked op (authored asset, registered by id, dispatched by
//      id) that is NEVER present in the shipped analyze plan, so the plan
//      runner's autonomous path cannot reach it (UC §1 row 9). Any engine
//      fault (scan parse, collision, write/rollback) is a `failed` dispatch
//      with nothing verified and NO quarantine — the playbook did not fail
//      its verifier; the machinery failed before one could run.
//   4. THE VERIFIER — the playbook's command runs through the injected
//      verifier (playbooks/verifier.ts) and the verdict decides the
//      dispatch outcome AND the playbook's quarantine state:
//        - 'pass'          → `ok`, outcome 'verified'.
//        - 'fail'          → the playbook is QUARANTINED (a ledger record
//          carrying the verifier's reason) and the dispatch returns `ok`
//          with outcome 'verifier-failed' and `quarantined: true` — the
//          honest report of a real state: the remediation WAS applied and
//          it provably did NOT hold. The status mapping follows the
//          regressionGate precedent: a definitive verdict is the op's
//          DECISION OUTPUT, not an op failure — the full evidence rides the
//          structured value, which a bare `failed` error string could not
//          carry. An `ok` here never means "the remediation held"; the
//          `outcome` discriminator is the verdict.
//        - 'indeterminate' → the dispatch returns `indeterminate` — an
//          unobservable verdict must not PUNISH the playbook (no
//          quarantine) any more than it may PASS it (I5). The prose says
//          plainly that edits were applied but are unverified.
//
// THE TRACE CUT (journal-record shape): every dispatch is supposed to leave
// a journal record, but the kernel journal seam (src/kernel/journal.ts) is
// PLAN-RUN-SHAPED — the frozen JournalEventSchema union has no standalone
// dispatch event, and append() requires event.runId to match the file's
// run; faking a runId/jobId would poison the resume fold's per-job facts.
// So v1 RETURNS the dispatch record in the result instead: the exported
// {@link PlaybookDispatchRecord} shape rides `value.record` on the two `ok`
// outcomes. The frozen OpResult taxonomy gives `indeterminate` no value
// slot, so there the record rides `detail` as serialized JSON (same shape);
// an early `failed` termination (steps 1–3) records no trace beyond the
// error string — nothing was applied, nothing was quarantined, and the
// taxonomy has no payload slot. The full `trace` query op and a durable
// dispatch journal are post-v1 (recorded in the family NOTES.md).
import type { Op, OpResult } from '../../../kernel/types.js';
import type { RunCheck } from '../../gates/checkRunner.js';
import type { AnalyzeFileStore } from '../analysisStore.js';
import type { CodemodFileApplied } from '../codemod/astGrep.js';
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
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
    return { status: 'ok', value: { id: input.playbook.id, total: playbooks.list().length } };
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
  return async () => ({ status: 'ok', value: { records: quarantine.records() } });
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
}

/** The dispatch report for a VERIFIER-OBSERVED outcome (both `ok` statuses are definitive verdicts — module header). */
export type PlaybookDispatchOutcome =
  | {
      outcome: 'verified';
      playbookId: string;
      targets: string[];
      plannedEdits: number;
      unfixedMatches: number;
      files: CodemodFileApplied[];
      note?: string;
      record: PlaybookDispatchRecord;
    }
  | {
      outcome: 'verifier-failed';
      playbookId: string;
      targets: string[];
      plannedEdits: number;
      unfixedMatches: number;
      files: CodemodFileApplied[];
      note?: string;
      /** Always true on this outcome: the failed verdict WROTE the quarantine record. */
      quarantined: true;
      /** The verifier's failure reason — the same string the ledger record carries. */
      verifierReason: string;
      record: PlaybookDispatchRecord;
    };

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
      return { status: 'failed', error: `playbook dispatch: ${messageOf(err)}` };
    }
    const targets = [...new Set(input.targets)].sort();
    const codemod = makeAstGrepCodemod(deps.run, () => store);
    const engineResult = await codemod({
      dir: input.dir,
      rule: JSON.stringify(playbook.rule),
      files: targets,
      dryRun: false,
      // The engine primitive's approval flag, satisfied internally — the
      // approval gates that matter live AROUND it (module header, step 3).
      approved: true,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    if (engineResult.status !== 'ok') {
      // Unreachable by construction (approved: true, dryRun: false — and the
      // engine never returns budget-exhausted/indeterminate), but the frozen
      // taxonomy allows them, so they pass through honestly rather than
      // being collapsed into a fabricated verdict.
      return engineResult;
    }
    const applied = engineResult.value;
    if (applied.mode !== 'applied') {
      // Unreachable: dispatch always runs the apply mode (dryRun: false).
      return { status: 'failed', error: 'playbook dispatch: the engine returned a dry-run report' };
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
      };
      return {
        status: 'ok',
        value: {
          outcome: 'verifier-failed',
          playbookId: playbook.id,
          targets,
          plannedEdits: applied.plannedEdits,
          unfixedMatches: applied.unfixedMatches,
          files,
          ...(applied.note === undefined ? {} : { note: applied.note }),
          quarantined: true,
          verifierReason: verifier.reason,
          record,
        },
      };
    }
    // 'indeterminate': an unobservable verdict must not punish the playbook
    // (module header) — NO quarantine record is written, and the dispatch is
    // honest that the edits ARE on disk but UNVERIFIED. The frozen OpResult
    // taxonomy gives this status no value slot, so the trace record rides
    // `detail` as serialized JSON ({@link PlaybookDispatchRecord}).
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
    };
    return {
      status: 'indeterminate',
      detail:
        `playbook '${playbook.id}': the verifier's verdict is unobservable (${verifier.reason}) — the remediation edits are ALREADY ON DISK (${String(applied.plannedEdits)} planned edit(s) across ${String(files.length)} file(s)) and remain UNVERIFIED; the playbook is NOT quarantined (an unobservable verdict never punishes a playbook — I5). ` +
        `Do NOT blindly re-run the dispatch: it would RE-APPLY the rule over the already-edited targets, which is safe only when the rule's fix is idempotent — re-run the VERIFIER on its own instead. ` +
        `Dispatch record: ${JSON.stringify(record)}`,
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

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
