// Toolkit-owned minimal tool set — T1.4 slice 1 (read/edit/run, per-op allowlists).
//
// R4: the tool surface and its budgets are PER-OP CONFIG (data from
// config.ts), never hardcoded constants. What IS fixed here is the minimal
// tool DEFINITIONS themselves — names, descriptions, input schemas — the
// harness's small plain-data surface every driver adapter can map onto its
// own SDK tool format. Driver-agnostic by construction: NO vendor imports
// in src/harness/**; the ai-sdk driver (slice 2) adapts these descriptors.
//
// DENIAL FLOW — executors never throw. Every refusal (sandbox, bad input,
// path escape, allowlist miss, missing file, missing target text, failed
// command spawn) is a structured denial record `{ tool, reason }` — exactly
// the FROZEN driver-seam ToolDenial shape, so denials flow into
// WorkerResult.denials verbatim. Denial reasons are human-readable strings
// with stable PREFIXES (slice 3's conformance suite asserts on these):
//   'sandbox: …' | 'invalid input: …' | 'path escape: …'
//   'path not allowed by harness config allowlist: …'
//   'command not allowed by harness config allowlist: …'
//   'file not found: …' | 'read failed: …' | 'edit refused: …'
//   'edit failed: …' | 'run failed: …'
//
// ENFORCEMENT ORDER per call: sandbox gate → input schema → workspace
// containment → config allowlist → execution (fs / child_process). Each step
// short-circuits into a denial.
//
// SANDBOX MAPPING (driver seam SandboxLevel):
//   - 'read-only'       → `edit`/`run` deny with 'sandbox: read-only'; `read`
//                         stays available.
//   - 'none' | 'workspace-write' → tools behave per config.
//   True OS sandboxing is a DRIVER-specific concern; the harness enforces
//   the workspace boundary (lexical path containment) + allowlists only.
//
// PATH PATTERN SEMANTICS (the read/edit allowlist): glob-ish strings matched
// against the workspace-relative POSIX path ('/' separators), FULL match:
//   - '**' spans whole path segments (zero or more; as the last segment it
//     matches everything below, e.g. 'src/**' matches 'src' itself too),
//   - '*' matches any chars WITHIN one segment (never crosses '/'),
//   - '?' matches one non-separator char; everything else is literal.
//
// COMMAND PATTERN SEMANTICS (the run allowlist), matched against the FULL
// command string, case-sensitive, first match allows:
//   - 're:<js regex>'  → the rest is a JavaScript RegExp tested against the
//     command string.
//   - anything else    → whitespace-token PREFIX: the pattern's tokens must
//     equal the command's leading tokens ('npm test' allows 'npm test' and
//     'npm test -- --watch', not 'npm run test'). Token splitting is naive
//     whitespace splitting — quoting is NOT parsed; use 're:' when a command
//     needs quoted arguments.
// Invalid regexes and empty/whitespace-only patterns throw at `buildTools`
// time — config corruption is a loud error, never a silent allow-all.
//
// `run` executes through the SHELL (node:child_process exec, cwd =
// workspace) so pipelines work; the allowlist is the gate over the whole
// command string. Config timeoutMs maps onto exec's own timeout (child
// killed by signal → exitCode null + killed flag); captured output is
// head-truncated to maxOutputChars with `truncated: true`. read/edit have no
// wall-clock of their own: local fs ops need no timer, and wall-clock POLICY
// belongs to the driver/governor (I8) — hence FileToolConfig carries only an
// output cap.
import { exec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SandboxLevel, ToolDenial } from '../driver/types.js';
import { HarnessConfigSchema } from './config.js';
import type { HarnessConfig } from './config.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Tool inputs — zod schemas, exported for driver adapters
// ---------------------------------------------------------------------------

export const ReadToolInputSchema = z.object({ path: z.string().min(1) }).strict();

export const EditToolInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
}).strict();

export const RunToolInputSchema = z.object({ command: z.string().min(1) }).strict();

export type ReadToolInput = z.infer<typeof ReadToolInputSchema>;
export type EditToolInput = z.infer<typeof EditToolInputSchema>;
export type RunToolInput = z.infer<typeof RunToolInputSchema>;

/** The three toolkit tool names — the fixed minimal surface. */
export type ToolkitToolName = 'read' | 'edit' | 'run';

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
      /** `run` only: 0–nonzero on a normal exit, null when signal-killed. */
      exitCode?: number | null;
      /** `run` only: true when the process was killed by a signal (timeout). */
      killed?: boolean;
    }
  | { ok: false; denial: ToolDenial };

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
      execute(input: unknown): Promise<ToolkitToolResult>;
    }
  | {
      name: 'edit';
      description: string;
      inputSchema: typeof EditToolInputSchema;
      execute(input: unknown): Promise<ToolkitToolResult>;
    }
  | {
      name: 'run';
      description: string;
      inputSchema: typeof RunToolInputSchema;
      execute(input: unknown): Promise<ToolkitToolResult>;
    };

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
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
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
 * empty/whitespace-only pattern — config corruption is loud (an empty
 * pattern would otherwise silently allow every command).
 */
