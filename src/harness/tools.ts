// Toolkit-owned minimal tool set — T1.4 slice 1, canonical names from F1
// (read/edit/write/bash, per-op allowlists). The pre-F1 `run` name and the
// pre-F1 edit arguments are accepted as one-release aliases; see
// canonicalToolName/toolAliases and the edit input schema below.
// Search/read ergonomics follow OpenCode v1.19.4 (MIT), especially
// packages/opencode/src/tool/{read,grep,glob}.ts; binary/UTF-8 handling also
// follows jcode v0.99.1 (MIT), crates/jcode-app-core/src/tool/read.rs.
// Pinned notices and source revisions: policy/THIRD_PARTY_NOTICES.md.
//
// R4: existing tool surface and budgets are PER-OP CONFIG (data from
// config.ts). New search tools use fixed safety ceilings in this experiment
// (candidate count/bytes, matches, output/line chars, timeout); these are
// documented below and are not claimed to be per-op knobs. Tool descriptors
// remain driver-agnostic plain data with no vendor imports in src/harness/**.
//
// THE SHARED RUN GATE (W1.11 / D14): every surface that builds these tools —
// the ai-sdk driver, the subprocess driver's harness surface, the MCP harness
// surface — reaches the same decision through `buildTools(..., gate)`. The
// default gate is `harnessRunGate()` (src/sandbox), which withholds `bash`
// entirely whenever the environment expresses a CQ_SANDBOX policy and no
// certified launcher backs it, so a driver choice cannot bypass the policy.
// A withheld bash tool is OMITTED, not denied: an unreachable tool never
// reaches child_process.
//
// THE LAUNCHER ENV SCRUB: an allowed command's child gets a default-deny
// environment (src/sandbox `buildSandboxLauncherEnv`): a small launcher
// allowlist plus the names the gate's policy passed through, and never a
// `CQ_*` knob — a model-directed child cannot reconfigure its own boundary.
//
// DENIAL FLOW — executors never throw. Every refusal (sandbox, bad input,
// path escape (lexical or via symlink), allowlist miss, shell metacharacters
// under a token pattern, missing file, missing target text, failed command
// spawn) is a structured denial record `{ tool, reason }` — exactly
// the FROZEN driver-seam ToolDenial shape, so denials flow into
// WorkerResult.denials verbatim. Denial reasons are human-readable strings
// starting with the stable failure code shared with session evidence.
// The vocabulary lives in failures.ts and is documented in README.md.
//
// EDIT/WRITE CORRECTNESS (F1): edit refuses an ambiguous target unless
// `replace_all` is true, requires a prior `read` of the same resolved file,
// and re-hashes the bytes to refuse a file that changed since that read.
// Matching runs in LF space with the file's BOM and dominant line ending
// restored on write; binary (NUL in the first 8 KiB) and invalid-UTF-8
// files are refused. read/edit/write serialize per resolved path, so two
// calls in one model step cannot interleave their verify-and-write
// sequence. `write` may create a new file without a read; overwriting an
// existing file takes the same prior-read and staleness checks as edit.
//
// ENFORCEMENT ORDER per call: sandbox gate → input schema → workspace
// containment (lexical, then symlink realpath re-check) → config allowlist →
// execution (fs / child_process). Each step short-circuits into a denial.
//
// SANDBOX MAPPING + TRUST BOUNDARY (driver seam SandboxLevel; issue #28):
// sandboxPolicy governs the TOOL SURFACE — which tools exist, and what
// read/edit/write may touch via the lexical + realpath path guards below. `bash`
// commands execute with HOST PRIVILEGES, scoped to the cwd convention only
// (cwd = workspace); the command allowlist (token patterns / anchored re:)
// is the additional GATE over what may run, never a confinement of how.
// 'workspace-write' does NOT confer OS-level confinement: there is no
// sandbox-exec/landlock/bwrap in v1 — OS-sandbox enforcement is the
// recorded T1.8 strategy question.
//   - 'read-only'       → `edit`/`write`/`bash` deny with 'PATH_DENIED: sandbox: read-only'; `read`
//                         stays available.
//   - 'none' | 'workspace-write' → tools behave per config.
//
// SYMLINK CHANNEL (named limitation + partial hardening): containment is
// lexical, and the `bash` tool is the SYMLINK-PLANTING VECTOR — an allowlisted
// command can create a symlink inside the workspace pointing outside
// (`ln -s /etc passwd`), after which read/edit through the link would cross
// the boundary. Partial hardening: read/edit REALPATH the resolved path and
// re-check containment when the file exists (against the workspace's own
// realpath, so symlinked tmp roots don't false-positive) — pre-existing
// symlinks are caught with 'PATH_ESCAPE: path escape: … through a symlink'. A symlink
// planted/swapped in AFTER that check is a documented TOCTOU window.
// Mitigation: keep run command allowlists tight (never allowlist `ln`); a
// realpath-based jail is the follow-up.
//
// SYMLINK vs PATH ALLOWLIST: the read/edit allowlist is checked against BOTH
// the lexical workspace-relative path AND the realpath-derived one (relative
// to the workspace's realpathed root) — a symlink INSIDE the workspace must
// not bless its target's location (pattern 'src/**', link src/link →
// ../secret.txt). Denies when either check misses.
//
// SEARCH TOCTOU (same partial-hardening limit): grep/glob enumerate names,
// then apply these lexical/realpath/.git/path-pattern gates before reading
// any allowed file. `rg` later opens the gated realpath strings; a file or
// ancestor replaced after its check can still redirect or change that open.
// This is the same check-then-use window as read/edit, not an fd-pinned or
// OS-level sandbox. Cancellation is checked during enumeration/gating and
// before success, but it does not close this filesystem race.
//
// PATH PATTERN SEMANTICS (the read/edit allowlist): glob-ish strings matched
// against the workspace-relative POSIX path ('/' separators), FULL match:
//   - '**' spans whole path segments (zero or more; as the last segment it
//     matches everything below, e.g. 'src/**' matches 'src' itself too),
//   - '*' matches any chars WITHIN one segment (never crosses '/'),
//   - '?' matches one non-separator char; everything else is literal.
//
// COMMAND PATTERN SEMANTICS (the run allowlist), matched against the FULL
// command string, case-sensitive:
//   - 're:<js regex>'  → the rest is a JavaScript RegExp tested against the
//     command string. re: patterns are the ESCAPE HATCH for anything beyond
//     plain prefixes: a re: match allows OUTRIGHT (including commands with
//     shell metacharacters), so a re: pattern MUST be authored anchored
//     (e.g. 're:^npm test.*$') — an unanchored re: is author error
//     (recorded finding; documentation-covered, not code-repaired). Broad
//     regexes can also authorize disguised git verbs (git "diff"): the
//     closed-form lock covers literal diff/log prefixes, not shell aliases.
//     Leading literal diff/log words are locked even with attached shell
//     operators or substitutions, including backticks and $(...).
//   - anything else    → whitespace-token PREFIX: the pattern's tokens must
//     equal the command's leading tokens ('npm test' allows 'npm test' and
//     'npm test -- --watch', not 'npm run test'). Token splitting is naive
//     whitespace splitting — quoting is NOT parsed.
//     SHELL-METACHARACTER GUARD: a token-pattern match allows only a command
//     FREE of shell metacharacters (';' '&' '|' '$' '`' '(' ')' '<' '>'
//     newline). The exec shell would otherwise interpret sequences the
//     token prefix never saw ('npm test ; whoami', 'npm test && curl …',
//     'npm test $(rm -rf ~)'); such a command denies with the distinct
//     'CMD_DENIED: command allowlist: shell metacharacters …' reason pointing at
//     anchored re: patterns as the deliberate escape hatch.
// Token patterns must contain plain shell words; git requires a literal
// subcommand (never bare git, global options, wrapped git or a path to git).
// Invalid patterns throw at `buildTools`
// time — config corruption is a loud error, never a silent allow-all.
//
// Closed-form git diff/log select constant argv and spawn with shell:false.
// Other `run` commands use the platform shell so pipelines work; the
// allowlist is the gate over the whole command string. Each command runs in
// its OWN PROCESS GROUP (POSIX `detached`), so a timeout, an abort
// (`execute(input, { signal })`) or a harness shutdown kills the whole group
// with SIGKILL — `npm test → node` grandchildren included, which `exec`
// (killing only `/bin/sh`) could not reach. A kill reports exitCode null +
// the killed flag. Captured output is retained up to a byte bound per
// stream and head-truncated to maxOutputChars with `truncated: true` — a
// noisy command is truncated, never denied. read/edit have no
// wall-clock of their own: local fs ops need no timer, and wall-clock POLICY
// belongs to the driver/governor (I8) — hence FileToolConfig carries only an
// output cap.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { stripMetaSchema } from '../shared/json-schema.js';
import type { SandboxLevel, ToolDenial } from '../driver/types.js';
import { buildChildEnv } from '../shared/proc.js';
import { messageOf } from '../shared/messageOf.js';
import { invalidToolInput } from './failures.js';
import { runArgvCommand, runShellCommand } from './run.js';
import type { RunCommandOptions, RunOutcome } from './run.js';
import { registerProcessSignalCleanup } from '../shared/process-signals.js';
import { buildSandboxLauncherEnv, harnessRunGate } from '../sandbox/index.js';
import type { HarnessRunGate } from '../sandbox/index.js';
import { HarnessConfigSchema } from './config.js';
import type { HarnessConfig } from './config.js';

/** POSIX platforms get process-group kill semantics (mirror of run.ts). */
const POSIX_SEARCH = process.platform !== 'win32';

/**
 * Per-stream retention bound for `run` when the config sets no output cap:
 * "uncapped" means no truncation of the result text up to this bound, never
 * unbounded memory (the old `exec` path capped at its 1 MiB maxBuffer).
 */
const UNCAPPED_RETENTION_BYTES = 1_048_576;
const DEFAULT_READ_LIMIT = 2_000;
const MAX_READ_LINE_CHARS = 2_000;
const SEARCH_CANDIDATE_LIMIT = 1_000;
const SEARCH_CANDIDATE_OUTPUT_BYTES = 4 * 1_024 * 1_024;
// Streaming include-path enumeration bounds (CR @5ef68b24): TRAVERSAL WORK
// limits, not retention — how much rg output may be CONSUMED (streamed and
// discarded) while looking for matching candidates, before failing closed.
// Retention stays bounded separately (lexical top-N match buffer).
const SEARCH_GREP_ENUM_STREAM_BYTES = 32 * 1_024 * 1_024;
const SEARCH_GREP_ENUM_STREAM_PATHS = 1_000_000;
const SEARCH_BYTES_LIMIT = 20 * 1_024 * 1_024;
const SEARCH_MATCH_LIMIT = 100;
const SEARCH_OUTPUT_CHARS = 50_000;
const SEARCH_LINE_CHARS = 2_000;
const SEARCH_PROCESS_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const SEARCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Tool inputs — zod schemas, exported for driver adapters
// ---------------------------------------------------------------------------

/** Aliases may repeat the same value, but never select a conflicting value. */
function checkAliases(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
  names: readonly string[],
  required = false,
): void {
  const supplied = names.filter((name) => value[name] !== undefined);
  if (required && supplied.length === 0)
    ctx.addIssue({ code: 'custom', message: `requires ${names[0]}`, path: [names[0]!] });
  if (supplied.some((name) => value[name] !== value[supplied[0]!]))
    ctx.addIssue({ code: 'custom', message: `conflicting aliases: ${names.join('/')}` });
}

export const ReadToolInputSchema = z
  .object({
    file_path: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    checkAliases(value, ctx, ['file_path', 'filePath', 'path'], true);
  });

export const GrepToolInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    include: z.string().min(1).optional(),
    ignore_case: z.boolean().optional(),
    '-i': z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    head_limit: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    checkAliases(value, ctx, ['glob', 'include']);
    checkAliases(value, ctx, ['ignore_case', '-i', 'ignoreCase']);
  });

export const GlobToolInputSchema = z
  .object({ pattern: z.string().min(1), path: z.string().min(1).optional() })
  .strict();

/**
 * The canonical edit arguments (the convention shared by Claude Code, jcode
 * and dsh). `replace_all` is the explicit opt-in for a non-unique target:
 * without it, an ambiguous match is REFUSED rather than silently replacing
 * the first occurrence (the live correctness bug F1 fixes).
 */
export const CanonicalEditToolInputSchema = z
  .object({
    file_path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  })
  .strict();

/** The pre-F1 edit arguments — accepted for one release, normalised. */
export const LegacyEditToolInputSchema = z
  .object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
  })
  .strict();

/**
 * The compatibility edit shape. Every field is optional at the JSON-schema
 * level so ONE object can carry either argument spelling (a union would
 * break the Claude SDK's raw-shape registration); the refinement below
 * enforces the required combination, and the executor re-checks it.
 */
export const EditToolInputSchema = z
  .object({
    file_path: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    old_string: z.string().min(1).optional(),
    oldString: z.string().min(1).optional(),
    oldText: z.string().min(1).optional(),
    new_string: z.string().optional(),
    newString: z.string().optional(),
    newText: z.string().optional(),
    replace_all: z.boolean().optional(),
    replaceAll: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    checkAliases(value, ctx, ['file_path', 'filePath', 'path'], true);
    checkAliases(value, ctx, ['old_string', 'oldString', 'oldText'], true);
    checkAliases(value, ctx, ['new_string', 'newString', 'newText'], true);
    checkAliases(value, ctx, ['replace_all', 'replaceAll']);
  });

export const WriteToolInputSchema = z
  .object({
    file_path: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    content: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    checkAliases(value, ctx, ['file_path', 'filePath', 'path'], true);
  });

export const BashToolInputSchema = z
  .object({
    command: z.string().min(1),
    timeout: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    description: z.string().optional(),
    workdir: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    run_in_background: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    checkAliases(value, ctx, ['timeout', 'timeoutMs']);
    checkAliases(value, ctx, ['workdir', 'cwd']);
    if (value.run_in_background === true)
      ctx.addIssue({
        code: 'custom',
        message: 'UNSUPPORTED: run_in_background: true is not supported',
      });
  });

