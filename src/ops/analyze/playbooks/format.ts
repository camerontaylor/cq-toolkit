// Analyze lane G3 — the authored-PLAYBOOK format, minimal v1: a playbook is
// a CONSUMER-AUTHORED remediation asset that binds an ast-grep rule (the
// codemod engine's rule — consumer config, never shipped by the toolkit) to
// a VERIFIER command, so a dispatch can prove (not assume) that the
// remediation it applied actually held.
//
//   PLAYBOOK = { schemaVersion, id, description,
//                rule: <ast-grep rule JSON object>,
//                verifier: { command: <gates CheckCommand> } }
//
// Invariants honored here (the rest of the lane builds on them):
//   - The verifier command REUSES the gates family's {@link CheckCommand}
//     shape verbatim (type alias + zod mirror pinned to it): the consumer
//     points it at ANY command (their test runner, their compiler, their
//     script) exactly the way gates.checkRunner points at a check tool. The
//     `timeoutMs` field is OPTIONAL with NO DEFAULT at the format level —
//     the playbook is a persisted consumer asset, not an op input; the
//     dispatch op boundary applies the 600_000 ms cap when the authored
//     command omits it, and an authored timeout passes through verbatim
//     (playbooks/registry.ts).
//   - `rule` is validated AS A JSON OBJECT and nothing more: the schema
//     requires a non-empty JSON object (finite numbers, no undefined
//     values — z.json() is the value schema), while every ast-grep semantic
//     (language coverage, pattern well-formedness, whether the rule carries
//     a `fix`) is the ENGINE's business at dispatch — a semantically dead
//     rule surfaces as an honest failed scan there, never as a format
//     rejection here and never as a fabricated success. The rule is carried
//     as a JSON OBJECT (not the engine's text form) so the asset is
//     programmatically authorable and validatable; dispatch serializes it
//     with JSON.stringify into the engine's `--inline-rules` text — JSON is
//     a valid YAML form (codemod/astGrep.ts), so this is exactly the rule
//     the engine would accept as text, byte for byte.
//   - `id` is PATTERN-validated only: it must be safe as a single CLI
//     token, a journal/trace key, and a sorted-list member. GLOBAL
//     UNIQUENESS IS THE PLAYBOOK REGISTRY'S JOB (playbooks/registry.ts
//     refuses a duplicate id at register time) — the format cannot see the
//     population of playbooks, so it deliberately does not pretend to.
//   - Strict schema: an unknown key in a playbook (or nested in its
//     verifier command) is a loud rejection, never silent config drift —
//     the same dispatch-boundary discipline the family registries apply.
import { z } from 'zod';
// TYPE-ONLY import: the verifier command is the gates CheckCommand SHAPE —
// the erased import keeps this module zod-only at runtime (the family
// registry's eager-import discipline).
import type { CheckCommand } from '../../gates/checkRunner.js';

/** The playbook schema version — the only one {@link PlaybookSchema} accepts. */
export const PLAYBOOK_SCHEMA_VERSION = 1;

/**
 * The playbook id pattern: 1–64 chars, starting alphanumeric, then
 * alphanumeric/`.`/`_`/`-`. Chosen so an id is safe everywhere it is
 * consumed as a bare token — a CLI argv member, a dispatch-trace key, a
 * quarantine-ledger sort key — with no whitespace or separator ambiguity.
 * Uniqueness across registrations is enforced by the playbook registry, not
 * here (the format cannot see the population).
 */
export const PLAYBOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The verifier command: the gates {@link CheckCommand} shape, reused
 * verbatim (module header). The consumer points it at whatever command
 * proves the playbook's remediation held (exit 0 = held, per
 * playbooks/verifier.ts). AUTHORED-OPTIONAL, DISPATCH-DEFAULTED: both
 * optional fields may be omitted in the asset, and the dispatch op
 * (playbooks/registry.ts) fills them at the OP boundary when absent —
 * `cwd` defaults to the analysis `dir` (an omitted cwd would inherit the
 * dispatching process's cwd, and exit 0 against the wrong tree is a
 * vacuous pass), `timeoutMs` to the gates' 600_000ms op-boundary default.
 * An authored value passes through verbatim.
 */
export type VerifierCommand = CheckCommand;

/**
 * The verifier command's zod mirror, PINNED to the gates CheckCommand type
 * at compile time (`z.ZodType<CheckCommand>`), so a gates-shape drift fails
 * this boundary's typecheck. Tightened beyond the library type in exactly
 * one way: a non-empty command string (an empty command can only spawn-
 * fail; it is malformed config, not a check that runs). `cwd` and
 * `timeoutMs` are `.exactOptional()` — an explicit `undefined` is not a
 * value, matching the frozen optional fields.
 */
export const VerifierCommandSchema: z.ZodType<VerifierCommand> = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).exactOptional(),
    timeoutMs: z.number().int().positive().exactOptional(),
  })
  .strict();

/** A consumer-authored remediation playbook (minimal v1 — module header). */
export interface Playbook {
  schemaVersion: typeof PLAYBOOK_SCHEMA_VERSION;
  /** Registry-unique id (pattern here; uniqueness at register time). */
  id: string;
  /** Human-facing description; never load-bearing. */
  description: string;
  /**
   * The consumer's ast-grep rule as a JSON object (non-empty; JSON values
   * only). Engine semantics are validated at dispatch, not here.
   */
  rule: Record<string, unknown>;
  /**
   * The command that decides whether the playbook REMAINS dispatchable.
   * Its `cwd`/`timeoutMs` are authored-optional; dispatch defaults an
   * omitted `cwd` to the analysis dir and an omitted `timeoutMs` to
   * 600_000ms (see {@link VerifierCommand}).
   */
  verifier: { command: VerifierCommand };
}

/** Any finite JSON value (the playbook rule object's value domain). */
const JsonValue: z.ZodType<unknown> = z.json();

/**
 * The strict playbook schema — the full asset, and only it. See the module
 * header for the documented invariants: pattern-only id (uniqueness is the
 * registry's job), rule as a non-empty JSON object (engine semantics at
 * dispatch), verifier command in the gates CheckCommand shape (optional
 * timeout, no default), strict unknown-key rejection at every level.
 */
export const PlaybookSchema: z.ZodType<Playbook> = z
  .object({
    schemaVersion: z.literal(PLAYBOOK_SCHEMA_VERSION),
    id: z
      .string()
      .regex(
        PLAYBOOK_ID_PATTERN,
        'playbook id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ (start alphanumeric; then alphanumerics, dots, underscores, dashes)',
      ),
    description: z.string().min(1).max(2000),
    rule: z.record(z.string(), JsonValue).refine((rule) => Object.keys(rule).length > 0, {
      message:
        'the ast-grep rule must be a non-empty JSON object (an empty object cannot be a rule)',
    }),
    verifier: z
      .object({
        command: VerifierCommandSchema,
      })
      .strict(),
  })
  .strict();
