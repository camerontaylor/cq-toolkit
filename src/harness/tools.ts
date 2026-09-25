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
// path escape (lexical or via symlink), allowlist miss, shell metacharacters
// under a token pattern, missing file, missing target text, failed command
// spawn) is a structured denial record `{ tool, reason }` — exactly
// the FROZEN driver-seam ToolDenial shape, so denials flow into
// WorkerResult.denials verbatim. Denial reasons are human-readable strings
// with stable PREFIXES (the conformance suite asserts on these):
//   'sandbox: …' | 'invalid input: …' | 'path escape: …'
//   'path not allowed: … is inside a .git directory (toolkit invariant)'
//   'path not allowed by harness config allowlist: …'
//   'command not allowed by harness config allowlist: …'
//   'command allowlist: shell metacharacters not permitted with token
//    patterns — use re: with anchoring'
//   'file not found: …' | 'read failed: …' | 'edit refused: …'
//   'edit failed: …' | 'run failed: …'
//   'cancelled: …' (surface.ts: a queued call cancelled before it ran)
//
// ENFORCEMENT ORDER per call: sandbox gate → input schema → workspace
// containment (lexical, then symlink realpath re-check) → config allowlist →
// execution (fs / child_process). Each step short-circuits into a denial.
//
// SANDBOX MAPPING + TRUST BOUNDARY (driver seam SandboxLevel; issue #28):
// sandboxPolicy governs the TOOL SURFACE — which tools exist, and what
// read/edit may touch via the lexical + realpath path guards below. `run`
// commands execute with HOST PRIVILEGES, scoped to the cwd convention only
// (cwd = workspace); the command allowlist (token patterns / anchored re:)
// is the additional GATE over what may run, never a confinement of how.
// 'workspace-write' does NOT confer OS-level confinement: there is no
// sandbox-exec/landlock/bwrap in v1 — OS-sandbox enforcement is the
// recorded T1.8 strategy question.
//   - 'read-only'       → `edit`/`run` deny with 'sandbox: read-only'; `read`
//                         stays available.
//   - 'none' | 'workspace-write' → tools behave per config.
//
// SYMLINK CHANNEL (named limitation + partial hardening): containment is
// lexical, and the `run` tool is the SYMLINK-PLANTING VECTOR — an allowlisted
// command can create a symlink inside the workspace pointing outside
// (`ln -s /etc passwd`), after which read/edit through the link would cross
// the boundary. Partial hardening: read/edit REALPATH the resolved path and
// re-check containment when the file exists (against the workspace's own
// realpath, so symlinked tmp roots don't false-positive) — pre-existing
// symlinks are caught with 'path escape: … through a symlink'. A symlink
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
//     (recorded finding; documentation-covered, not code-repaired).
//   - anything else    → whitespace-token PREFIX: the pattern's tokens must
//     equal the command's leading tokens ('npm test' allows 'npm test' and
//     'npm test -- --watch', not 'npm run test'). Token splitting is naive
//     whitespace splitting — quoting is NOT parsed.
//     SHELL-METACHARACTER GUARD: a token-pattern match allows only a command
//     FREE of shell metacharacters (';' '&' '|' '$' '`' '(' ')' '<' '>'
//     newline). The exec shell would otherwise interpret sequences the
//     token prefix never saw ('npm test ; whoami', 'npm test && curl …',
//     'npm test $(rm -rf ~)'); such a command denies with the distinct
//     'command allowlist: shell metacharacters …' reason pointing at
//     anchored re: patterns as the deliberate escape hatch.
// Invalid regexes and empty/whitespace-only patterns throw at `buildTools`
// time — config corruption is a loud error, never a silent allow-all.
//
// `run` executes through the SHELL (node:child_process spawn with
// `shell: true`, cwd = workspace, stdin closed) so pipelines work; the
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
import { spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { SandboxLevel, ToolDenial } from '../driver/types.js';
import { HarnessConfigSchema } from './config.js';
import type { HarnessConfig } from './config.js';

/**
 * Per-stream retention bound for `run` when the config sets no output cap:
 * "uncapped" means no truncation of the result text up to this bound, never
 * unbounded memory (the old `exec` path capped at its 1 MiB maxBuffer).
 */
const UNCAPPED_RETENTION_BYTES = 1_048_576;

/** POSIX platforms get per-command process groups (`detached` + group kill). */
const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// Tool inputs — zod schemas, exported for driver adapters
// ---------------------------------------------------------------------------

export const ReadToolInputSchema = z.object({ path: z.string().min(1) }).strict();

export const EditToolInputSchema = z
  .object({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
  })
  .strict();

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
 * Per-call execution options (additive). `signal` cancels an in-flight
 * call: `run` kills the command's whole process group; read/edit are
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
    }
  | {
      name: 'edit';
      description: string;
      inputSchema: typeof EditToolInputSchema;
      execute(input: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult>;
    }
  | {
      name: 'run';
      description: string;
      inputSchema: typeof RunToolInputSchema;
      execute(input: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult>;
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
 * empty/whitespace-only pattern — config corruption is loud (an empty
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
// runShellCommand — one `run` command in its own process group
// ---------------------------------------------------------------------------

/** How one shell command ended: a normal exit, a kill, or a failed spawn. */
type ShellOutcome =
  | { kind: 'exit'; code: number; stdout: string; stderr: string; overflowed: boolean }
  | { kind: 'killed'; stdout: string; stderr: string; overflowed: boolean }
  | { kind: 'spawn-error'; error: unknown };

/** Inputs to one shell command execution — plain data plus the cancellation signal. */
interface ShellCommandOptions {
  cwd: string;
  /** Per-stream retention bound in bytes. */
  maxBytes: number;
  /** Per-command wall clock; on expiry the whole process group is killed. */
  timeoutMs?: number;
  /** Cancellation: abort kills the whole process group. */
  signal?: AbortSignal;
}

/**
 * Run `command` through the platform shell (`/bin/sh -c` on POSIX, as
 * `exec` did), cwd = workspace, stdin closed. On POSIX the shell LEADS ITS
 * OWN PROCESS GROUP, so a timeout or an abort signals `-pid` and reaches
 * every descendant; Windows has no groups in v1 and kills the direct child
 * only (the same limitation the subprocess lane records). The kill is
 * SIGKILL: the decision to stop has already been made (timeout, cancel, or
 * harness shutdown), and a command that traps SIGTERM must not outlive it.
 * Never rejects — a spawn failure is data.
 */
function runShellCommand(command: string, opts: ShellCommandOptions): Promise<ShellOutcome> {
  return new Promise<ShellOutcome>((settle) => {
    if (opts.signal?.aborted === true) {
      settle({ kind: 'killed', stdout: '', stderr: '', overflowed: false });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(POSIX ? { detached: true } : {}),
      });
    } catch (err) {
      settle({ kind: 'spawn-error', error: err });
      return;
    }
    const collect = (): { chunks: Buffer[]; bytes: number } => ({ chunks: [], bytes: 0 });
    const out = collect();
    const err = collect();
    let overflowed = false;
    const retain = (sink: { chunks: Buffer[]; bytes: number }, chunk: Buffer): void => {
      const room = opts.maxBytes - sink.bytes;
      if (chunk.length > room) overflowed = true; // keep draining, stop retaining
      if (room <= 0) return;
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      sink.chunks.push(kept);
      sink.bytes += kept.length;
    };
    child.stdout?.on('data', (chunk: Buffer) => retain(out, chunk));
    child.stderr?.on('data', (chunk: Buffer) => retain(err, chunk));

    let killedByUs = false;
    const killGroup = (): void => {
      killedByUs = true;
      if (POSIX && child.pid !== undefined) {
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
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(killGroup, opts.timeoutMs);
    opts.signal?.addEventListener('abort', killGroup, { once: true });

    let spawnError: unknown;
    child.on('error', (e: unknown) => {
      spawnError ??= e;
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', killGroup);
      const stdout = Buffer.concat(out.chunks).toString('utf8');
      const stderr = Buffer.concat(err.chunks).toString('utf8');
      if (spawnError !== undefined && child.pid === undefined) {
        settle({ kind: 'spawn-error', error: spawnError });
      } else if (killedByUs || signal !== null || code === null) {
        settle({ kind: 'killed', stdout, stderr, overflowed });
      } else {
        settle({ kind: 'exit', code, stdout, stderr, overflowed });
      }
    });
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
function capOutput(
  text: string,
  maxChars: number | undefined,
): { output: string; truncated: boolean } {
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
  const { promptBudget } = cfg;

  const deny = (tool: ToolkitToolName, reason: string): ToolkitToolResult => ({
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
  const gitDenial = (tool: ToolkitToolName, abs: string): ToolkitToolResult =>
    deny(tool, `path not allowed: '${relOf(abs)}' is inside a .git directory (toolkit invariant)`);

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
        const effective = await resolveRealInside(abs);
        if (effective === undefined) {
          return deny(
            'read',
            `path escape: '${parsed.data.path}' escapes the workspace through a symlink`,
          );
        }
        if (await touchesGit(abs, effective)) return gitDenial('read', abs);
        if (!(await pathAllowedEverywhere(fileCfg.pathPatterns, abs, effective))) {
          return deny('read', `path not allowed by harness config allowlist: '${relOf(abs)}'`);
        }
        let content: string;
        try {
          content = await readFile(effective, 'utf8');
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
        const effective = await resolveRealInside(abs);
        if (effective === undefined) {
          return deny('edit', `path escape: '${path}' escapes the workspace through a symlink`);
        }
        if (await touchesGit(abs, effective)) return gitDenial('edit', abs);
        if (!(await pathAllowedEverywhere(fileCfg.pathPatterns, abs, effective))) {
          return deny('edit', `path not allowed by harness config allowlist: '${relOf(abs)}'`);
        }
        let content: string;
        try {
          content = await readFile(effective, 'utf8');
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
          await writeFile(effective, edited, 'utf8');
        } catch (err) {
          return deny('edit', `edit failed: ${messageOf(err)}`);
        }
        const capped = capOutput(
          `edited '${relOf(abs)}': replaced 1 occurrence`,
          fileCfg.maxOutputChars,
        );
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
          'Input: { command }. TRUST BOUNDARY: commands run with HOST privileges, scoped to the ' +
          'workspace-cwd convention only — the configured allowlist, timeout, and output cap are ' +
          'gates over what may run, not an OS sandbox. Allowlist syntax: whitespace token prefixes, ' +
          'or anchored re: patterns as the deliberate metacharacter escape hatch.',
        promptBudget.maxToolDescriptionChars,
      ),
      inputSchema: RunToolInputSchema,
      execute: async (rawInput: unknown, opts?: ToolExecuteOptions): Promise<ToolkitToolResult> => {
        if (sandbox === 'read-only') return deny('run', 'sandbox: read-only');
        const parsed = RunToolInputSchema.safeParse(rawInput);
        if (!parsed.success) return invalidInput('run', parsed.error);
        const command = parsed.data.command;
        const verdict = commandVerdict(patterns, command);
        if (!verdict.allowed) {
          return deny(
            'run',
            verdict.metacharacters
              ? 'command allowlist: shell metacharacters not permitted with token patterns — use re: with anchoring'
              : `command not allowed by harness config allowlist: '${command}'`,
          );
        }
        const outcome = await runShellCommand(command, {
          cwd: workspaceAbs,
          // Retention is BYTES; the output cap is CHARS. Retain comfortably
          // above the cap so capOutput does the truncating (4 bytes/char
          // covers UTF-8's worst case, +64KiB slack for the exit/stdout
          // wrapper) — a noisy command is truncated, never denied (issue #18).
          maxBytes:
            runCfg.maxOutputChars !== undefined
              ? runCfg.maxOutputChars * 4 + 65_536
              : UNCAPPED_RETENTION_BYTES,
          ...(runCfg.timeoutMs !== undefined ? { timeoutMs: runCfg.timeoutMs } : {}),
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        });
        // Nonzero exits and kills are REAL tool results (the model must see
        // them), not denials — only spawn-level failures deny.
        if (outcome.kind === 'spawn-error') {
          return deny('run', `run failed: ${messageOf(outcome.error)}`);
        }
        const killed = outcome.kind === 'killed';
        const exitCode = killed ? null : outcome.code;
        const capped = capOutput(
          formatOutcome(exitCode, killed, outcome.stdout, outcome.stderr),
          runCfg.maxOutputChars,
        );
        return {
          ok: true,
          exitCode,
          killed,
          output: capped.output,
          truncated: capped.truncated || outcome.overflowed,
        };
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