/** The pre-F1 name for {@link BashToolInputSchema} — accepted for one release. */
export const RunToolInputSchema = BashToolInputSchema;

export type ReadToolInput = z.infer<typeof ReadToolInputSchema>;
export type GrepToolInput = z.infer<typeof GrepToolInputSchema>;
export type GlobToolInput = z.infer<typeof GlobToolInputSchema>;
export type CanonicalEditToolInput = z.infer<typeof CanonicalEditToolInputSchema>;
export type LegacyEditToolInput = z.infer<typeof LegacyEditToolInputSchema>;
export type EditToolInput = z.infer<typeof EditToolInputSchema>;
export type WriteToolInput = z.infer<typeof WriteToolInputSchema>;
export type BashToolInput = z.infer<typeof BashToolInputSchema>;
/** The pre-F1 name for {@link BashToolInput} — accepted for one release. */
export type RunToolInput = BashToolInput;

/** The read-only search tools join the canonical toolkit surface for read-only ops. */
export type ToolkitToolName = 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob';

/** The pre-F1 model-facing tool name — accepted for one release. */
export type LegacyToolName = 'run';

/** Pre-F1 tool name → canonical name (`run` → `bash`); all others unchanged. */
export function canonicalToolName(name: string): string {
  return name === 'run' ? 'bash' : name;
}

/** Canonical tool name → its accepted one-release aliases. */
export function toolAliases(name: string): readonly string[] {
  return name === 'bash' ? ['run'] : [];
}

// ---------------------------------------------------------------------------
// Tool results + descriptors — plain data, driver-agnostic
// ---------------------------------------------------------------------------

/**
 * One tool execution's outcome. Success carries the (possibly capped) text
 * output plus run-only extras (`exitCode` is null when the process died by
 * signal). Every non-success is a DENIAL: `{ denial }` is exactly the frozen
 * driver-seam ToolDenial `{ tool, reason }`.
 */
export type ToolkitToolResult =
  | {
      ok: true;
      output: string;
      truncated: boolean;
      /** Source text and workspace-relative path provenance for the upload guard. */
      sourceContents?: readonly { text: string; path: string }[];
      /** `bash` only: 0–nonzero on a normal exit, null when signal-killed. */
      exitCode?: number | null;
      /** `bash` only: true when the process was killed by a signal (timeout). */
      killed?: boolean;
    }
  | { ok: false; denial: ToolDenial };

/**
 * Per-call execution options (additive). `signal` cancels an in-flight
 * call: `bash` kills the command's whole process group; read/edit/write are
 * local fs ops that finish on their own and ignore it.
 */
export interface ToolExecuteOptions {
  signal?: AbortSignal | undefined;
}

/**
 * One harness tool, SELF-CONTAINED plain data: name, description, input
 * schema (zod), and an executor bound to the workspace the tools were built
 * for. `execute` accepts `unknown` (adapters may pass unparsed payloads) and
 * validates internally — it never throws; failures come back as denials.
 */
