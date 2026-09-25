Toolkit-owned minimal tool surface (read/edit/run), per-op allowlists.
Land: phase 1 (WS-B).

- `config.ts` / `tools.ts` — the per-op config and the executors (every
  refusal a `{ tool, reason }` denial; `run` in its own process group,
  cancellable via `execute(input, { signal })`).
- `run.ts` — shared child-process lifecycle for shell commands and
  harness-owned argv executed without a shell.
- `surface.ts` — the shared, vendor-free tool-surface core both driver
  lanes serve (W1.4, ADR-0002 Annex A.1): naming, selection, the manifest,
  the bound serialized surface, denial classification, the init-surface
  comparator.
- `mcp/` — the `cq-harness-mcp` stdio server (hand-rolled closed-subset
  JSON-RPC, zero runtime dependencies) the subprocess lane's CLI launches.
- `session.ts` — the session store and temp workspaces (I6).

## Closed-form git commands

The `run` tool accepts exactly these forms after whitespace normalization,
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
git's option parser or a shell.

The argv disables the pager, external diff drivers, textconv, color, and
fsmonitor; it pins literal pathspecs and quoted paths. Diff output also
pins `a/` and `b/` prefixes. Token patterns must contain plain shell words,
and a `git` token pattern must name a literal subcommand. Author-owned
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

Every `run` child receives a default-deny environment composed by the
shared core at execution time, whether called directly through
`buildTools`, in-process through the claude-agent SDK, or through the
subprocess lane's stdio MCP server. Only default runtime/locale/network
names and explicitly permitted extra names are copied. Parent API keys,
tokens, and other secrets are absent by default. Route credential
overrides used to authenticate the agent child are not automatically
passed to harness commands.

`SubprocessDriverOptions.envAllowlist` and
`ClaudeAgentDriverOptions.envAllowlist` carry additional variable names
through the driver-authored manifest's `envNames`; the shared surface
passes those names to `buildTools`. The manifest also captures the
comma- or whitespace-separated names in `CQ_RUN_ENV_PASSTHROUGH`, so
deployment opt-ins survive the stdio startup scrub. Direct callers may
pass names as `buildTools`' fourth argument. The stdio server also scrubs
its own environment at startup. None of these filters provide OS confinement:
commands retain host privileges, inherited `HOME` exposes config paths,
proxy variables may contain credentials, and same-uid ancestor-environment
access remains a platform boundary.