export function compileCommandPatterns(patterns: readonly string[]): CommandPattern[] {
  return patterns.map((raw) => {
    if (raw.startsWith('re:')) {
      return { kind: 'regex', re: new RegExp(raw.slice('re:'.length)) };
    }
    const tokens = raw.trim().split(/\s+/).filter((token) => token !== '');
    if (tokens.length === 0) {
      throw new Error(`harness: empty run command pattern '${raw}' (empty patterns would allow every command)`);
    }
    return { kind: 'tokens', tokens };
  });
}

/** Full-match the compiled command allowlist against a command string. */
function commandAllowed(patterns: readonly CommandPattern[], command: string): boolean {
  const cmdTokens = command.trim().split(/\s+/);
  return patterns.some((pattern) => {
    if (pattern.kind === 'regex') return pattern.re.test(command);
    return pattern.tokens.every((token, i) => cmdTokens[i] === token);
  });
}

// ---------------------------------------------------------------------------
// buildTools — descriptors + executors bound to one workspace
// ---------------------------------------------------------------------------

/** Small local helper (same pattern as runner.ts): message of an unknown throwable. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Node error code of an unknown throwable, when it carries one. */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Head-truncate to the configured cap; omitted cap = uncapped (explicit config choice). */
function capOutput(text: string, maxChars: number | undefined): { output: string; truncated: boolean } {
  if (maxChars === undefined || text.length <= maxChars) {
    return { output: text, truncated: false };
  }
  return { output: text.slice(0, maxChars), truncated: true };
}

