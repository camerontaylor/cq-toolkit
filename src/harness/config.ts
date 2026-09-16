// Harness configuration — T1.4 slice 1 (R4: per-op CONFIG, not constants).
//
// Everything in this file is DATA. The tool surface (read/edit/run), their
// allowlists, timeouts, output caps, and the prompt budget are per-op
// configuration a caller composes — never hardcoded policy inside the
// executors (tools.ts reads this config and enforces exactly what it says).
// `defaultHarnessConfig` is the conservative baseline VALUE of that data,
// not policy baked into code:
//   - read + edit enabled over the whole workspace (pattern '**/*'),
//   - run enabled with an EMPTY command allowlist — every `run` call is
//     denied until a caller configures explicit command patterns,
//   - modest prompt caps (3 tools, 20k-char system prompt, 1k-char per-tool
//     description cap),
//   - the tool set is designed to pair with SandboxPolicy 'workspace-write'
//     (driver seam): the harness enforces the workspace boundary + allowlists
//     itself; true OS sandboxing stays a driver-specific concern (tools.ts).
//
// Schema style mirrors src/kernel/schema.ts: `.strict()` objects (unknown
// keys FAIL parsing instead of being silently stripped — the same
// vendor-vocabulary pollution guard as the kernel) and conservative bounds
// (cap fields are positive integers). Types are zod-INFERRED (this file is
// the single source of truth for both schemas and types; the harness has no
// separate hand-written mirror).
//
// Serializable: every type here is plain JSON data (strings, booleans,
// numbers, arrays) so a harness config can ride in an op input, a journal
// event, or a plan definition unchanged.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-tool config — the R4 data surface
// ---------------------------------------------------------------------------

/**
 * Config for a workspace-FILE tool (`read` or `edit`): on/off, which paths
 * it may touch (glob-ish pattern allowlist — see tools.ts for the matching
 * semantics), and an optional output cap in chars. `maxOutputChars` omitted
 * means UNCAPPED — `defaultHarnessConfig` always sets a modest value;
 * uncapped is a deliberate caller choice, never a silent default.
 */
export const FileToolConfigSchema = z
  .object({
    enabled: z.boolean(),
    pathPatterns: z.array(z.string()),
    maxOutputChars: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Config for the `run` tool: on/off, the command-pattern allowlist (an EMPTY
 * array denies every command — the conservative default), an optional
 * per-call wall-clock timeout in ms (mapped onto the child process's own
 * timeout; wall-clock POLICY above this stays with the driver/governor per
 * I8), and an optional output cap in chars.
 */
export const RunToolConfigSchema = z
  .object({
    enabled: z.boolean(),
    commandPatterns: z.array(z.string()),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputChars: z.number().int().positive().optional(),
  })
  .strict();

/** The harness tool surface: exactly read/edit/run, each configured per-op. */
export const HarnessToolConfigSchema = z
  .object({
    read: FileToolConfigSchema,
    edit: FileToolConfigSchema,
    run: RunToolConfigSchema,
  })
  .strict();

/**
 * Per-op prompt budget (R4): all values are DATA applied where the prompt is
 * composed — `maxSystemPromptChars` bounds the composed system prompt
 * (enforced by the driver layer, slice 2), `maxTools` bounds how many tools
 * `buildTools` returns, `maxToolDescriptionChars` bounds each tool's
 * description text (enforced at build time, head-truncation).
 */
export const PromptBudgetConfigSchema = z
  .object({
    maxSystemPromptChars: z.number().int().positive(),
    maxTools: z.number().int().positive(),
    maxToolDescriptionChars: z.number().int().positive(),
  })
  .strict();

/**
 * The full harness config: tool surface + prompt budget + the root directory
 * fresh temp workspaces are created under (`workspaceRoot` omitted → the
 * harness default of `os.tmpdir()/cq-harness`, see session.tempWorkspace).
 */
export const HarnessConfigSchema = z
  .object({
    tools: HarnessToolConfigSchema,
    promptBudget: PromptBudgetConfigSchema,
    workspaceRoot: z.string().optional(),
  })
  .strict();

export type FileToolConfig = z.infer<typeof FileToolConfigSchema>;
export type RunToolConfig = z.infer<typeof RunToolConfigSchema>;
export type HarnessToolConfig = z.infer<typeof HarnessToolConfigSchema>;
export type PromptBudgetConfig = z.infer<typeof PromptBudgetConfigSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

// ---------------------------------------------------------------------------
// Conservative defaults
// ---------------------------------------------------------------------------

/**
 * Deep-freeze a plain-data value in place (recursively — objects and arrays)
 * and return it. Shared default CONFIG must be immutable: a caller mutating
 * a nested object of `defaultHarnessConfig` would otherwise silently change
 * every later consumer's behavior — freezing makes that write THROW loudly
 * (strict mode) instead of poisoning the shared default.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The conservative baseline harness config (parsed through the schema so it
 * can never drift out of validity). read + edit over the whole workspace;
 * run enabled but DENY-ALL until command patterns are configured; modest
 * prompt caps. IMMUTABLE BY CONSTRUCTION — deep-frozen, so a nested write
 * throws instead of mutating the shared baseline value.
 */
export const defaultHarnessConfig: HarnessConfig = deepFreeze(
  HarnessConfigSchema.parse({
    tools: {
      read: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 200_000 },
      edit: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 4_000 },
      run: {
        enabled: true,
        commandPatterns: [], // deny-all until a caller configures patterns (R4)
        timeoutMs: 30_000,
        maxOutputChars: 100_000,
      },
    },
    promptBudget: {
      maxSystemPromptChars: 20_000,
      maxTools: 3, // read/edit/run — inert at the default, enforced if tightened
      maxToolDescriptionChars: 1_024,
    },
  }),
);
