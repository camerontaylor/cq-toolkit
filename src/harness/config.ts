// Harness configuration — T1.4 slice 1 (R4: per-op CONFIG, not constants).
//
// Everything in this file is DATA. The tool surface (read/edit/write/bash),
// their allowlists, timeouts, output caps, and the prompt budget are per-op
// configuration a caller composes — never hardcoded policy inside the
// executors (tools.ts reads this config and enforces exactly what it says).
// `defaultHarnessConfig` is the conservative baseline VALUE of that data,
// not policy baked into code:
//   - read + edit + write enabled over the whole workspace (pattern '**/*'),
//   - bash enabled with an EMPTY command allowlist — every `bash` call is
//     denied until a caller configures explicit command patterns,
//   - modest prompt caps (4 tools, 20k-char system prompt, 1k-char per-tool
//     description cap),
//   - the tool set is designed to pair with SandboxPolicy 'workspace-write'
//     (driver seam): the harness enforces the workspace boundary + allowlists
//     itself; true OS sandboxing stays a driver-specific concern (tools.ts).
//
// ONE-RELEASE LEGACY ALIAS: the shell tool is canonically `bash` (the
// convention every reference harness uses). The pre-F1 config key `tools.run`
// and the model-facing tool name `run` are still accepted and normalised to
// `bash`; both go away after the release that ships this migration.
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
import { deepFreeze } from '../shared/deepFreeze.js';

// ---------------------------------------------------------------------------
// Per-tool config — the R4 data surface
// ---------------------------------------------------------------------------

/**
 * Config for a workspace-FILE tool (`read`, `edit` or `write`): on/off,
 * which paths it may touch (glob-ish pattern allowlist — see tools.ts for
 * the matching semantics), and an optional output cap in chars.
 * `maxOutputChars` omitted means UNCAPPED — `defaultHarnessConfig` always
 * sets a modest value; uncapped is a deliberate caller choice, never a
 * silent default.
 */
export const FileToolConfigSchema = z
  .object({
    enabled: z.boolean(),
    pathPatterns: z.array(z.string()),
    maxOutputChars: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Config for the `bash` tool (the canonical shell tool): on/off, the
 * command-pattern allowlist (an EMPTY array denies every command — the
 * conservative default), an optional per-call wall-clock timeout in ms
 * (mapped onto the child process's own timeout; wall-clock POLICY above this
 * stays with the driver/governor per I8), and an optional output cap in
 * chars. A model-supplied per-call timeout may only SHORTEN this policy
 * bound, never extend it.
 */
export const BashToolConfigSchema = z
  .object({
    enabled: z.boolean(),
    commandPatterns: z.array(z.string()),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputChars: z.number().int().positive().optional(),
  })
  .strict();

/** The pre-F1 name for {@link BashToolConfig} — accepted for one release. */
export const RunToolConfigSchema = BashToolConfigSchema;

/** A fresh conservative `write` config (enabled over the workspace). */
const defaultWriteToolConfig = (): FileToolConfig => ({
  enabled: true,
  pathPatterns: ['**/*'],
  maxOutputChars: 4_000,
});

/** A fresh conservative `bash` config (enabled, deny-all until configured). */
const defaultBashToolConfig = (): BashToolConfig => ({
  enabled: true,
  commandPatterns: [], // deny-all until a caller configures patterns (R4)
  timeoutMs: 30_000,
  maxOutputChars: 100_000,
});

/**
 * The harness tool surface: read/edit/write/bash, each configured per-op.
 * `write` is optional in INPUT (an older config keeps parsing; the default
 * enables it). `bash` is canonical; the pre-F1 `run` key is accepted as a
 * one-release alias and normalised, and naming BOTH is a loud config error.
 */
export const HarnessToolConfigSchema = z
  .object({
    read: FileToolConfigSchema,
    edit: FileToolConfigSchema,
    write: FileToolConfigSchema.optional(),
    bash: BashToolConfigSchema.optional(),
    /** Pre-F1 alias for `bash` — accepted for one release. */
    run: BashToolConfigSchema.optional(),
  })
  .strict()
  .superRefine((tools, ctx) => {
    if (tools.bash !== undefined && tools.run !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'tools.bash and the legacy tools.run alias are mutually exclusive',
        path: ['run'],
      });
    }
  })
  .transform((tools) => ({
    read: tools.read,
    edit: tools.edit,
    write: tools.write ?? defaultWriteToolConfig(),
    bash: tools.bash ?? tools.run ?? defaultBashToolConfig(),
  }));

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
    /** Opt-in ai-sdk session diagnostics; undefined has the same effect as false. */
    logToolFailures: z.boolean().optional(),
  })
  .strict();

export type FileToolConfig = z.infer<typeof FileToolConfigSchema>;
export type BashToolConfig = z.infer<typeof BashToolConfigSchema>;
/** The pre-F1 name for {@link BashToolConfig} — accepted for one release. */
export type RunToolConfig = BashToolConfig;
export type HarnessToolConfig = z.infer<typeof HarnessToolConfigSchema>;
export type PromptBudgetConfig = z.infer<typeof PromptBudgetConfigSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

// ---------------------------------------------------------------------------
// Conservative defaults
// ---------------------------------------------------------------------------

/**
 * The conservative baseline harness config (parsed through the schema so it
 * can never drift out of validity). read + edit + write over the whole
 * workspace; bash enabled but DENY-ALL until command patterns are
 * configured; modest prompt caps. IMMUTABLE BY CONSTRUCTION — deep-frozen,
 * so a nested write throws instead of mutating the shared baseline value.
 *
 * Tool ORDER is deliberate: read, edit, bash, write. The pre-F1 surface was
 * read/edit/run, so an explicit `maxTools: 3` still yields read/edit/bash —
 * the new `write` tool is the one a tight budget sheds first. The default
 * budget also reserves room for read-only `grep` and `glob`.
 */
export const defaultHarnessConfig: HarnessConfig = deepFreeze(
  HarnessConfigSchema.parse({
    logToolFailures: false,
    tools: {
      read: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 200_000 },
      edit: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 4_000 },
      bash: defaultBashToolConfig(),
      write: defaultWriteToolConfig(),
    },
    promptBudget: {
      maxSystemPromptChars: 20_000,
      maxTools: 6, // read/edit/bash/write plus read-only grep/glob
      maxToolDescriptionChars: 1_024,
    },
  }),
);