export type ToolkitTool =
  | {
      name: 'read';
      description: string;
      inputSchema: typeof ReadToolInputSchema;
      execute(input: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult>;
      /** One-release pre-F1 aliases the driver may also register. */
      aliases?: readonly string[];
    }
  | {
      name: 'edit';
      description: string;
      inputSchema: typeof EditToolInputSchema;
      execute(input: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult>;
      aliases?: readonly string[];
    }
  | {
      name: 'write';
      description: string;
      inputSchema: typeof WriteToolInputSchema;
      execute(input: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult>;
      aliases?: readonly string[];
    }
  | {
      name: 'bash';
      description: string;
      inputSchema: typeof BashToolInputSchema;
      execute(input: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult>;
      /** `run` — the pre-F1 name, accepted for one release. */
      aliases?: readonly string[];
    }
  | {
      name: 'grep';
      description: string;
      inputSchema: typeof GrepToolInputSchema;
      execute(input: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult>;
    }
  | {
      name: 'glob';
      description: string;
      inputSchema: typeof GlobToolInputSchema;
      execute(input: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult>;
    };

/** Canonical request schemas exclude compatibility aliases from the model prompt. */
export const AdvertisedToolInputSchemas = {
  read: z
    .object({
      file_path: z.string().min(1),
      offset: z.number().int().positive().optional().describe('First line, 1-based'),
      limit: z.number().int().positive().optional().describe('Lines; default 2000'),
    })
    .strict(),
  grep: z
    .object({
      pattern: z.string().min(1),
      path: z.string().min(1).optional(),
      glob: z.string().min(1).optional(),
      ignore_case: z.boolean().optional(),
      output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
      head_limit: z.number().int().nonnegative().optional().describe('0 uses safety cap'),
    })
    .strict(),
  glob: z
    .object({
      pattern: z.string().min(1),
      path: z.string().min(1).optional(),
    })
    .strict(),
  edit: CanonicalEditToolInputSchema.extend({
    file_path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  write: z
    .object({
      file_path: z.string().min(1),
      content: z.string(),
    })
    .strict(),
  bash: z
    .object({
      command: z.string().min(1),
      timeout: z.number().int().positive().optional(),
      description: z.string().optional(),
      workdir: z.string().min(1).optional(),
      run_in_background: z.boolean().optional(),
    })
    .strict(),
};

/** Model-facing data shared by the SDK, native and stdio MCP adapters. */
export interface CanonicalToolDescriptor {
  name: ToolkitToolName;
  description: string;
  inputSchema: (typeof AdvertisedToolInputSchemas)[ToolkitToolName];
  aliases: readonly string[];
  inputJsonSchema: Record<string, unknown>;
}

/** The six canonical names and schemas; descriptions retain their build-time cap. */
export const CANONICAL_TOOL_DESCRIPTORS = {
  read: {
    name: 'read',
    inputSchema: AdvertisedToolInputSchemas.read,
    aliases: toolAliases('read'),
  },
  edit: {
    name: 'edit',
    inputSchema: AdvertisedToolInputSchemas.edit,
    aliases: toolAliases('edit'),
  },
  write: {
    name: 'write',
    inputSchema: AdvertisedToolInputSchemas.write,
    aliases: toolAliases('write'),
  },
  bash: {
    name: 'bash',
    inputSchema: AdvertisedToolInputSchemas.bash,
    aliases: toolAliases('bash'),
  },
  grep: {
    name: 'grep',
    inputSchema: AdvertisedToolInputSchemas.grep,
    aliases: toolAliases('grep'),
  },
  glob: {
    name: 'glob',
    inputSchema: AdvertisedToolInputSchemas.glob,
    aliases: toolAliases('glob'),
  },
} as const satisfies Record<
  ToolkitToolName,
  Pick<CanonicalToolDescriptor, 'name' | 'inputSchema' | 'aliases'>
>;

/** Preserve each built tool's capped description and enabled-tool selection. */
export function canonicalToolDescriptor(tool: ToolkitTool): CanonicalToolDescriptor {
  const { inputSchema, aliases } = CANONICAL_TOOL_DESCRIPTORS[tool.name];
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    aliases,
    inputJsonSchema: stripMetaSchema(z.toJSONSchema(inputSchema)) as Record<string, unknown>,
  };
}

/** Validate the strict compatibility surface before removing any alias keys. */
export function normalizeToolInput(tool: ToolkitTool, value: unknown): Record<string, unknown> {
  const parsed = tool.inputSchema.parse(value);
  const normalized: Record<string, unknown> = { ...parsed };
  const groups =
    tool.name === 'grep'
      ? [
          ['glob', 'include'],
          ['ignore_case', '-i', 'ignoreCase'],
        ]
      : tool.name === 'bash'
        ? [
            ['timeout', 'timeoutMs'],
            ['workdir', 'cwd'],
          ]
        : tool.name === 'glob'
          ? []
          : [
              ['file_path', 'filePath', 'path'],
              ...(tool.name === 'edit'
                ? [
                    ['old_string', 'oldString', 'oldText'],
                    ['new_string', 'newString', 'newText'],
                    ['replace_all', 'replaceAll'],
                  ]
                : []),
            ];
  for (const [canonical, ...aliases] of groups) {
    if (canonical === undefined) continue;
    for (const alias of aliases) {
      if (normalized[canonical] === undefined && normalized[alias] !== undefined)
        normalized[canonical] = normalized[alias];
      delete normalized[alias];
    }
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Pattern compilers
// ---------------------------------------------------------------------------

/** Regex-source escape for literal pattern chars (specials only). */
function literalChar(ch: string): string {
  return /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

/** One glob segment → regex source: `*` within-segment, `?` one char. */
function segmentToSource(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += literalChar(ch);
  }
  return out;
}

const globCache = new Map<string, RegExp>();

/** Compile glob-ish path patterns (see header) — full match on a relative POSIX path. Never throws. */
export function compilePathPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => {
    const cached = globCache.get(pattern);
    if (cached !== undefined) return cached;
    const segments = pattern.split('/');
    let source = '^';
    for (const [i, segment] of segments.entries()) {
      const last = i === segments.length - 1;
      if (segment === '**') {
        source += last ? '.*' : '(?:[^/]+/)*';
      } else {
        source += segmentToSource(segment);
        if (!last) source += '/';
      }
    }
    const re = new RegExp(`${source}$`);
    globCache.set(pattern, re);
    return re;
  });
}

/** A compiled command pattern: a JS regex, or a whitespace token prefix. */
type CommandPattern = { kind: 'regex'; re: RegExp } | { kind: 'tokens'; tokens: string[] };

/**
 * Compile the run allowlist. THROWS on an invalid `re:` regex or an
 * empty, non-plain-word, wrapped-git or git-global token pattern — corruption is loud (an empty
 * pattern would otherwise silently allow every command).
 */
export function compileCommandPatterns(patterns: readonly string[]): CommandPattern[] {
  return patterns.map((raw) => {
    if (raw.startsWith('re:')) {
      return { kind: 'regex', re: new RegExp(raw.slice('re:'.length)) };
    }
    const tokens = raw
      .trim()
      .split(/\s+/)
      .filter((token) => token !== '');
    if (tokens.length === 0) {
      throw new Error(
        `harness: empty run command pattern '${raw}' (empty patterns would allow every command)`,
      );
    }
    if (tokens.some((token) => !/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(token))) {
      throw new Error(`harness: run token pattern must contain only plain shell words: '${raw}'`);
    }
    if (
      tokens.some(
        (token, index) =>
          /(?:^|\/)git(?:\.(?:exe|cmd|bat|com))?$/i.test(token) && (index !== 0 || token !== 'git'),
      )
    ) {
      throw new Error(
        `harness: git token pattern must begin with literal git, without wrappers or paths; use an anchored re: grant for other spellings: '${raw}'`,
      );
    }
    if (tokens[0] === 'git' && !/^[a-z][a-z0-9-]*$/.test(tokens[1] ?? '')) {
      throw new Error(`harness: git token pattern requires a literal subcommand: '${raw}'`);
    }
    return { kind: 'tokens', tokens };
  });
}

/**
 * Shell metacharacters a token-prefix pattern must never bless: the exec
 * shell would interpret chaining (';', '&', '|', newline), substitution
 * ('$(`') and redirection ('<', '>') beyond what the token prefix saw.
 */
const SHELL_METACHARACTERS = /[;&|$`()<>\n\r]/;

/** The allowlist verdict for one command string (header semantics). */
type CommandVerdict =
  | { allowed: true; via: 'regex' | 'tokens' }
  | { allowed: false; metacharacters: boolean };

// Each key selects harness-owned argv. No input token is ever forwarded to git.
const GIT_HEADER = [
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=true',
];
const GIT_DIFF = [
  ...GIT_HEADER,
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];
const CLOSED_GIT_DIFF = new Map<string, readonly string[]>([
  ['git diff', [...GIT_DIFF, '--']],
  ['git diff --stat', [...GIT_DIFF, '--stat', '--']],
  ['git diff --name-only', [...GIT_DIFF, '--name-only', '--']],
  ['git diff --cached', [...GIT_DIFF, '--cached', '--']],
  ['git diff --cached --stat', [...GIT_DIFF, '--cached', '--stat', '--']],
  ['git diff --cached --name-only', [...GIT_DIFF, '--cached', '--name-only', '--']],
]);
const GIT_LOG = [...GIT_HEADER, 'log', '--no-ext-diff', '--no-textconv', '--no-color'];
const CLOSED_GIT_LOG = new Map<string, readonly string[]>([
  ['git log --oneline -n 20', [...GIT_LOG, '--oneline', '-n', '20', '--']],
  ['git log -n 1', [...GIT_LOG, '-n', '1', '--']],
  ['git log -n 1 --stat', [...GIT_LOG, '-n', '1', '--stat', '--']],
]);

/**
 * Match the compiled command allowlist: a re: match allows OUTRIGHT (the
 * author owns the full string); a token-prefix match allows only a command
 * free of shell metacharacters. On a denial, `metacharacters` marks the
 * reached-a-token-pattern-but-carried-metacharacters case — the trigger for
 * the distinct denial reason. A metacharacter-bearing token match does NOT
 * early-return: the loop keeps scanning so a LATER anchored re: pattern (the
 * escape hatch the denial points at) can still allow outright, whatever the
 * pattern order; the metacharacter denial fires only when no pattern allowed.
 */
function commandVerdict(patterns: readonly CommandPattern[], command: string): CommandVerdict {
  const cmdTokens = command.trim().split(/\s+/);
  let sawMetacharMatch = false;
  for (const pattern of patterns) {
    if (pattern.kind === 'regex') {
      if (pattern.re.test(command)) return { allowed: true, via: 'regex' };
      continue;
    }
    if (!pattern.tokens.every((token, i) => cmdTokens[i] === token)) continue;
    if (SHELL_METACHARACTERS.test(command)) {
      sawMetacharMatch = true; // keep scanning — a later re: may allow outright
      continue;
    }
    return { allowed: true, via: 'tokens' };
  }
  return { allowed: false, metacharacters: sawMetacharMatch };
}

// ---------------------------------------------------------------------------
// buildTools — descriptors + executors bound to one workspace
// ---------------------------------------------------------------------------

/** Node error code of an unknown throwable, when it carries one. */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Head-truncate to the configured cap; omitted cap = uncapped (explicit config choice). */
function capOutput(
  text: string,
  maxChars: number | undefined,
): { output: string; truncated: boolean } {
  if (maxChars === undefined || text.length <= maxChars) {
    return { output: text, truncated: false };
  }
  return { output: text.slice(0, maxChars), truncated: true };
}

/** Cap tool output without making the reason for truncation invisible. */
function capOutputWithMarker(
  text: string,
  maxChars: number | undefined,
  marker: string,
): { output: string; truncated: boolean } {
  if (maxChars === undefined || text.length <= maxChars) {
    return { output: text, truncated: false };
  }
  const truncationLines = text
    .split('\n')
    .filter((line) => line.startsWith('[truncated:') || line.startsWith('… (truncated;'));
  const uniqueMarkers = [...new Set([...truncationLines, marker])];
  const suffix = uniqueMarkers.join('\n');
  const visibleMarker = `\n${suffix}`;
  return {
    output: `${text.slice(0, Math.max(0, maxChars - visibleMarker.length))}${visibleMarker}`,
    truncated: true,
  };
}

function truncateLine(line: string, maxChars: number): { text: string; truncated: boolean } {
  if (line.length <= maxChars) return { text: line, truncated: false };
  const marker = `… [line truncated at ${maxChars} chars]`;
  return {
    text: `${line.slice(0, Math.max(0, maxChars - marker.length))}${marker}`,
    truncated: true,
  };
}

/** Head-truncate a tool description to the prompt-budget cap, ellipsis-marked. */
function capDescription(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** A UTF-8 BOM as it appears after decoding (kept by `ignoreBOM: true`). */
const BOM = '\uFEFF';

/** The NUL probe window for binary refusal (§6b: the first 8 KiB). */
const BINARY_PROBE_BYTES = 8_192;

/** SHA-256 of the exact bytes on disk (the staleness identity). */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when the first 8 KiB contain a NUL byte — the binary refusal signal. */
function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/**
 * Decode strict UTF-8. `ignoreBOM: true` keeps a leading BOM in the string so
 * the editor can preserve it; `fatal: true` refuses invalid UTF-8 instead of
 * mangling the file with replacement characters.
 */
function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Strip a leading BOM for matching (the write path restores it). */
function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** Normalise CRLF to LF for matching (the write path restores the file's style). */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * The file's DOMINANT line ending: the style used for NEW lines. Mixed
 * files keep their existing bytes (edit replaces spans in place); only
 * inserted text adopts the majority style.
 */
function dominantLineEnding(text: string): '\n' | '\r\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const totalLf = text.match(/\n/g)?.length ?? 0;
  return crlf > totalLf - crlf ? '\r\n' : '\n';
}

/** Restore a file's BOM and dominant line ending for a whole-file write. */
function restoreTextStyle(text: string, bom: boolean, ending: '\n' | '\r\n'): string {
  const body = ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
  return `${bom ? BOM : ''}${body}`;
}

/** One match in the ORIGINAL text (offsets are byte-for-byte string indices). */
interface MatchSpan {
  start: number;
  end: number;
}

/**
 * Find `needle` (already LF-normalised) in `haystack` while tolerating CRLF
 * in the haystack for each `\n` in the needle. `overlapping` advances one
 * character after a match (so `aaa`/`aa` finds BOTH starts); the
 * non-overlapping pass advances past the match (the replacement semantics).
 * Returns spans in the ORIGINAL string, so untouched bytes stay untouched.
 */
function findMatches(
  haystack: string,
  needle: string,
  overlapping: boolean,
  limit = Number.POSITIVE_INFINITY,
): MatchSpan[] {
  if (needle === '') return [];
  const spans: MatchSpan[] = [];
  let start = 0;
  while (start <= haystack.length - 1 && spans.length < limit) {
    // A needle beginning with LF has ONE canonical start in a CRLF pair:
    // the CR. Without this guard the LF half would count as a second,
    // overlapping match for the same logical occurrence.
    if (
      needle[0] === '\n' &&
      start > 0 &&
      haystack[start] === '\n' &&
      haystack[start - 1] === '\r'
    ) {
      start += 1;
      continue;
    }
    let h = start;
    let n = 0;
    while (n < needle.length && h < haystack.length) {
      if (needle[n] === '\n' && haystack[h] === '\r' && haystack[h + 1] === '\n') {
        n += 1;
        h += 2;
      } else if (haystack[h] === needle[n]) {
        n += 1;
        h += 1;
      } else {
        break;
      }
    }
    if (n === needle.length) {
      spans.push({ start, end: h });
      start = overlapping ? start + 1 : h;
    } else {
      start += 1;
    }
  }
  return spans;
}

/** Apply replacement spans in place, right-to-left (offsets stay valid). */
function applySpans(text: string, spans: readonly MatchSpan[], replacement: string): string {
  let out = text;
  for (const span of [...spans].reverse()) {
    out = out.slice(0, span.start) + replacement + out.slice(span.end);
  }
  return out;
}

/**
 * Build the harness tools for one workspace and one op's config.
 *
 *   - Disabled tools are OMITTED from the surface (the driver never offers
 *     them); denials are for calls that reach a PRESENT tool anyway
 *     (allowlist misses, sandbox, escapes).
 *   - `sandbox` defaults to 'workspace-write' — the level defaultHarnessConfig
 *     is designed to pair with.
 *   - The prompt budget is applied HERE as data: descriptions head-truncated
 *     to `maxToolDescriptionChars`, the surface sliced to `maxTools`.
 *   - The config is schema-validated on entry: a harness config that fails
 *     `HarnessConfigSchema` throws loudly before any tool exists.
 */
export function buildTools(
  config: HarnessConfig,
  workspace: string,
  sandbox: SandboxLevel = 'workspace-write',
  gate: HarnessRunGate = harnessRunGate(),
): ToolkitTool[] {
  const cfg: HarnessConfig = HarnessConfigSchema.parse(config);
  const workspaceAbs = resolve(workspace);
  const { promptBudget } = cfg;

  const deny = (
    tool: ToolkitToolName,
    reason: string,
  ): Extract<ToolkitToolResult, { ok: false }> => ({
    ok: false,
    denial: { tool, reason },
  });

  /** Root-containment predicate, shared by the lexical and realpath checks. */
  const isInside = (abs: string, root: string): boolean =>
    abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);

  /** Lexical containment: an absolute path inside the workspace, or undefined on escape. */
  const resolveInside = (requested: string): string | undefined => {
    const abs = resolve(workspaceAbs, requested);
    return isInside(abs, workspaceAbs) ? abs : undefined;
  };

  // The workspace's own realpath, computed once and lazily: tmp roots are
  // often symlinked themselves (macOS /var → /private/var), so the symlink
  // re-check must compare against the realpath of the ROOT or every path in
  // a symlinked tmp would false-positive.
  let workspaceReal: Promise<string | undefined> | undefined;
  const workspaceRealRoot = (): Promise<string | undefined> => {
    workspaceReal ??= realpath(workspaceAbs).catch(() => undefined);
    return workspaceReal;
  };

  /**
   * Symlink re-check (partial hardening — see the header's SYMLINK CHANNEL):
   * when `abs` EXISTS, its realpath must stay inside the workspace. ENOENT
   * (and any other realpath failure — ENOTDIR on file-under-file paths and
   * friends) falls through to the lexical path so the fs op itself produces
   * the honest denial; executors never throw. The realpath of an existing
   * file is also what downstream fs ops use, so a check-then-read race on
   * the SAME path resolves consistently; a symlink swapped in after the
   * check remains the documented TOCTOU window.
   */
  const resolveRealInside = async (abs: string): Promise<string | undefined> => {
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      return abs; // missing / unreadable path — the fs op will deny honestly
    }
    const root = await workspaceRealRoot();
    if (root === undefined) return abs; // workspace realpath unavailable — lexical check is all we have
    return isInside(real, root) ? real : undefined;
  };

  const relOf = (abs: string): string => relative(workspaceAbs, abs).split(sep).join('/');

  /**
   * TOOLKIT-OWNED INVARIANT (W1.4 composition review F1): read/edit never
   * touch a `.git` path, whatever `pathPatterns` say (`**` + `*` match
   * dot-segments). Editing `.git` steers git itself: repointing a linked
   * worktree's `.git` gitfile redirects allowlisted `git add/commit` into
   * another repository, and `.git/config` (`core.fsmonitor`,
   * `diff.external`, hooks paths…) makes an allowlisted `git status/diff`
   * run an arbitrary command, bypassing commandPatterns. Checked on the
   * LEXICAL path and on the REALPATH (a symlink into `.git` is caught when
   * it exists), relative to the workspace root, case-insensitively (macOS
   * and Windows filesystems resolve `.GIT` to `.git`), with Windows'
   * trailing-dot/space aliases (`.git.`) folded in.
   */
  const touchesGit = async (abs: string, effective: string): Promise<boolean> => {
    const hasGitSegment = (rel: string): boolean =>
      rel.split(/[\\/]/).some((segment) => /^\.git[. ]*$/i.test(segment));
    if (hasGitSegment(relative(workspaceAbs, abs))) return true;
    const root = await workspaceRealRoot();
    return (
      root !== undefined && isInside(effective, root) && hasGitSegment(relative(root, effective))
    );
  };
  const gitDenial = (
    tool: ToolkitToolName,
    abs: string,
  ): Extract<ToolkitToolResult, { ok: false }> =>
    deny(
      tool,
      `PATH_DENIED: path not allowed: '${relOf(abs)}' is inside a .git directory (toolkit invariant)`,
    );

  const pathAllowed = (patterns: readonly string[], abs: string): boolean =>
    compilePathPatterns(patterns).some((re) => re.test(relOf(abs)));

  /**
   * The full allowlist gate for read/edit: the patterns must allow the
   * LEXICAL workspace-relative path AND the realpath-derived one (relative
   * to the workspace's REALPATHED root — `effective` is a true realpath
   * whenever the requested path exists). The second check closes the
   * in-workspace symlink bypass: a link inside the workspace must not bless
   * its target's location (pattern 'src/**', link src/link → ../secret.txt
   * — the lexical name matches the pattern while the I/O lands on
   * 'secret.txt'). Denies when EITHER check misses. The realpath-side check
   * is skipped when the realpathed root is unavailable (the lexical check is
   * all we have, same posture as resolveRealInside) or when `effective` is
   * not inside it — the documented ENOENT lexical fallback on a symlinked
   * workspace root, where the lexical path has no realpath-relative form and
   * the fs op denies honestly ('file not found') anyway.
   */
  const pathAllowedEverywhere = async (
    patterns: readonly string[],
    abs: string,
    effective: string,
  ): Promise<boolean> => {
    if (!pathAllowed(patterns, abs)) return false;
    const root = await workspaceRealRoot();
    if (root === undefined || !isInside(effective, root)) return true;
    const realRel = relative(root, effective).split(sep).join('/');
    return compilePathPatterns(patterns).some((re) => re.test(realRel));
  };

  const invalidInput = (tool: ToolkitToolName, err: z.ZodError): ToolkitToolResult =>
    deny(tool, invalidToolInput(err));

  type SearchFile = {
    lexicalPath: string;
    effectivePath: string;
    lexicalRel: string;
    resolvedRel: string;
    size: number;
  };
  const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
  type SearchFileResult =
    | { ok: true; files: SearchFile[]; markers: string[] }
    | { ok: false; denial: Extract<ToolkitToolResult, { ok: false }> };

  /**
   * Bounded brace expansion for a grep include pattern (CR @5ef68b24): a
   * model-supplied include like '*.{ts,tsx}' must be an alternation, not a
   * literal-dot match. Recursive descent: the FIRST balanced {...} group,
   * split on its top-level commas, nested groups flattened across rounds.
   * A >64-alternative expansion is FAIL-CLOSED (SearchEnumerationStop with
   * `limit: 'expansion'`) — a literal fallback would keep the false-negative
   * class the CR rejects; the denial names the cap with bounded evidence.
   */
  const SEARCH_INCLUDE_EXPANSION_LIMIT = 64;
  // #605: the RESULT cap alone is not a work bound — '{a,a}'.repeat(30)+'.ts'
  // retains one unique alternative while visiting 2^30 branches. Every
  // recursive expand() call is charged to this visited-branch counter; the
  // expansion fails closed as soon as it is exceeded, before any unbounded
  // synchronous work.
  const SEARCH_INCLUDE_EXPANSION_VISITS = 256;
  type IncludeExpansion =
    | { overflow: true; reason: 'alternatives' | 'visits' }
    | { overflow: false; alternatives: string[] };
  const expandIncludeAlternatives = (pattern: string): IncludeExpansion => {
    const overflow = (reason: 'alternatives' | 'visits'): IncludeExpansion => ({
      overflow: true,
      reason,
    });
    let visited = 0;
    const expand = (rest: string, acc: string[]): 'alternatives' | 'visits' | undefined => {
      visited += 1;
      if (visited > SEARCH_INCLUDE_EXPANSION_VISITS) return 'visits';
      // An escaped brace is data for tokenizeComponent, not an expansion
      // delimiter. A pair of backslashes escapes itself, leaving the brace
      // syntactic (the same parity rule applies to closing braces and commas).
      let escaped = false;
      let open = -1;
      for (let i = 0; i < rest.length; i += 1) {
        const ch = rest[i];
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '{') {
          open = i;
          break;
        }
      }
      if (open === -1) {
        if (!acc.includes(rest)) acc.push(rest);
        return acc.length <= SEARCH_INCLUDE_EXPANSION_LIMIT ? undefined : 'alternatives';
      }
      let depth = 0;
      let close = -1;
      escaped = false;
      for (let i = open; i < rest.length; i += 1) {
        const ch = rest[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close === -1) {
        // Unbalanced braces stay literal (rg glob-consistent, no expansion).
        if (!acc.includes(rest)) acc.push(rest);
        return acc.length <= SEARCH_INCLUDE_EXPANSION_LIMIT ? undefined : 'alternatives';
      }
      const inner = rest.slice(open + 1, close);
      const parts: string[] = [];
      let partDepth = 0;
      let current = '';
      escaped = false;
      for (const ch of inner) {
        if (escaped) {
          current += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          current += ch;
          escaped = true;
          continue;
        }
        if (ch === '{') partDepth += 1;
        else if (ch === '}') partDepth -= 1;
        if (ch === ',' && partDepth === 0) {
          parts.push(current);
          current = '';
        } else current += ch;
      }
      parts.push(current);
      const prefix = rest.slice(0, open);
      const suffix = rest.slice(close + 1);
      for (const part of parts) {
        const reason = expand(prefix + part + suffix, acc);
        if (reason !== undefined) return reason;
      }
      return undefined;
    };
    const alternatives: string[] = [];
    const reason = expand(pattern, alternatives);
    if (reason !== undefined) return overflow(reason);
    return { overflow: false, alternatives };
  };

  // ---------------------------------------------------------------------------
  // #604/#614: a file-local ripgrep-glob matcher for grep includes.
  //
  // compilePathPatterns is the shared path-ALLOWLIST compiler (src/index.ts,
  // review planning) and deliberately escapes brackets and leading '!'; the
  // include boundary must instead preserve the established ripgrep glob
  // syntax, verified against deterministic local rg fixtures:
  //   - '*' matches any run of non-'/' within one segment; '?' one non-'/'
  //     char; '**' spans segments ('a**' matches 'a.test.ts' AND 'a.ts').
  //   - '[abc]', '[a-c]' character classes; ']' as the FIRST member is a
  //     literal ('[]a].ts' matches 'a.ts'); '[!...]' negates ('[!a-c]*.ts').
  //   - a '/' anywhere makes the glob ROOT-anchored ('dir/n.ts' matches only
  //     that path); otherwise the glob may match at any depth ('a*' also
  //     matches 'deep/a.txt'; '**/n.ts' matches 'deep/dir/n.ts').
  //   - a leading '!' marks an EXCLUSION group; one rg call with globs
  //     ['*.ts','!*.test.ts'] returns positives MINUS exclusions. Matching
  //     a set of alternatives is therefore: any positive matches AND no
  //     exclusion matches ('keep.ts' survives '!*.test.ts keep.ts').
  //   - '{a,b}' alternation is expanded before this matcher runs.
  //
  // #614: matching is synchronous inside enumeration, so it must be bounded
  // independent of timeouts/abort: NO regex and NO backtracking. Each
  // alternative is compiled into a token list and matched with iterative
  // two-pointer wildcard matching (greedy '*' with one rollback position,
  // no re-examination of consumed path text), total state bounded by
  // pattern length x path length. Whole-pattern length is capped per
  // alternative and fails closed before enumeration; an uncapped matcher
  // would be a synchronous event-loop hazard (issue #614).
  // ---------------------------------------------------------------------------
  const SEARCH_INCLUDE_PATTERN_MAX = 256;
  type GlobToken =
    | { kind: 'literal'; chars: string }
    | { kind: 'any-run' } // '*' — greedy within one path component
    | { kind: 'any-one' } // '?'
    | { kind: 'class'; members: string[]; ranges: [string, string][]; negate: boolean };
  type CompiledGlob = { runs: GlobToken[][]; anchored: boolean };

  /**
   * Tokenize ONE '/'-free path component. rg glob rules (fixture-pinned):
   * '*' is a greedy within-component wildcard (repeated stars fold), '?'
   * one component char, '[abc]'/'[a-c]' classes with ']' first-member
   * literal and '[!...]' negation; '\x' escapes; an unterminated '[' is a
   * literal bracket. 'a**' behaves as 'a*' (rg: '**' is special ONLY as a
   * whole path component).
   */
  const tokenizeComponent = (part: string): GlobToken[] => {
    const tokens: GlobToken[] = [];
    let literal = '';
    const flush = (): void => {
      if (literal !== '') {
        tokens.push({ kind: 'literal', chars: literal });
        literal = '';
      }
    };
    let index = 0;
    while (index < part.length) {
      const ch = part[index]!;
      if (ch === '*') {
        flush();
        while (part[index] === '*') index += 1;
        tokens.push({ kind: 'any-run' });
      } else if (ch === '?') {
        flush();
        tokens.push({ kind: 'any-one' });
        index += 1;
      } else if (ch === '[') {
        let cursor = index + 1;
        let negate = false;
        if (part[cursor] === '!' || part[cursor] === '^') {
          negate = true;
          cursor += 1;
        }
        const members: string[] = [];
        const ranges: [string, string][] = [];
        let first = true;
        let closed = false;
        while (cursor < part.length) {
          const member = part[cursor]!;
          if (member === ']' && !first) {
            closed = true;
            cursor += 1;
            break;
          }
          first = false;
          if (
            member !== ']' &&
            part[cursor + 1] === '-' &&
            part[cursor + 2] !== undefined &&
            part[cursor + 2] !== ']'
          ) {
            ranges.push([member, part[cursor + 2]!]);
            cursor += 3;
            continue;
          }
          members.push(member);
          cursor += 1;
        }
        flush();
        if (closed) {
          tokens.push({ kind: 'class', members, ranges, negate });
          index = cursor;
        } else {
          literal += ch; // unterminated '[' is a literal bracket (rg)
          index += 1;
        }
      } else if (ch === '\\') {
        const next = part[index + 1];
        if (next !== undefined) {
          literal += next;
          index += 2;
        } else {
          literal += ch;
          index += 1;
        }
      } else {
        literal += ch;
        index += 1;
      }
    }
    flush();
    return tokens;
  };

  /**
   * Compile one expanded alternative. The pattern-level leading '!' has
   * already been stripped by the caller (#604: negation precedes brace
   * expansion), so an inner '!' here is an ORDINARY component character
   * (rg fixture: '{!*.test.ts,*.test.ts}' lists .test.ts files). '/'-free
   * components become token runs; a whole '**' component is the globstar
   * marker run; a glob with '/' is root-anchored.
   */
  const compileRgGlob = (glob: string): CompiledGlob => {
    // A leading '/' anchors at the workspace root; it is not an empty
    // path component to match before the first real component.
    const anchored = glob.includes('/');
    const parts = (glob.startsWith('/') ? glob.slice(1) : glob).split('/');
    return {
      runs: parts.map((part) =>
        part === '**' ? [{ kind: 'any-run' }, { kind: 'any-run' }] : tokenizeComponent(part),
      ),
      anchored,
    };
  };

  const classMatches = (token: Extract<GlobToken, { kind: 'class' }>, ch: string): boolean => {
    let hit = token.members.includes(ch);
    if (!hit) {
      for (const [low, high] of token.ranges) {
        if (ch >= low && ch <= high) {
          hit = true;
          break;
        }
      }
    }
    return token.negate ? !hit : hit;
  };

  /**
   * Match one component run against one '/'-free path component: iterative
   * greedy wildcard matching with a single rollback point per '*' — total
   * work bounded by the component length; no regex, no recursion. Every
   * state step charges the SHARED per-candidate budget; exhaustion returns
   * `false` with `budget.exhausted = true` so the caller can fail closed.
   */
  const matchRun = (tokens: GlobToken[], text: string, budget: { left: number }): boolean => {
    let t = 0;
    let p = 0;
    let star = -1;
    let starPath = -1;
    while (p < text.length) {
      budget.left -= 1;
      if (budget.left < 0) return false;
      const token = tokens[t];
      if (token === undefined) {
        if (star === -1) return false;
        t = star + 1;
        starPath += 1;
        p = starPath;
        continue;
      }
      if (token.kind === 'any-run') {
        star = t;
        starPath = p;
        t += 1;
        continue;
      }
      let hit = false;
      if (token.kind === 'literal') {
        hit = text.startsWith(token.chars, p);
        if (hit) p += token.chars.length;
      } else if (token.kind === 'any-one') {
        hit = true;
        p += 1;
      } else {
        hit = classMatches(token, text[p]!);
        if (hit) p += 1;
      }
      if (hit) {
        t += 1;
        continue;
      }
      if (star === -1) return false;
      t = star + 1;
      starPath += 1;
      p = starPath;
    }
    while (t < tokens.length && tokens[t]!.kind === 'any-run') t += 1;
    return t === tokens.length;
  };

  const isGlobstarRun = (run: GlobToken[] | undefined): boolean =>
    run !== undefined &&
    run.length === 2 &&
    run[0]!.kind === 'any-run' &&
    run[1]!.kind === 'any-run';

  /**
   * Match the component runs against a path's components with iterative NFA
   * state (a set of run positions, advanced one component at a time with a
   * doublestar fixpoint) — total state bounded by pattern length; no
   * recursion, no backtracking across components. A doublestar COMPONENT
   * consumes zero or more components (rg fixtures: doublestar + '/n.ts'
   * hits 'deep/dir/n.ts'; 'deep' + doublestar + '/n.ts' ditto; a trailing
   * doublestar matches all deeper components).
   */
  const matchRuns = (
    runs: GlobToken[][],
    segments: string[],
    budget: { left: number },
  ): boolean => {
    let states = new Set<number>([0]);
    for (const segment of segments) {
      budget.left -= states.size; // copy the active states for closure
      if (budget.left < 0) return false;
      const expanded = new Set<number>(states);
      let grew = true;
      while (grew) {
        grew = false;
        // Charge the fixpoint walk before copying its states.
        budget.left -= expanded.size;
        if (budget.left < 0) return false;
        for (const t of [...expanded]) {
          if (isGlobstarRun(runs[t]) && !expanded.has(t + 1)) {
            expanded.add(t + 1);
            grew = true;
          }
        }
      }
      const next = new Set<number>();
      for (const t of expanded) {
        budget.left -= 1;
        if (budget.left < 0) return false;
        const run = runs[t];
        if (run === undefined) continue;
        if (isGlobstarRun(run)) {
          next.add(t); // '**' also consumes this component
          continue;
        }
        if (matchRun(run, segment, budget)) next.add(t + 1);
      }
      if (next.size === 0) return false;
      states = next;
    }
    for (const t of states) {
      budget.left -= 1;
      if (budget.left < 0) return false;
      let c = t;
      while (isGlobstarRun(runs[c])) {
        budget.left -= 1;
        if (budget.left < 0) return false;
        c += 1;
      }
      if (c === runs.length) return true;
    }
    return false;
  };

  type IncludeMatcher = {
    /** Total compiled token size across alternatives — the work bound. */
    stateBudget: number;
    /**
     * Match one candidate against the include set. Returns a verdict, not a
     * boolean: `matched` is the ordinary answer; `exhausted` reports that a
     * per-candidate match-state budget ran out BEFORE a verdict — an honest
     * fail-closed signal the caller must deny on, never silently dropping a
     * candidate that might have matched (#614).
     */
    matches: (rel: string) => { matched: boolean } | { exhausted: true };
  };
  // Per-CANDIDATE aggregate match-state budget (#614): one budget spans ALL
  // alternatives (positive + exclusion), every unanchored suffix start, and
  // every NFA state step inside matchRuns. A candidate whose evaluation
  // exhausts it yields an honest SEARCH_LIMIT denial; an ordinary non-match
  // stays a plain non-match. The budget is per candidate because the
  // matcher is synchronous INSIDE enumeration — the wall clock cannot
  // interrupt it, so the bound must be countable, not timely.
  const SEARCH_INCLUDE_MATCH_STATE_BUDGET = 4_096;

  /**
   * Streaming candidate enumeration for the grep include path (CR @5ef68b24).
   * `runArgvCommand` retains the WHOLE output up front, so a narrow include
   * over a large workspace could overflow the enumeration output cap before
   * the include filter ever ran — a false SEARCH_LIMIT for a cheaper,
   * narrower request. This helper mirrors `spawnAndCollect` (src/harness/
   * run.ts) — spawn with shell:false, POSIX process group, the same
   * registerProcessSignalCleanup registration, clearTimeout, abort listener
   * and unregister-in-close settlement — but feeds each NUL-separated path
   * to `onEntry` AS IT ARRIVES and retains only what the caller keeps:
   *   - scanned paths and scanned bytes are counted and fail closed at the
   *     caller-configured work bounds (bounded traversal work, one honest
   *     termination reason);
   *   - `stop-early` reports a deliberate stop (caller hit its match cap);
   *     rg is killed via the same group kill and the exit code is ignored;
   *   - a path crossing the chunk boundary is carried over; a final segment
   *     longer than 4096 bytes without a NUL exceeds the path bound (fail
   *     closed) — real workspace paths are far shorter;
   *   - stderr is retained to a 4096-byte tail (rg diagnostics only).
   * No full-output buffer ever exists: memory is the retained matches plus
   * one chunk plus one carried partial path.
   */
  type SearchEnumerationOutcome =
    | { kind: 'exit'; code: number; stderrTail: string }
    | { kind: 'killed'; stderrTail: string }
    | { kind: 'spawn-error'; error: unknown }
    | { kind: 'overflow' }
    | { kind: 'stop-early' };
  const streamRgEnumeration = async (
    args: readonly string[],
    opts: {
      cwd: string;
      env: Readonly<Record<string, string>>;
      timeoutMs: number;
      signal: AbortSignal | undefined;
      maxScannedPaths: number;
      maxScannedBytes: number;
      onEntry: (path: string) => boolean;
    },
  ): Promise<SearchEnumerationOutcome> => {
    if (opts.signal?.aborted === true) return { kind: 'killed', stderrTail: '' };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('rg', [...args], {
        cwd: opts.cwd,
        shell: false,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(POSIX_SEARCH ? { detached: true } : {}),
      });
    } catch (err) {
      return { kind: 'spawn-error', error: err };
    }
    let scannedPaths = 0;
    let scannedBytes = 0;
    let overflowed = false;
    let stoppedEarly = false;
    let carry: Buffer = Buffer.alloc(0);
    const CARRY_LIMIT_BYTES = 4_096;
    const killSearchGroup = (): void => {
      if (POSIX_SEARCH && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // group already gone — fall through to the direct kill
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const consumeChunk = (chunk: Buffer): boolean => {
      // Returns false once a work bound or the caller cap ends the stream.
      // Splitting happens on BYTES (NUL = 0x00) so a multibyte character
      // crossing a chunk boundary can never corrupt an entry.
      scannedBytes += chunk.length;
      if (scannedBytes > opts.maxScannedBytes) {
        overflowed = true;
        return false;
      }
      const merged = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const lastNul = merged.lastIndexOf(0);
      if (lastNul === -1) {
        carry = merged;
        return true;
      }
      carry = merged.subarray(lastNul + 1);
      let start = 0;
      while (start <= lastNul) {
        const nul = merged.indexOf(0, start);
        const entry = merged.subarray(start, nul);
        start = nul + 1;
        if (entry.length === 0) continue;
        scannedPaths += 1;
        if (scannedPaths > opts.maxScannedPaths) {
          overflowed = true;
          return false;
        }
        if (!opts.onEntry(entry.toString('utf8'))) {
          stoppedEarly = true;
          return false;
        }
      }
      return true;
    };
    // A full stdout pipe keeps a killed rg's buffered bytes in the PIPE, not
    // in rg: the group kill cannot deliver 'close' while the pipe stays full
    // (kernel backpressure blocks rg's final write), so settlement would
    // hang. Once a terminal condition fires, keep DRAINING and discarding
    // stdout (overflowed stays true; no repeated cap processing) until the
    // child closes and settles.
    let terminal = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (terminal) return; // drain and discard; verdict already fixed
      if (consumeChunk(chunk)) return;
      terminal = true;
      killSearchGroup();
      // stay attached and draining — do NOT pause the stream
    });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4_096);
    });
    let spawnError: unknown;
    child.on('error', (e: unknown) => {
      spawnError = e;
    });
    return new Promise<SearchEnumerationOutcome>((settle) => {
      const unregister = registerProcessSignalCleanup(() => {
        killSearchGroup();
        return undefined;
      });
      const timer = setTimeout(killSearchGroup, opts.timeoutMs);
      opts.signal?.addEventListener('abort', killSearchGroup, { once: true });
      child.on('close', (code) => {
        unregister();
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', killSearchGroup);
        if (carry.length > CARRY_LIMIT_BYTES) {
          // An unterminated tail past the path bound: output was cut, fail closed.
          overflowed = true;
        }
        if (stoppedEarly) return settle({ kind: 'stop-early' });
        if (overflowed) return settle({ kind: 'overflow' });
        if (spawnError !== undefined && child.pid === undefined)
          return settle({ kind: 'spawn-error', error: spawnError });
        if (code === null) return settle({ kind: 'killed', stderrTail });
        return settle({ kind: 'exit', code, stderrTail });
      });
    });
  };

  /** Enumerate first, gate every bounded candidate, and return only safe files. */
  const collectSearchFiles = async (
    tool: 'grep' | 'glob',
    requestedPath: string | undefined,
    fileGlob: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SearchFileResult> => {
    const cancelled = (): SearchFileResult => ({
      ok: false,
      denial: deny(tool, 'CANCELLED: cancelled: search was aborted or timed out'),
    });
    if (isAborted(signal)) return cancelled();
    const requested = requestedPath ?? '.';
    const scope = resolveInside(requested);
    if (scope === undefined) {
      return {
        ok: false,
        denial: deny(
          tool,
          `PATH_ESCAPE: path escape: '${requested}' resolves outside the workspace`,
        ),
      };
    }
    const effectiveScope = await resolveRealInside(scope);
    if (isAborted(signal)) return cancelled();
    if (effectiveScope === undefined) {
      return {
        ok: false,
        denial: deny(
          tool,
          `PATH_ESCAPE: path escape: '${requested}' escapes the workspace through a symlink`,
        ),
      };
    }
    if (await touchesGit(scope, effectiveScope)) {
      return { ok: false, denial: gitDenial(tool, scope) };
    }
    const scopeInfo = await stat(effectiveScope).catch(() => undefined);
    if (isAborted(signal)) return cancelled();
    if (scopeInfo === undefined) {
      return { ok: false, denial: deny(tool, `FS_NOT_FOUND: path not found: '${relOf(scope)}'`) };
    }

    const scopeArg = relOf(scope) || '.';
    // IGNORE CONTRACT (issues #491/#493/#494; glob semantics per #528):
    //  - grep NEVER passes its include glob into rg. rg applies explicit
    //    --globs BEFORE ignore files (a whitelisting glob can resurrect
    //    .gitignore-excluded paths, and the precedence is version-dependent),
    //    so grep's enumeration stays ignore-aware — --files + --hidden, no
    //    user glob — and the include filter is applied in TypeScript below
    //    via compilePathPatterns. .gitignore wins, as the tool promises.
    //  - glob keeps its #528 documented semantics: --no-ignore makes the
    //    enumeration hidden/ignored-INCLUSIVE and version-stable (no ignore
    //    files can interfere with a --glob there), the request's pattern rides
    //    as an ordinary --glob with full ripgrep glob syntax, and the fixed
    //    VCS-directory exclusion globs stay later in the list so they win.
    const enumerateArgs = [
      '--files',
      '--no-config',
      '--hidden',
      ...(tool === 'glob' ? ['--no-ignore'] : []),
      '--color=never',
      '--null',
      ...(tool === 'glob' && fileGlob !== undefined ? ['--glob', fileGlob] : []),
      '--glob',
      '!.git',
      ...(tool === 'glob' ? ['--glob', '!.hg', '--glob', '!.svn'] : []),
      '--',
      scopeArg,
    ];
    const enumerationEnv = buildChildEnv(process.env);
    // INCLUDE MATCHER (#604/#605/#614, replaces the compilePathPatterns use
    // here): ripgrep glob syntax preserved — [abc]/[a-c]/[!...] classes,
    // ']' first-member literal, leading-'!' exclusion groups (positives MINUS
    // exclusions, rg multi-glob semantics), '/' anchoring, '**' spanning —
    // matched with a bounded no-regex matcher. Every bound fails visibly
    // closed: >64 expanded alternatives, >256 visited expansion branches,
    // or a >256-char alternative all deny with SEARCH_LIMIT before any
    // enumeration starts; matcher state is additionally capped during
    // matching (never silently drops a candidate).
    let grepInclude: IncludeMatcher | undefined;
    if (tool === 'grep' && fileGlob !== undefined) {
      // #604: a leading '!' negates the WHOLE include pattern (rg glob
      // semantics), so it must be stripped BEFORE brace expansion — otherwise
      // an arm like '{!*.test.ts,*.test.ts}' would be read as an exclusion
      // arm instead of a literal-'!' component. rg fixture:
      // --glob '{!*.test.ts,*.test.ts}' LISTS .test.ts files (the '!' arm
      // matches names starting with a literal '!'); only a PATTERN-level
      // '!' excludes.
      let includeBody = fileGlob;
      let patternExcluded = false;
      if (includeBody.startsWith('!')) {
        patternExcluded = true;
        includeBody = includeBody.slice(1);
      }
      const expansion = expandIncludeAlternatives(includeBody);
      if (expansion.overflow) {
        const reason =
          expansion.reason === 'alternatives'
            ? `include expansion exceeds ${SEARCH_INCLUDE_EXPANSION_LIMIT} alternatives`
            : `include expansion exceeds ${SEARCH_INCLUDE_EXPANSION_VISITS} visited branches`;
        return {
          ok: false,
          denial: deny(tool, `SEARCH_LIMIT: search denied: ${reason}`),
        };
      }
      if (
        expansion.alternatives.some((candidate) => candidate.length > SEARCH_INCLUDE_PATTERN_MAX)
      ) {
        return {
          ok: false,
          denial: deny(
            tool,
            `SEARCH_LIMIT: search denied: include pattern exceeds ${SEARCH_INCLUDE_PATTERN_MAX} characters`,
          ),
        };
      }
      const compiled = expansion.alternatives.map((candidate) => compileRgGlob(candidate));
      // One positive alternative is enough to accept; exclusions veto. The
      // whole include is ONE exclusion when the pattern itself was negated.
      const positives = patternExcluded ? [] : compiled;
      const exclusions = patternExcluded ? compiled : [];
      // Unanchored globs (no '/') match at ANY depth (rg: 'a*' hits
      // 'deep2/a.txt'), so try every suffix start; anchored globs match only
      // from the root. ONE aggregate per-candidate budget (#614) spans all
      // alternatives, all suffix starts and all NFA steps: exhaustion is an
      // honest fail-closed verdict, never a silent non-match.
      const matchOne = (glob: CompiledGlob, rel: string, budget: { left: number }): boolean => {
        budget.left -= rel.length; // split the candidate path for this alternative
        if (budget.left < 0) return false;
        const segments = rel.split('/');
        if (glob.anchored) {
          return matchRuns(glob.runs, segments, budget);
        }
        for (let start = 0; start < segments.length; start += 1) {
          // slice copies each remaining component; charge it before copying.
          budget.left -= segments.length - start;
          if (budget.left < 0) return false;
          if (matchRuns(glob.runs, segments.slice(start), budget)) return true;
        }
        return false;
      };
      // rg excludes a directory and all of its descendants when the
      // directory itself matches a negative glob (for example, !src).
      // Charge each copied ancestor and its match to the same candidate budget.
      const matchExcluded = (
        glob: CompiledGlob,
        rel: string,
        budget: { left: number },
      ): boolean => {
        if (matchOne(glob, rel, budget)) return true;
        if (budget.left < 0) return false;
        for (let slash = rel.indexOf('/'); slash !== -1; slash = rel.indexOf('/', slash + 1)) {
          budget.left -= slash;
          if (budget.left < 0) return false;
          if (matchOne(glob, rel.slice(0, slash), budget)) return true;
          if (budget.left < 0) return false;
        }
        return false;
      };
      grepInclude = {
        stateBudget: compiled.reduce((total, glob) => {
          return total + glob.runs.reduce((sum, run) => sum + run.length, 0);
        }, 0),
        matches: (rel) => {
          const budget = { left: SEARCH_INCLUDE_MATCH_STATE_BUDGET };
          if (positives.length === 0 && exclusions.length === 0) return { matched: false };
          for (const glob of exclusions) {
            if (matchExcluded(glob, rel, budget)) return { matched: false };
            if (budget.left < 0) return { exhausted: true };
          }
          if (positives.length === 0) return { matched: true }; // exclusions passed
          for (const glob of positives) {
            if (matchOne(glob, rel, budget)) return { matched: true };
            if (budget.left < 0) return { exhausted: true };
          }
          return { matched: false };
        },
      };
    }

    if (isAborted(signal)) return cancelled();

    let rawPaths: string[];
    let sawExtraCandidates = false;
    if (grepInclude !== undefined) {
      // STREAMING include path (CR @5ef68b24): the user glob never rode into
      // rg (#491), so a narrow include over a large workspace must not
      // overflow the 4 MiB whole-output cap before the filter runs. Stream
      // rg's NUL-separated output, filter per path, and retain only the
      // lexical top-1001 matches in a bounded buffer (the same order the
      // whole-output path produces with its sort-then-slice). Traversal is
      // still bounded: scanned bytes/paths fail closed with the honest
      // SEARCH_LIMIT denial, and the same SEARCH_TIMEOUT_MS / abort / group
      // kill as runArgvCommand applies.
      type MatchSlot = { rel: string; raw: string };
      const slots: MatchSlot[] = [];
      const pushMatch = (rel: string, raw: string): void => {
        slots.push({ rel, raw });
        if (slots.length <= SEARCH_CANDIDATE_LIMIT + 1) return;
        // Drop the lexically largest: the survivors stay the true top-N.
        let largest = 0;
        for (let i = 1; i < slots.length; i += 1) {
          if (slots[i]!.rel > slots[largest]!.rel) largest = i;
        }
        slots.splice(largest, 1);
      };
      const include = grepInclude;
      let includeExhausted = false;
      const outcome = await streamRgEnumeration(enumerateArgs, {
        cwd: workspaceAbs,
        env: enumerationEnv,
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal,
        maxScannedBytes: SEARCH_GREP_ENUM_STREAM_BYTES,
        maxScannedPaths: SEARCH_GREP_ENUM_STREAM_PATHS,
        onEntry: (candidate) => {
          const lexicalPath = resolveInside(candidate);
          if (lexicalPath === undefined) return true;
          const rel = relOf(lexicalPath);
          const verdict = include.matches(rel);
          if ('exhausted' in verdict) {
            // Honest fail-closed (#614): the bounded matcher ran out of
            // state before a verdict — deny the whole search rather than
            // silently dropping a candidate that might have matched.
            includeExhausted = true;
            return false;
          }
          if (!verdict.matched) return true;
          pushMatch(rel, candidate);
          return slots.length <= SEARCH_CANDIDATE_LIMIT + 1;
        },
      });
      if (includeExhausted) {
        return {
          ok: false,
          denial: deny(tool, `SEARCH_LIMIT: search denied: include match state budget exhausted`),
        };
      }
      if (outcome.kind === 'killed') {
        return isAborted(signal)
          ? cancelled()
          : { ok: false, denial: deny(tool, 'TIMEOUT: search enumeration timed out') };
      }
      if (outcome.kind === 'spawn-error') {
        return {
          ok: false,
          denial: deny(tool, `EXECUTION_ERROR: search failed: ${messageOf(outcome.error)}`),
        };
      }
      if (outcome.kind === 'overflow') {
        return {
          ok: false,
          denial: deny(
            tool,
            'SEARCH_LIMIT: search denied: candidate enumeration work cap exceeded',
          ),
        };
      }
      if (outcome.kind === 'exit' && outcome.code !== 0 && outcome.code !== 1) {
        const detail = outcome.stderrTail.trim();
        return {
          ok: false,
          denial: deny(
            tool,
            `EXECUTION_ERROR: search failed: rg candidate enumeration exited ${outcome.code}` +
              (detail === '' ? '' : `: ${detail}`),
          ),
        };
      }
      if (isAborted(signal)) return cancelled();
      // #613: ONE comparator everywhere — native code-unit order. The
      // drop-largest selection above uses native >, so the final sort must
      // agree (localeCompare could REORDER past the cap and silently
      // displace a matching candidate).
      slots.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
      rawPaths = slots.map((slot) => slot.raw);
      sawExtraCandidates = slots.length > SEARCH_CANDIDATE_LIMIT;
    } else {
      const listing = await runArgvCommand('rg', enumerateArgs, {
        env: enumerationEnv,
        cwd: workspaceAbs,
        maxBytes: SEARCH_CANDIDATE_OUTPUT_BYTES,
        timeoutMs: SEARCH_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (listing.kind === 'killed') {
        return isAborted(signal)
          ? cancelled()
          : { ok: false, denial: deny(tool, 'TIMEOUT: search enumeration timed out') };
      }
      if (listing.kind === 'spawn-error') {
        return {
          ok: false,
          denial: deny(tool, `EXECUTION_ERROR: search failed: ${messageOf(listing.error)}`),
        };
      }
      if (listing.overflowed) {
        return {
          ok: false,
          denial: deny(
            tool,
            'SEARCH_LIMIT: search denied: candidate enumeration output cap exceeded',
          ),
        };
      }
      if (listing.code !== 0 && listing.code !== 1) {
        return {
          ok: false,
          denial: deny(
            tool,
            `EXECUTION_ERROR: search failed: rg candidate enumeration exited ${listing.code}`,
          ),
        };
      }
      if (isAborted(signal)) return cancelled();
      rawPaths = listing.stdout
        .split('\0')
        .filter((candidate) => candidate.length > 0)
        .sort();
      sawExtraCandidates = rawPaths.length > SEARCH_CANDIDATE_LIMIT;
    }
    const markers: string[] = [];

    // The include filter (grep, #491 remainder) ran during enumeration when
    // present (streaming path above); the whole-output path (glob, or grep
    // without an include) flows every candidate through unchanged. Filter
    // semantics: a bare '*.ts' include is a BASENAME filter ('**/*.ts');
    // rooted patterns filter exactly as they enumerate. The filter runs
    // BEFORE the candidate-count cap, mirroring the base order.
    const matchedPaths = rawPaths;

    // Candidate-count cap (#491 ordering preserved): the include filter has
    // already run during enumeration, so this slice keeps the lexical
    // top-1000 matches and the marker reports the truncation truthfully.
    const boundedPaths = matchedPaths.slice(0, SEARCH_CANDIDATE_LIMIT);
    if (sawExtraCandidates) {
      markers.push(`[truncated: candidate files cap ${SEARCH_CANDIDATE_LIMIT}]`);
    }

    const allowed: SearchFile[] = [];
    for (const rawPath of boundedPaths) {
      if (isAborted(signal)) return cancelled();
      const lexicalPath = resolveInside(rawPath);
      if (lexicalPath === undefined) continue;
      const effectivePath = await resolveRealInside(lexicalPath);
      if (isAborted(signal)) return cancelled();
      if (effectivePath === undefined) continue;
      if (await touchesGit(lexicalPath, effectivePath)) continue;
      if (!(await pathAllowedEverywhere(cfg.tools.read.pathPatterns, lexicalPath, effectivePath))) {
        continue;
      }
      const fileInfo = await stat(effectivePath).catch(() => undefined);
      if (isAborted(signal)) return cancelled();
      if (fileInfo === undefined || !fileInfo.isFile()) continue;
      const realRoot = await workspaceRealRoot();
      const resolvedRel =
        realRoot !== undefined && isInside(effectivePath, realRoot)
          ? relative(realRoot, effectivePath).split(sep).join('/')
          : relOf(effectivePath);
      allowed.push({
        lexicalPath,
        effectivePath,
        lexicalRel: relOf(lexicalPath),
        resolvedRel,
        size: fileInfo.size,
      });
    }

    // DISCOVERY vs CONTENT budgets (#493/#494): filename discovery is its own
    // budget — bounded by the candidate-count cap above — and is never ended
    // by the CONTENT byte budget. `glob` reads no file contents, so the byte
    // budget does not bind it at all. `grep` — the only consumer that opens
    // the gated files — applies the budget per candidate: a candidate that
    // does not fit the REMAINING budget is SKIPPED and the loop continues, so
    // one large file never starves later small ones (the total budget still
    // binds across kept candidates). Skips are reported with truthful,
    // bounded aggregate evidence — never silently.
    const files: SearchFile[] = [];
    let searchedBytes = 0;
    let skippedOverBudget = 0;
    let firstSkipped: string | undefined;
    for (const file of allowed) {
      if (isAborted(signal)) return cancelled();
      if (tool === 'grep' && file.size > SEARCH_BYTES_LIMIT - searchedBytes) {
        skippedOverBudget += 1;
        firstSkipped ??= file.lexicalRel;
        continue; // #493: never end the loop on one non-fitting candidate
      }
      files.push(file);
      searchedBytes += file.size;
    }
    if (skippedOverBudget > 0) {
      markers.push(`[truncated: searched bytes cap ${SEARCH_BYTES_LIMIT}]`);
      markers.push(
        skippedOverBudget === 1
          ? `[truncated: skipped oversized candidate ${firstSkipped} over the remaining searched-bytes budget]`
          : `[truncated: skipped ${skippedOverBudget} candidates over the remaining ` +
              `searched-bytes budget, first: ${firstSkipped}]`,
      );
    }
    if (isAborted(signal)) return cancelled();
    return { ok: true, files, markers };
  };

  /**
   * The prior-read ledger for edit/write staleness. Keyed by the resolved
   * path, it records the exact bytes a `read` returned; an edit/write must
   * find an entry and the on-disk SHA-256 must still match it. The ledger is
   * per `buildTools` call — a fresh run (or a resumed session) starts empty,
   * so the model re-reads rather than editing against state it cannot see.
   */
  type ReadRecord = { sha256: string; mtimeMs: number; size: number };
  const readState = new Map<string, ReadRecord>();

  /** Record a successful read's byte identity (mtime is diagnostic). */
  const rememberRead = async (key: string, bytes: Buffer): Promise<void> => {
    const info = await stat(key).catch(() => undefined);
    readState.set(key, {
      sha256: sha256(bytes),
      mtimeMs: info?.mtimeMs ?? 0,
      size: bytes.byteLength,
    });
  };

  /**
   * Per-canonical-file BODY queues: the mutual exclusion for read/edit/write,
   * keyed by the canonical (realpath) path; a settled tail is dropped.
   */
  const fileQueues = new Map<string, Promise<void>>();

  /**
   * ADMISSION: a single global turn serializes ONLY the async preflight
   * (realpath, touchesGit, pathAllowedEverywhere) so per-file bodies enqueue
   * in ARRIVAL order, not preflight-completion order; unrelated files' bodies
   * still overlap. Gates unchanged.
   */
  let admissionTail: Promise<void> = Promise.resolve();
  const admit = async <T>(
    preflight: () => Promise<{ key: string | undefined; body: () => Promise<T> }>,
  ): Promise<T> => {
    const current = admissionTail.then(preflight, preflight);
    admissionTail = current.then(
      () => undefined,
      () => undefined,
    );
    const { key, body } = await current;
    if (key === undefined) return body(); // denied in preflight — nothing to serialize
    const previous = fileQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const fileTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => fileTurn);
    fileQueues.set(key, tail);
    return previous.then(body).finally(() => {
      release();
      if (fileQueues.get(key) === tail) fileQueues.delete(key);
    });
  };

  const tools: ToolkitTool[] = [];
  const searchTools: ToolkitTool[] = [];
  // `write` is built before `bash` (so the read/edit/write helpers stay
  // together) but pushed AFTER it: the pre-F1 surface was read/edit/run, so
  // an explicit `maxTools: 3` must still yield read/edit/bash.
  let writeTool: ToolkitTool | undefined;

  // --- read -----------------------------------------------------------------
  if (cfg.tools.read.enabled) {
    const fileCfg = cfg.tools.read;
    tools.push({
      name: 'read',
      description: capDescription(
        'Read a workspace text file, returning numbered lines.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: ReadToolInputSchema,
      execute: async (rawInput: unknown): Promise<ToolkitToolResult> => {
        const parsed = ReadToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('read', parsed.error);
        const requested = (parsed.data.file_path ??
          parsed.data.filePath ??
          parsed.data.path) as string;
        const abs = resolveInside(requested);
        if (abs === undefined) {
          return deny(
            'read',
            `PATH_ESCAPE: path escape: '${requested}' resolves outside the workspace`,
          );
        }
        // ADMISSION: the preflight runs inside the ordered admission turn (see
        // admit); the body then enqueues on the canonical path's own queue.
        return admit(async () => {
          const effective = await resolveRealInside(abs);
          if (effective === undefined) {
            return {
              key: undefined,
              body: async () =>
                deny(
                  'read',
                  `PATH_ESCAPE: path escape: '${requested}' escapes the workspace through a symlink`,
                ),
            };
          }
          if (await touchesGit(abs, effective)) {
            return { key: undefined, body: async () => gitDenial('read', abs) };
          }
          if (!(await pathAllowedEverywhere(fileCfg.pathPatterns, abs, effective))) {
            return {
              key: undefined,
              body: async () =>
                deny(
                  'read',
                  `PATH_DENIED: path not allowed by harness config allowlist: '${relOf(abs)}'`,
                ),
            };
          }
          return {
            key: effective,
            body: async (): Promise<ToolkitToolResult> => {
              let bytes: Buffer;
              try {
                bytes = await readFile(effective);
              } catch (err) {
                const reason =
                  errorCode(err) === 'ENOENT'
                    ? `FS_NOT_FOUND: file not found: '${relOf(abs)}'`
                    : `EXECUTION_ERROR: read failed: ${messageOf(err)}`;
                return deny('read', reason);
              }
              if (isBinary(bytes)) {
                return deny(
                  'read',
                  `FS_UNSUPPORTED: read refused: '${relOf(abs)}' is a binary file`,
                );
              }
              const text = decodeUtf8(bytes);
              if (text === undefined) {
                return deny(
                  'read',
                  `FS_UNSUPPORTED: read refused: '${relOf(abs)}' is not valid UTF-8`,
                );
              }
              // Keep the F1 SHA-256 ledger tied to the whole file, even when the
              // model receives only a line window.
              await rememberRead(effective, bytes);
              const lines = text.split(/\r\n|\n|\r/);
              if (lines.at(-1) === '') lines.pop();
              const offset = parsed.data.offset ?? 1;
              const limit = parsed.data.limit ?? DEFAULT_READ_LIMIT;
              const selected = lines.slice(offset - 1, offset - 1 + limit);
              let lineTruncated = false;
              const numbered = selected.map((line, index) => {
                const cappedLine = truncateLine(line, MAX_READ_LINE_CHARS);
                lineTruncated ||= cappedLine.truncated;
                return `${String(offset + index).padStart(6)}: ${cappedLine.text}`;
              });
              const nextOffset = offset + selected.length;
              const windowTruncated = nextOffset <= lines.length;
              const parts = [`--- ${relOf(abs)} ---`, ...numbered];
              if (
                windowTruncated &&
                (fileCfg.maxOutputChars === undefined ||
                  parts.join('\n').length + 80 <= fileCfg.maxOutputChars)
              ) {
                parts.push(`… (truncated; use offset=${nextOffset} to continue)`);
              }
              const capped = capOutputWithMarker(
                parts.join('\n'),
                fileCfg.maxOutputChars,
                `[truncated: output chars cap ${fileCfg.maxOutputChars}] retry offset=${offset} with a smaller limit`,
              );
              const output = capped.output;
              const root = await workspaceRealRoot();
              const resolvedRel =
                root !== undefined && isInside(effective, root)
                  ? relative(root, effective).split(sep).join('/')
                  : relOf(effective);
              // Scan-source provenance is the RAW unformatted selected lines —
              // line-anchored secret rules (^CONFIDENTIAL:) must match the raw
              // source, not the numbered display the model sees. The formatted
              // `output` still rides the model payload; the guard scans BOTH.
              const rawSelected = selected.join('\n');
              const sourceContents = [...new Set([relOf(abs), resolvedRel])].map((path) => ({
                text: rawSelected,
                path,
              }));
              return {
                ok: true,
                output,
                truncated: lineTruncated || windowTruncated || capped.truncated,
                sourceContents,
              };
            },
          };
        });
      },
    });
  }
  // Search is exposed only in a read-only sandbox. The per-op ToolPolicy is
  // still the authority that selects these descriptors for a model request.
  if (cfg.tools.read.enabled && sandbox === 'read-only') {
    searchTools.push({
      name: 'grep',
      description: capDescription(
        'Search text with ripgrep default regex; respects .gitignore. Returns capped lines, paths or matching-line counts. Supports glob, ignore_case and head_limit.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: GrepToolInputSchema,
      execute: async (
        rawInput: unknown,
        options?: ToolExecuteOptions,
      ): Promise<ToolkitToolResult> => {
        const parsed = GrepToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('grep', parsed.error);
        const files = await collectSearchFiles(
          'grep',
          parsed.data.path,
          parsed.data.glob ?? parsed.data.include,
          options?.signal,
        );
        if (!files.ok) return files.denial;
        if (isAborted(options?.signal)) {
          return {
            ok: false,
            denial: { tool: 'grep', reason: 'CANCELLED: cancelled: grep was aborted' },
          };
        }
        const markers = [...files.markers];
        if (files.files.length === 0) {
          const output = ['No matches', ...markers].join('\n');
          const capped = capOutputWithMarker(
            output,
            SEARCH_OUTPUT_CHARS,
            `[truncated: output chars cap ${SEARCH_OUTPUT_CHARS}] Narrow path or pattern to recover remaining results.`,
          );
          if (isAborted(options?.signal)) {
            return {
              ok: false,
              denial: { tool: 'grep', reason: 'CANCELLED: cancelled: grep was aborted' },
            };
          }
          return { ok: true, ...capped, truncated: markers.length > 0 || capped.truncated };
        }

        const args = [
          '--json',
          ...((parsed.data.ignore_case ?? parsed.data['-i'] ?? parsed.data.ignoreCase) === true
            ? ['-i']
            : []),
          '--no-config',
          '--hidden',
          '--color=never',
          '--max-count',
          String(SEARCH_MATCH_LIMIT + 1),
          '-e',
          parsed.data.pattern,
          '--',
          ...files.files.map((file) => file.effectivePath),
        ];
        const result = await runArgvCommand('rg', args, {
          env: buildChildEnv(process.env),
          cwd: workspaceAbs,
          maxBytes: SEARCH_PROCESS_OUTPUT_BYTES,
          timeoutMs: SEARCH_TIMEOUT_MS,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.kind === 'killed') {
          return {
            ok: false,
            denial: {
              tool: 'grep',
              reason: isAborted(options?.signal)
                ? 'CANCELLED: grep was aborted'
                : 'TIMEOUT: grep timed out',
            },
          };
        }
        if (result.kind === 'spawn-error') {
          return {
            ok: false,
            denial: {
              tool: 'grep',
              reason: `EXECUTION_ERROR: grep failed: ${messageOf(result.error)}`,
            },
          };
        }
        if (result.code !== 0 && result.code !== 1) {
          return {
            ok: false,
            denial: {
              tool: 'grep',
              reason: `${/regex parse error|error parsing regex/i.test(result.stderr) ? 'SEARCH_INVALID_PATTERN' : 'EXECUTION_ERROR'}: grep failed: rg exited ${result.code}: ${result.stderr.trim()}`,
            },
          };
        }
        if (isAborted(options?.signal)) {
          return {
            ok: false,
            denial: { tool: 'grep', reason: 'CANCELLED: cancelled: grep was aborted' },
          };
        }

        const byPath = new Map<string, { file: SearchFile; lines: string[]; raw: string[] }>();
        const fileByPath = new Map(files.files.map((file) => [resolve(file.effectivePath), file]));
        let truncatedLine = false;
        let sawMalformedTail = false;
        const jsonLines = result.stdout.split('\n');
        for (const [index, line] of jsonLines.entries()) {
          if (line.length === 0) continue;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            if (result.overflowed && index === jsonLines.length - 1) {
              sawMalformedTail = true;
              continue;
            }
            return {
              ok: false,
              denial: {
                tool: 'grep',
                reason: 'EXECUTION_ERROR: grep denied: rg returned malformed JSON output',
              },
            };
          }
          if (typeof event !== 'object' || event === null || !('type' in event)) continue;
          const typed = event as {
            type?: unknown;
            data?: {
              path?: { text?: unknown; bytes?: unknown };
              lines?: { text?: unknown; bytes?: unknown };
              line_number?: unknown;
            };
          };
          if (typed.type !== 'match') continue;
          const data = typed.data;
          if (
            data === undefined ||
            typeof data.path?.text !== 'string' ||
            typeof data.lines?.text !== 'string' ||
            typeof data.line_number !== 'number'
          ) {
            return {
              ok: false,
              denial: {
                tool: 'grep',
                reason: 'EXECUTION_ERROR: grep denied: rg returned non-text path or match data',
              },
            };
          }
          const file = fileByPath.get(resolve(workspaceAbs, data.path.text));
          if (file === undefined) {
            return {
              ok: false,
              denial: {
                tool: 'grep',
                reason:
                  'EXECUTION_ERROR: grep denied: rg returned a path outside the allowed file list',
              },
            };
          }
          const key = resolve(file.effectivePath);
          const group = byPath.get(key) ?? { file, lines: [], raw: [] };
          const rawLine = data.lines.text.replace(/\r?\n$/, '');
          const cappedLine = truncateLine(rawLine, SEARCH_LINE_CHARS);
          truncatedLine ||= cappedLine.truncated;
          group.lines.push(`${data.line_number}: ${cappedLine.text}`);
          // Raw unformatted line kept alongside: scan provenance must see the
          // anchorable source text (^CONFIDENTIAL:), not the numbered display.
          group.raw.push(rawLine);
          byPath.set(key, group);
        }

        if (result.overflowed) {
          markers.push(`[truncated: rg process output bytes cap ${SEARCH_PROCESS_OUTPUT_BYTES}]`);
        }
        if (sawMalformedTail) {
          markers.push('[truncated: rg process output ended mid-record]');
        }
        const groups = [...byPath.values()].sort((left, right) =>
          left.file.lexicalRel.localeCompare(right.file.lexicalRel),
        );
        const allMatches = groups.reduce((count, group) => count + group.lines.length, 0);
        const keptGroups: { file: SearchFile; lines: string[]; raw: string[] }[] = [];
        const matchLimit =
          parsed.data.output_mode === undefined || parsed.data.output_mode === 'content'
            ? Math.min(parsed.data.head_limit || SEARCH_MATCH_LIMIT, SEARCH_MATCH_LIMIT)
            : SEARCH_MATCH_LIMIT;
        let remaining = matchLimit;
        for (const group of groups) {
          if (remaining <= 0) break;
          const lines = group.lines.slice(0, remaining);
          const raw = group.raw.slice(0, remaining);
          keptGroups.push({ file: group.file, lines, raw });
          remaining -= lines.length;
        }
        if (allMatches > matchLimit) {
          markers.push(`[truncated: matches cap ${matchLimit}]`);
        }
        if (truncatedLine) markers.push(`[truncated: per-line chars cap ${SEARCH_LINE_CHARS}]`);

        const mode = parsed.data.output_mode ?? 'content';
        const rows =
          mode === 'content'
            ? keptGroups.flatMap(({ file, lines }) => [`--- ${file.lexicalRel} ---`, ...lines])
            : keptGroups.map(({ file, lines }) =>
                mode === 'count'
                  ? `${file.lexicalRel}:${lines.length}${markers.length > 0 ? '+' : ''}`
                  : file.lexicalRel,
              );
        if (mode === 'count' && markers.length > 0)
          markers.push('[truncated: counts marked + are lower bounds within search limits]');
        const rowLimit = parsed.data.head_limit || rows.length;
        const outputParts = mode === 'content' ? rows : rows.slice(0, rowLimit);
        if (mode !== 'content' && rows.length > rowLimit)
          markers.push(`[truncated: head_limit ${rowLimit}]`);
        if (outputParts.length === 0) outputParts.push('No matches');
        if (markers.length > 0)
          markers.push('[truncated: narrow path or pattern to recover remaining results]');
        outputParts.push(...markers);
        const outputBeforeCap = outputParts.join('\n');
        const capped = capOutputWithMarker(
          outputBeforeCap,
          SEARCH_OUTPUT_CHARS,
          `[truncated: output chars cap ${SEARCH_OUTPUT_CHARS}] Narrow path or pattern to recover remaining results.`,
        );
        // Scan-source provenance is the RAW unformatted matched lines (the
        // scan guard sees anchorable source text); the numbered display rides
        // the model payload. Same raw-plus-formatted contract as read.
        const sourceContents = keptGroups.flatMap(({ file, raw }) =>
          [...new Set([file.lexicalRel, file.resolvedRel])].map((path) => ({
            path,
            text: raw.join('\n'),
          })),
        );
        if (isAborted(options?.signal)) {
          return {
            ok: false,
            denial: { tool: 'grep', reason: 'CANCELLED: cancelled: grep was aborted' },
          };
        }
        return {
          ok: true,
          output: capped.output,
          truncated: markers.length > 0 || truncatedLine || capped.truncated,
          sourceContents,
        };
      },
    });

    searchTools.push({
      name: 'glob',
      description: capDescription(
        'Find files by ripgrep glob (** spans directories), including hidden and ignored files. Excludes VCS directories; results capped.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: GlobToolInputSchema,
      execute: async (
        rawInput: unknown,
        options?: ToolExecuteOptions,
      ): Promise<ToolkitToolResult> => {
        const parsed = GlobToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('glob', parsed.error);
        const files = await collectSearchFiles(
          'glob',
          parsed.data.path,
          parsed.data.pattern,
          options?.signal,
        );
        if (!files.ok) return files.denial;
        if (isAborted(options?.signal)) {
          return {
            ok: false,
            denial: { tool: 'glob', reason: 'CANCELLED: cancelled: glob was aborted' },
          };
        }
        const outputParts = files.files.map((file) => file.lexicalRel);
        if (outputParts.length === 0) outputParts.push('No files found');
        outputParts.push(...files.markers);
        const capped = capOutputWithMarker(
          outputParts.join('\n'),
          SEARCH_OUTPUT_CHARS,
          `[truncated: output chars cap ${SEARCH_OUTPUT_CHARS}] Narrow path or pattern to recover remaining results.`,
        );
        if (isAborted(options?.signal)) {
          return {
            ok: false,
            denial: { tool: 'glob', reason: 'CANCELLED: cancelled: glob was aborted' },
          };
        }
        return {
          ok: true,
          ...capped,
          truncated: files.markers.length > 0 || capped.truncated,
        };
      },
    });
  }

  // --- edit -----------------------------------------------------------------
  if (cfg.tools.edit.enabled) {
    const fileCfg = cfg.tools.edit;
    tools.push({
      name: 'edit',
      description: capDescription(
        'Replace exact text in an existing file. Requires a prior read of that file.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: EditToolInputSchema,
      execute: async (rawInput: unknown): Promise<ToolkitToolResult> => {
        if (sandbox === 'read-only') return deny('edit', 'PATH_DENIED: sandbox: read-only');
        const parsed = EditToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('edit', parsed.error);
        const path = (parsed.data.file_path ?? parsed.data.filePath ?? parsed.data.path) as string;
        const oldString = (parsed.data.old_string ??
          parsed.data.oldString ??
          parsed.data.oldText) as string;
        const newString = (parsed.data.new_string ??
          parsed.data.newString ??
          parsed.data.newText) as string;
        const replaceAll = (parsed.data.replace_all ?? parsed.data.replaceAll) === true;
        const abs = resolveInside(path);
        if (abs === undefined) {
          return deny('edit', `PATH_ESCAPE: path escape: '${path}' resolves outside the workspace`);
        }
        // ADMISSION: preflight inside the ordered admission turn (see admit).
        return admit(async () => {
          const effective = await resolveRealInside(abs);
          if (effective === undefined) {
            return {
              key: undefined,
              body: async () =>
                deny(
                  'edit',
                  `PATH_ESCAPE: path escape: '${path}' escapes the workspace through a symlink`,
                ),
            };
          }
          if (await touchesGit(abs, effective)) {
            return { key: undefined, body: async () => gitDenial('edit', abs) };
          }
          if (!(await pathAllowedEverywhere(fileCfg.pathPatterns, abs, effective))) {
            return {
              key: undefined,
              body: async () =>
                deny(
                  'edit',
                  `PATH_DENIED: path not allowed by harness config allowlist: '${relOf(abs)}'`,
                ),
            };
          }
          return {
            key: effective,
            body: async (): Promise<ToolkitToolResult> => {
              let bytes: Buffer;
              try {
                bytes = await readFile(effective);
              } catch (err) {
                const reason =
                  errorCode(err) === 'ENOENT'
                    ? `FS_NOT_FOUND: file not found: '${relOf(abs)}'`
                    : `EXECUTION_ERROR: read failed: ${messageOf(err)}`;
                return deny('edit', reason);
              }
              const label = relOf(abs);
              if (isBinary(bytes))
                return deny('edit', `FS_UNSUPPORTED: edit refused: '${label}' is a binary file`);
              const text = decodeUtf8(bytes);
              if (text === undefined) {
                return deny('edit', `FS_UNSUPPORTED: edit refused: '${label}' is not valid UTF-8`);
              }
              const prior = readState.get(effective);
              if (prior === undefined) {
                return deny(
                  'edit',
                  `FS_NOT_READ: edit refused: '${label}' must be read before it is edited`,
                );
              }
              if (prior.sha256 !== sha256(bytes)) {
                return deny(
                  'edit',
                  `FS_STALE: edit refused: '${label}' changed since it was read; read it again`,
                );
              }
              const bom = text.startsWith(BOM);
              const body = stripBom(text);
              const needle = toLf(oldString);
              const ending = dominantLineEnding(body);
              const replacementLf = toLf(newString);
              // New text follows the file's dominant convention; existing bytes
              // outside the replaced spans are never normalised or rewritten.
              const replacement =
                ending === '\r\n' ? replacementLf.replace(/\n/g, '\r\n') : replacementLf;
              // Only two starts are needed to establish ambiguity.
              const overlapping = findMatches(body, needle, true, 2);
              if (overlapping.length === 0) {
                return deny(
                  'edit',
                  `EDIT_NO_MATCH: edit refused: target text not found in '${label}'`,
                );
              }
              if (overlapping.length > 1 && !replaceAll) {
                return deny(
                  'edit',
                  `EDIT_AMBIGUOUS: edit refused: target text is not unique in '${label}' ` +
                    '(multiple possible matches, overlapping included); ' +
                    'pass replace_all: true to replace every non-overlapping occurrence',
                );
              }
              // replace_all uses the standard NON-overlapping semantics and
              // reports how many spans it actually replaced; a single edit takes
              // the first non-overlapping span. Literal replacement: no
              // `$&`/`$1` substitution.
              const nonOverlapping = findMatches(
                body,
                needle,
                false,
                replaceAll ? Number.POSITIVE_INFINITY : 1,
              );
              const spans = replaceAll ? nonOverlapping : nonOverlapping.slice(0, 1);
              const edited = applySpans(body, spans, replacement);
              const output = `${bom ? BOM : ''}${edited}`;
              try {
                await writeFile(effective, output, 'utf8');
              } catch (err) {
                return deny('edit', `EXECUTION_ERROR: edit failed: ${messageOf(err)}`);
              }
              await rememberRead(effective, Buffer.from(output, 'utf8'));
              const replaced = spans.length;
              const capped = capOutput(
                `edited '${label}': replaced ${replaced} ${replaced === 1 ? 'occurrence' : 'occurrences'}`,
                fileCfg.maxOutputChars,
              );
              return { ok: true, ...capped };
            },
          };
        });
      },
    });
  }

  // --- write ------------------------------------------------------------------
  if (cfg.tools.write.enabled) {
    const fileCfg = cfg.tools.write;
    writeTool = {
      name: 'write',
      description: capDescription(
        'Create or replace a text file. Read existing files before overwriting.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: WriteToolInputSchema,
      execute: async (rawInput: unknown): Promise<ToolkitToolResult> => {
        if (sandbox === 'read-only') return deny('write', 'PATH_DENIED: sandbox: read-only');
        const parsed = WriteToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('write', parsed.error);
        const path = (parsed.data.file_path ?? parsed.data.filePath ?? parsed.data.path) as string;
        const content = parsed.data.content;
        const abs = resolveInside(path);
        if (abs === undefined) {
          return deny(
            'write',
            `PATH_ESCAPE: path escape: '${path}' resolves outside the workspace`,
          );
        }
        // ADMISSION: preflight inside the ordered admission turn (see admit).
        return admit(async () => {
          let effective = await resolveRealInside(abs);
          if (effective === undefined) {
            return {
              key: undefined,
              body: async () =>
                deny(
                  'write',
                  `PATH_ESCAPE: path escape: '${path}' escapes the workspace through a symlink`,
                ),
            };
          }
          // A MISSING target has no realpath, so resolveRealInside fell back to
          // the lexical path. Decide a new file's containment by its PARENT's
          // realpath (a symlinked parent must not create outside the
          // workspace), and refuse a dangling symlink outright: writeFile would
          // otherwise follow it to an unchecked destination.
          const link = await lstat(abs).catch(() => undefined);
          if (link === undefined) {
            const parent = await resolveRealInside(dirname(abs));
            if (parent === undefined) {
              return {
                key: undefined,
                body: async () =>
                  deny(
                    'write',
                    `PATH_ESCAPE: path escape: '${path}' escapes the workspace through a symlink`,
                  ),
              };
            }
            effective = join(parent, basename(abs));
          } else if (link.isSymbolicLink() && effective === abs) {
            return {
              key: undefined,
              body: async () =>
                deny(
                  'write',
                  `FS_UNSUPPORTED: write refused: '${relOf(abs)}' is a symlink that does not resolve`,
                ),
            };
          }
          if (await touchesGit(abs, effective)) {
            return { key: undefined, body: async () => gitDenial('write', abs) };
          }
          if (!(await pathAllowedEverywhere(fileCfg.pathPatterns, abs, effective))) {
            return {
              key: undefined,
              body: async () =>
                deny(
                  'write',
                  `PATH_DENIED: path not allowed by harness config allowlist: '${relOf(abs)}'`,
                ),
            };
          }
          return {
            key: effective,
            body: async (): Promise<ToolkitToolResult> => {
              const label = relOf(abs);
              let existing: Buffer | undefined;
              try {
                existing = await readFile(effective);
              } catch (err) {
                if (errorCode(err) !== 'ENOENT') {
                  return deny('write', `EXECUTION_ERROR: write failed: ${messageOf(err)}`);
                }
              }
              let output = content;
              if (existing !== undefined) {
                if (isBinary(existing)) {
                  return deny(
                    'write',
                    `FS_UNSUPPORTED: write refused: '${label}' is a binary file`,
                  );
                }
                const text = decodeUtf8(existing);
                if (text === undefined) {
                  return deny(
                    'write',
                    `FS_UNSUPPORTED: write refused: '${label}' is not valid UTF-8`,
                  );
                }
                const prior = readState.get(effective);
                if (prior === undefined) {
                  return deny(
                    'write',
                    `FS_NOT_READ: write refused: '${label}' must be read before it is overwritten`,
                  );
                }
                if (prior.sha256 !== sha256(existing)) {
                  return deny(
                    'write',
                    `FS_STALE: write refused: '${label}' changed since it was read; read it again`,
                  );
                }
                // Preserve the existing file's BOM and line-ending convention.
                output = restoreTextStyle(
                  toLf(stripBom(content)),
                  text.startsWith(BOM),
                  dominantLineEnding(text),
                );
              }
              try {
                await writeFile(effective, output, 'utf8');
              } catch (err) {
                return deny('write', `EXECUTION_ERROR: write failed: ${messageOf(err)}`);
              }
              await rememberRead(effective, Buffer.from(output, 'utf8'));
              const capped = capOutput(
                `wrote '${label}': ${Buffer.byteLength(output, 'utf8')} bytes`,
                fileCfg.maxOutputChars,
              );
              return { ok: true, ...capped };
            },
          };
        });
      },
    };
  }

  // --- bash -------------------------------------------------------------------
  if (cfg.tools.bash.enabled && gate.enabled) {
    // Validate the complete launcher environment before exposing an executor.
    // A malformed or policy-bearing passthrough must fail during tool
    // construction, never later inside a model-directed command.
    buildSandboxLauncherEnv({}, gate);
    const runCfg = cfg.tools.bash;
    const patterns = compileCommandPatterns(runCfg.commandPatterns); // loud on config corruption
    const formatOutcome = (
      exitCode: number | null,
      killed: boolean,
      stdout: string,
      stderr: string,
      signal?: AbortSignal,
    ): string => {
      const parts = [
        killed
          ? `${isAborted(signal) ? 'CANCELLED' : 'TIMEOUT'}: killed by signal (exit ${exitCode})`
          : `exit ${exitCode}`,
      ];
      if (stdout !== '') parts.push(`--- stdout ---\n${stdout}`);
      if (stderr !== '') parts.push(`--- stderr ---\n${stderr}`);
      return parts.join('\n');
    };
    const settle = (outcome: RunOutcome, signal?: AbortSignal): ToolkitToolResult => {
      // Normal exits (including nonzero) and kills remain tool results.
      // Only spawn-level failures are denials.
      if (outcome.kind === 'spawn-error') {
        return deny('bash', `EXECUTION_ERROR: bash failed: ${messageOf(outcome.error)}`);
      }
      const killed = outcome.kind === 'killed';
      const exitCode = killed ? null : outcome.code;
      const capped = capOutput(
        formatOutcome(exitCode, killed, outcome.stdout, outcome.stderr, signal),
        runCfg.maxOutputChars,
      );
      return {
        ok: true,
        exitCode,
        killed,
        output: capped.output,
        truncated: capped.truncated || outcome.overflowed,
      };
    };
    tools.push({
      name: 'bash',
      description: capDescription(
        'Run an allowed command in a fresh shell. Cwd defaults to workspace; workdir stays inside it. timeout is milliseconds, capped. description is logged; background unsupported.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: BashToolInputSchema,
      // The pre-F1 model-facing name, accepted for one release.
      aliases: toolAliases('bash'),
      execute: async (rawInput: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult> => {
        if (sandbox === 'read-only') return deny('bash', 'PATH_DENIED: sandbox: read-only');
        const parsed = BashToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('bash', parsed.error);
        const { command } = parsed.data;
        const timeout = parsed.data.timeout ?? parsed.data.timeoutMs;
        const requestedCwd = parsed.data.workdir ?? parsed.data.cwd ?? '.';
        const lexicalCwd = resolveInside(requestedCwd);
        if (lexicalCwd === undefined)
          return deny(
            'bash',
            `PATH_ESCAPE: path escape: workdir '${requestedCwd}' resolves outside the workspace`,
          );
        const cwd = await resolveRealInside(lexicalCwd);
        if (cwd === undefined)
          return deny(
            'bash',
            `PATH_ESCAPE: path escape: workdir '${requestedCwd}' escapes the workspace through a symlink`,
          );
        if (await touchesGit(lexicalCwd, cwd)) return gitDenial('bash', lexicalCwd);

        let env: Record<string, string>;
        try {
          // Scrub at the shared core on every transport; never depend on an
          // MCP launcher having already filtered the parent environment. The
          // sandbox launcher scrub runs first, so its stricter defaults and
          // policy-knob refusal also cover closed-form git execution.
          env = buildChildEnv(buildSandboxLauncherEnv(process.env, gate), undefined, [
            ...gate.envPassthrough,
            ...(gate.declaredEnvNames ?? []),
          ]);
        } catch (error) {
          return deny('bash', `EXECUTION_ERROR: bash failed: ${messageOf(error)}`);
        }
        // A model-supplied timeout may only SHORTEN the config's policy bound.
        const timeoutMs =
          runCfg.timeoutMs === undefined
            ? timeout
            : timeout === undefined
              ? runCfg.timeoutMs
              : Math.min(runCfg.timeoutMs, timeout);
        const executionOptions: RunCommandOptions = {
          cwd,
          env,
          // Retain UTF-8 and wrapper slack above the configured character cap.
          maxBytes:
            runCfg.maxOutputChars !== undefined
              ? runCfg.maxOutputChars * 4 + 65_536
              : UNCAPPED_RETENTION_BYTES,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        };
        const raw = command.trim().split(/\s+/);
        // An attached shell operator (git diff; …) must not bypass the lock
        // under a regex grant. Quoted/disguised verbs remain author-owned.
        const verb = raw[1]?.match(/^[a-z-]*/)?.[0];
        if (raw[0] === 'git' && (verb === 'diff' || verb === 'log')) {
          const forms = verb === 'diff' ? CLOSED_GIT_DIFF : CLOSED_GIT_LOG;
          const key = raw.join(' ');
          const argv = forms.get(key);
          if (argv === undefined || !commandVerdict(patterns, key).allowed) {
            return deny(
              'bash',
              `CMD_DENIED: command allowlist: git ${verb} is closed-form — use exactly one of: ${[...forms.keys()].join('; ')}`,
            );
          }
          return settle(await runArgvCommand('git', argv, executionOptions), opts?.signal);
        }
        const verdict = commandVerdict(patterns, command);
        if (!verdict.allowed) {
          return deny(
            'bash',
            verdict.metacharacters
              ? 'CMD_DENIED: command allowlist: shell metacharacters not permitted with token patterns — use re: with anchoring'
              : `CMD_DENIED: command not allowed by harness config allowlist: '${command}'`,
          );
        }
        return settle(await runShellCommand(command, executionOptions), opts?.signal);
      },
    });
  }

  if (writeTool !== undefined) tools.push(writeTool);

  // Keep the four established tools ahead of search tools so a constrained
  // prompt budget never hides the sandbox-denial surface. The default budget
  // includes both search tools; smaller explicit budgets retain prior order.
  tools.push(...searchTools);

  // Sandbox gate for the WRITE tools lives INSIDE their executors (read-only
  // keeps `read`, denies edit/write/bash with the documented reason — the
  // tools stay on the surface so the denial is observable, per the
  // sandbox-mapping contract).

  // R4: maxTools is DATA — slice the surface to the configured count.
  return tools.slice(0, promptBudget.maxTools);
}

// ---------------------------------------------------------------------------
// The rg capability probe (harness layer owns the clock)
// ---------------------------------------------------------------------------

/** The minimum ripgrep the search tools need at runtime (CI pins 15.2.0 separately). */
export const RG_MINIMUM_VERSION = '11.0.0';

/** Parse `rg --version` output: `ripgrep 15.2.0` (or `-rev` suffixes). */
export const parseRgVersion = (line: string | undefined): string | undefined => {
  const match = /^ripgrep (\d+\.\d+\.\d+)/.exec(line ?? '');
  return match?.[1];
};

/** Numeric-major/minor/patch comparison: true when `found` >= `minimum`. */
export const versionAtLeast = (found: string, minimum: string): boolean => {
  const parse = (v: string): [number, number, number] => {
    const [major, minor, patch] = v.split('.').map((n) => Number.parseInt(n, 10));
    return [major ?? 0, minor ?? 0, patch ?? 0];
  };
  const [fm, fn, fp] = parse(found);
  const [tm, tn, tp] = parse(minimum);
  return fm !== tm ? fm > tm : fn !== tn ? fn > tn : fp >= tp;
};

export type RgProbeOutcome =
  | { ok: true; version: string }
  | { ok: false; reason: 'absent' | 'old'; found?: string };

/**
 * The production rg probe — HARNESS LAYER, which owns the clock legally
 * (`runArgvCommand`'s timeoutMs kills the process group; src/driver/** owns
 * no setTimeout/AbortController per the I8 hygiene rule). ONE bounded
 * `rg --version` child with a 5s process-group timeout, cancellation via
 * the run's signal. Resolves to the outcome only — never the binary path.
 * Drivers inject this as their `resolveRg` default.
 */
export const probeRgVersion = (signal?: AbortSignal): Promise<RgProbeOutcome> =>
  runArgvCommand('rg', ['--version'], {
    env: buildChildEnv(process.env),
    cwd: process.cwd(),
    maxBytes: 4096,
    timeoutMs: 5_000,
    ...(signal === undefined ? {} : { signal }),
  }).then((outcome): RgProbeOutcome => {
    if (outcome.kind !== 'exit' || outcome.code !== 0) return { ok: false, reason: 'absent' };
    const version = parseRgVersion(outcome.stdout.split('\n')[0]);
    if (version === undefined) return { ok: false, reason: 'absent' };
    return versionAtLeast(version, RG_MINIMUM_VERSION)
      ? { ok: true, version }
      : { ok: false, reason: 'old', found: version };
  });