/** Head-truncate a tool description to the prompt-budget cap, ellipsis-marked. */
function capDescription(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
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
): ToolkitTool[] {
  const cfg: HarnessConfig = HarnessConfigSchema.parse(config);
  const workspaceAbs = resolve(workspace);
  const workspacePrefix = workspaceAbs.endsWith(sep) ? workspaceAbs : workspaceAbs + sep;
  const { promptBudget } = cfg;

  const deny = (tool: ToolkitToolName, reason: string): ToolkitToolResult => ({
    ok: false,
    denial: { tool, reason },
  });

  /** Lexical containment: an absolute path inside the workspace, or undefined on escape. */
  const resolveInside = (requested: string): string | undefined => {
    const abs = resolve(workspaceAbs, requested);
    return abs === workspaceAbs || abs.startsWith(workspacePrefix) ? abs : undefined;
  };

  const relOf = (abs: string): string => relative(workspaceAbs, abs).split(sep).join('/');

  const pathAllowed = (patterns: readonly string[], abs: string): boolean =>
    compilePathPatterns(patterns).some((re) => re.test(relOf(abs)));

  const invalidInput = (tool: ToolkitToolName, err: z.ZodError): ToolkitToolResult =>
    deny(tool, `invalid input: ${messageOf(err)}`);

  const tools: ToolkitTool[] = [];

  // --- read -----------------------------------------------------------------
  if (cfg.tools.read.enabled) {
    const fileCfg = cfg.tools.read;
    tools.push({
      name: 'read',
      description: capDescription(
        'Read a text file from the workspace and return its contents. ' +
          'Input: { path } — a path inside the workspace, resolved against the workspace root.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: ReadToolInputSchema,
      execute: async (rawInput: unknown): Promise<ToolkitToolResult> => {
        const parsed = ReadToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('read', parsed.error);
        const abs = resolveInside(parsed.data.path);
        if (abs === undefined) {
          return deny('read', `path escape: '${parsed.data.path}' resolves outside the workspace`);
        }
        if (!pathAllowed(fileCfg.pathPatterns, abs)) {
          return deny('read', `path not allowed by harness config allowlist: '${relOf(abs)}'`);
        }
        let content: string;
        try {
          content = await readFile(abs, 'utf8');
        } catch (err) {
          const reason =
            errorCode(err) === 'ENOENT'
              ? `file not found: '${relOf(abs)}'`
              : `read failed: ${messageOf(err)}`;
          return deny('read', reason);
        }
        const capped = capOutput(content, fileCfg.maxOutputChars);
        return { ok: true, ...capped };
      },
    });
  }

  // --- edit -----------------------------------------------------------------
  if (cfg.tools.edit.enabled) {
    const fileCfg = cfg.tools.edit;
    tools.push({
      name: 'edit',
      description: capDescription(
        'Replace the first occurrence of a target string in a workspace text file. ' +
          'Input: { path, oldText, newText } — refuses when oldText does not appear in the file.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: EditToolInputSchema,
      execute: async (rawInput: unknown): Promise<ToolkitToolResult> => {
        if (sandbox === 'read-only') return deny('edit', 'sandbox: read-only');
        const parsed = EditToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('edit', parsed.error);
        const { path, oldText, newText } = parsed.data;
        const abs = resolveInside(path);
        if (abs === undefined) {
          return deny('edit', `path escape: '${path}' resolves outside the workspace`);
        }
        if (!pathAllowed(fileCfg.pathPatterns, abs)) {
          return deny('edit', `path not allowed by harness config allowlist: '${relOf(abs)}'`);
        }
        let content: string;
        try {
          content = await readFile(abs, 'utf8');
        } catch (err) {
          const reason =
            errorCode(err) === 'ENOENT'
              ? `file not found: '${relOf(abs)}'`
              : `read failed: ${messageOf(err)}`;
          return deny('edit', reason);
        }
        if (!content.includes(oldText)) {
          return deny('edit', `edit refused: target text not found in '${relOf(abs)}'`);
        }
        // String.prototype.replace with a STRING search swaps the FIRST
        // occurrence; the function replacer keeps `$` sequences in newText
        // literal (no $&/$1 substitution).
        const edited = content.replace(oldText, () => newText);
        try {
          await writeFile(abs, edited, 'utf8');
        } catch (err) {
          return deny('edit', `edit failed: ${messageOf(err)}`);
        }
        const capped = capOutput(`edited '${relOf(abs)}': replaced 1 occurrence`, fileCfg.maxOutputChars);
        return { ok: true, ...capped };
      },
    });
  }

  // --- run --------------------------------------------------------------------
  if (cfg.tools.run.enabled) {
    const runCfg = cfg.tools.run;
    const patterns = compileCommandPatterns(runCfg.commandPatterns); // loud on config corruption
    const formatOutcome = (
      exitCode: number | null,
      killed: boolean,
      stdout: string,
      stderr: string,
    ): string => {
      const parts = [killed ? `killed by signal (exit ${exitCode})` : `exit ${exitCode}`];
      if (stdout !== '') parts.push(`--- stdout ---\n${stdout}`);
      if (stderr !== '') parts.push(`--- stderr ---\n${stderr}`);
      return parts.join('\n');
    };
    tools.push({
      name: 'run',
      description: capDescription(
        'Execute a shell command inside the workspace and capture its stdout, stderr, and exit code. ' +
          'Input: { command }. Governed by the configured command allowlist, timeout, and output cap.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: RunToolInputSchema,
      execute: async (rawInput: unknown): Promise<ToolkitToolResult> => {
        if (sandbox === 'read-only') return deny('run', 'sandbox: read-only');
        const parsed = RunToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('run', parsed.error);
        const command = parsed.data.command;
        if (!commandAllowed(patterns, command)) {
          return deny('run', `command not allowed by harness config allowlist: '${command}'`);
        }
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: workspaceAbs,
            ...(runCfg.timeoutMs !== undefined ? { timeout: runCfg.timeoutMs } : {}),
          });
          const capped = capOutput(formatOutcome(0, false, stdout, stderr), runCfg.maxOutputChars);
          return { ok: true, exitCode: 0, killed: false, ...capped };
        } catch (err) {
          // promisify(exec) rejects on nonzero exit / signal kill with the
          // captured streams attached; a spawn failure (e.g. no shell) has a
          // STRING code. Nonzero exits are REAL tool results (the model must
          // see them), not denials — only spawn-level failures deny.
          const e = err as Error & {
            code?: string | number | null;
            killed?: boolean;
            signal?: string | null;
            stdout?: string;
            stderr?: string;
          };
          const stdout = e.stdout ?? '';
          const stderr = e.stderr ?? '';
          if (typeof e.code === 'number') {
            const capped = capOutput(formatOutcome(e.code, false, stdout, stderr), runCfg.maxOutputChars);
            return { ok: true, exitCode: e.code, killed: false, ...capped };
          }
          if (e.killed === true) {
            const capped = capOutput(formatOutcome(null, true, stdout, stderr), runCfg.maxOutputChars);
            return { ok: true, exitCode: null, killed: true, ...capped };
          }
          return deny('run', `run failed: ${messageOf(err)}`);
        }
      },
    });
  }

  // Sandbox gate for the WRITE tools lives INSIDE their executors (read-only
  // keeps `read`, denies edit/run with the documented reason — the tools stay
  // on the surface so the denial is observable, per the sandbox-mapping
  // contract).

  // R4: maxTools is DATA — slice the surface to the configured count.
  return tools.slice(0, promptBudget.maxTools);
}
