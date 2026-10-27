Toolkit-owned minimal tool surface (read/edit/write/bash), per-op allowlists.
The pre-F1 `run` tool name and `path`/`oldText`/`newText` edit arguments are
accepted as one-release aliases.
Land: phase 1 (WS-B).

- `config.ts` / `tools.ts` — the per-op config and the executors (every
  refusal a `{ tool, reason }` denial; `bash` in its own process group,
  cancellable via `execute(input, { signal })`).
- `run.ts` — shared child-process lifecycle for shell commands and
  harness-owned argv executed without a shell.
- `surface.ts` — the shared, vendor-free tool-surface core both driver
  lanes serve (W1.4, ADR-0002 Annex A.1): naming, selection, the manifest,
  the bound serialized surface, denial classification, the init-surface
  comparator.
- `mcp/` — the `cq-harness-mcp` stdio server (hand-rolled closed-subset
  JSON-RPC, zero runtime dependencies) the claude-code lane's CLI transport launches.
- `session.ts` — the session store and temp workspaces (I6).

## Optional tool arguments and failure evidence

File tools accept `filePath` or `path` for `file_path`. Edit also accepts
`oldString`/`oldText`, `newString`/`newText`, and `replaceAll`. Equal alias
values may be supplied together; conflicting values fail validation. Schemas
remain strict: unrecognised options are rejected. The ai-sdk request advertises
only canonical fields with short field help; compatibility aliases are checked
and normalized by the schema validator before execution. Denial and command
failure results carry typed `tool-failure` hints.

Grep accepts `ignore_case` (`-i` or `ignoreCase`), `output_mode` (`content`,
`files_with_matches`, `count`), and `head_limit` (0 uses the safety cap).
Counts are matching lines within the existing search limits; truncation
markers identify partial results; capped count rows use `+` for lower bounds. Bash accepts `timeoutMs` for `timeout`,
`workdir`/`cwd` within the workspace (lexical and symlink containment), and
an advisory `description`. Its command allowlist still applies. Background
execution (`run_in_background: true`) is explicitly unsupported.

`HarnessConfig.logToolFailures` defaults to false. `cq.json` exposes the
same `harness.logToolFailures` switch for `review.run` agent sessions; this
repository enables it. When enabled, the ai-sdk driver appends bounded
`type: "tool-failure"` lines with kind, tool, reason, input summary and
zero-based step. The configured scan hook examines diagnostics before they
are bounded and persisted; a refused scan redacts the record. Without a
scanner, input values and error details are omitted. Bash descriptions use
the same scan rule and appear on their tool message. Diagnostic lines share
the store's serialized append and torn-tail recovery, and are not replayed
as conversation turns. Old sessions remain readable.

`WorkerResult.toolFailures` counts ai-sdk failures even when logging is off,
including SDK validation failures, unknown tools, execution errors/timeouts, and
unexecuted final/repair calls. Ordinary nonzero shell exits remain results. Review coverage and logs carry the count.
Claude Code CLI and ACP also expose their existing observed failure counts;
they retain their native transcript formats. Claude Code SDK transport and
native-lane structured diagnostic logging remain separate work.

## Closed-form git commands

The `bash` tool (legacy `run` alias) accepts exactly these forms after whitespace normalization,
and each form still needs a command-allowlist grant:

| Diff                            | Log                       |
| ------------------------------- | ------------------------- |
| `git diff`                      | `git log --oneline -n 20` |
| `git diff --stat`               | `git log -n 1`            |
| `git diff --name-only`          | `git log -n 1 --stat`     |
| `git diff --cached`             |                           |
| `git diff --cached --stat`      |                           |
| `git diff --cached --name-only` |                           |

There are no path-scoped or revision forms, alternate flag orderings,
`--staged` synonym, or worker-selected output paths. Literal `git diff`
and `git log` commands outside the table are denied before the allowlist
pattern loop, including under a matching `re:` grant. Each accepted key
selects constant harness-owned argv; worker-supplied tokens never reach
git's option parser or a shell. Attached shell operators and substitutions
(including backticks and `$(...)`) after the literal diff/log word also deny.

The argv disables the pager, external diff drivers, textconv, color, and
fsmonitor; it pins literal pathspecs and quoted paths. Diff output also
pins `a/` and `b/` prefixes. Token patterns must contain plain shell words,
and a `git` token pattern must begin with literal `git` and name a literal
subcommand. Wrapped or path-qualified git token patterns such as
`env git diff` and `/usr/bin/git diff` are rejected during construction. Author-owned
`re:` patterns remain a shell escape hatch: broad patterns can admit
disguised git spellings such as `git "diff"`, so keep them narrow.

## Command lifecycle and environment

Closed-form commands use `runArgvCommand` with `shell: false`; other
allowlisted commands use `runShellCommand`. Both share `spawnAndCollect`
in `run.ts`: workspace cwd, closed stdin, bounded stdout/stderr retention,
timeout, and cancellation. On POSIX each command leads its own process
group, and timeout or abort sends SIGKILL to that group, including
descendants. Windows kills the direct child only. A noisy command is
truncated rather than denied; killed commands return a null exit code.

Every `bash` child receives a default-deny environment composed by the
shared core at execution time, whether called directly through
`buildTools`, in-process through the claude-code lane's SDK transport, or through
the CLI transport's stdio MCP server. Only default runtime/locale/network
names and explicitly permitted extra names are copied. Parent API keys,
tokens, and other secrets are absent by default. Route credential
overrides used to authenticate the agent child are not automatically
passed to harness commands.

`ClaudeCodeDriverOptions.envAllowlist` carries additional variable names
through the driver-authored manifest's `envNames`; the shared surface
passes those names to `buildTools`. The manifest also captures the
comma- or whitespace-separated names in `CQ_RUN_ENV_PASSTHROUGH`, so
deployment opt-ins survive the stdio startup scrub. Direct callers may
pass names as `buildTools`' fourth argument. The stdio server also scrubs
its own environment at startup. None of these filters provide OS confinement:
commands retain host privileges, inherited `HOME` exposes config paths,
proxy variables may contain credentials, and same-uid ancestor-environment
access remains a platform boundary.
