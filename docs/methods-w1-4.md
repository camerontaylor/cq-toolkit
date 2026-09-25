# W1.4 methods note — subprocess closed tool surface

Task W1.4 (run=v11, tier O). It implements the RS-12 design (`rs12-mcp-harness.md` plus ADR-0002 Annex A,
research branch `research/rs12-mcp-harness` @ `3953ad6`). It adds the `cq-harness-mcp` stdio server, the
driver-authored manifest binding, the shared surface core used by both lanes, the two-level parity test, an
opt-in stock mode, and the live A10 conformance leg with the A.5a–k probes.

## What was built

| Piece                                                                                                                                                                                        | Where                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Shared, vendor-free core: naming, selection, manifest (`buildManifest` is the only constructor), bound serialized surface, `CallToolResult` mapping, `isHarnessDenial`, `compareInitSurface` | `src/harness/surface.ts`                         |
| Cancellable executor: `execute(input, {signal})`; `run` in its own process group, killed as a group on timeout, abort or shutdown                                                            | `src/harness/tools.ts`                           |
| Stdio server: hand-rolled closed-subset JSON-RPC, zero runtime dependencies                                                                                                                  | `src/harness/mcp/{server,startup,bin,launch}.ts` |
| Published bin `cq-harness-mcp`; `@modelcontextprotocol/sdk` as a devDependency only (conformance client)                                                                                     | `package.json`                                   |
| claude-agent moved onto the core, plus `settingSources: []`, `strictMcpConfig: true` and a fail-closed init assertion                                                                        | `src/driver/claude-agent/index.ts`               |
| Subprocess closed surface: argv, per-run 0600/`O_EXCL` MCP config, init assertion, three-way `is_error` fold, harness-name mapping, stock mode                                               | `src/driver/subprocess/index.ts`                 |
| Parity test (both lanes, same core)                                                                                                                                                          | `test/driver/harness-parity.test.ts`             |
| Live conformance leg (opt-in, real CLI, built `dist`)                                                                                                                                        | `test/driver/harness-live.test.ts`               |

## Decisions (recorded; no owner input was available)

1. **`errorClass: 'harness'` without a types bump.** ADR-0002 §2.2's `WorkerResult.errorClass` ships with the
   seam-v2 types bump (W3.3, plan row 3.3, "one types-version bump"). W1.4 does not change the frozen
   `WorkerResult`. A harness failure settles `stopReason: 'error'`, and `error` starts with a stable exported
   prefix (`HARNESS_ERROR_PREFIX`, per lane). The narration marker carries `errorClass: 'harness'`, so W3.3 can
   map the prefix straight onto the enum.
2. **Stock mode is a constructor option, `toolSurface: 'harness' | 'stock'`, defaulting to `'harness'`.** It is
   validated at construction and is not a config or plan key. There is no driver factory yet, so it is reachable
   only by direct construction (Annex A.4, D6).
3. **The claude-agent init assertion is enabled in this PR.** Annex A.2 gates it on A.5j, and A.5j ran here (see
   below). It found a live exposure and named the two options the lane needed.
4. **The `run` executor moved from `exec` to `spawn({shell: true, detached})`.** On POSIX this gives
   per-command process groups, and a group SIGKILL on timeout, abort or shutdown. Stdin is now closed (`ignore`),
   where `exec` left a pipe open that a stdin-reading command could hang on. Output is retained up to the byte
   bound and then truncated rather than denied. A signal death reports `{exitCode: null, killed: true}`.
5. **Source-mode test launch.** The driver's launch spec is module-relative (`dist/harness/mcp/bin.js`). Tests
   that spawn the server from TypeScript sources use a test-only loader (`test/helpers/ts-source-loader.mjs`,
   Node type stripping plus `.js`→`.ts` resolution), wired in with `vi.mock` of `launch.ts`. Production code has
   no test knob. The live leg runs against the built `dist`, so the real launch path is exercised.
6. **A stale MCP config left by a crashed earlier run on the same session is unlinked, then re-created
   exclusively.** Unlink removes a planted symlink itself, never its target, and the retry uses `O_EXCL`. The
   early delete runs when init reports the server connected. The settle-time delete always runs as a backstop.
7. **A harness-mode run that returns a result with no init event** settles `harness-surface-unverified`, on both
   lanes (fail closed).

## Live conformance leg — A.5a–k verdicts

Environment: `claude` CLI 2.1.280, isolated `HOME` seeded only with the subscription credential, Haiku, cwd a
scratch workspace. The server under test was the real `cq-harness-mcp` from source (probes) and from the built
`dist` (the driver leg). Probe dates: 2026-09-25.

| Probe                                            | Verdict                            | Evidence (recorded)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **a** `--json-schema` under `--tools ""`         | **PASS, no escalation**            | Structured output returned (`structured_output: {answer:'ok', n:42}`). `init.tools` is `['StructuredOutput']` without MCP, and `['StructuredOutput', mcp__cq-harness__read, mcp__cq-harness__run]` with it. The CLI's internal `StructuredOutput` tool is auto-approved, even with an empty `--allowedTools`. It is pinned as `CLI_STRUCTURED_OUTPUT_TOOL` and included in the expected set only when `--json-schema` is passed.                                                                                                                                                                       |
| **b** server exits 78 before `initialize`        | **PASS**                           | `init.mcp_servers = [{name:'cq-harness', status:'failed'}]` and `tools: []`, so the assertion fires. Without the assertion, the model wrote a hallucinated textual `<invoke name="Read">` and the CLI reported `success`: a run that "completes" with no work done, which is exactly the failure mode the assertion exists to catch.                                                                                                                                                                                                                                                                   |
| **c** ladder abort mid-`run`                     | **PASS**                           | The server is in the CLI's process group (pgid equal to the CLI's pid), so the group SIGTERM reaches it. The `run` grandchild is in its own group, and died through the server's SIGTERM handler (abort, then group kill). No server or command pid survived.                                                                                                                                                                                                                                                                                                                                          |
| **d** CLI MCP call timeout > harness `timeoutMs` | **PASS**                           | A 100 s `sleep` completed normally (`exit 0`, 114 s wall), so the CLI's timeout is over 100 s, against a harness default of 30 s. `MCP_TOOL_TIMEOUT` is not on the default child-env allowlist, so an ambient host variable cannot shorten the CLI's timeout.                                                                                                                                                                                                                                                                                                                                          |
| **e** negotiated `protocolVersion`               | **PASS**                           | The CLI sends `2025-11-25`, which is in `SUPPORTED_PROTOCOL_VERSIONS`. Its client capabilities are `roots` and `elicitation`; the server sends neither kind of request.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **f** denial text verbatim                       | **PASS**                           | `tool_result` has `is_error: true` with content `path escape: '../outside.txt' resolves outside the workspace`, as a plain string. A success result arrives as `[{type:'text', text}]`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **g** `--resume` re-spawns the server            | **PASS**                           | The second run with `--resume <id>` spawned a fresh server (2 spawns in total), which connected against the same manifest workspace. The conversation continued: the model recalled the first run's file content.                                                                                                                                                                                                                                                                                                                                                                                      |
| **h** CLI text on transport failure              | **RECORDED**                       | For a server killed mid-call: `Connection closed`, with `is_error`. For a CLI MCP timeout (`MCP_TOOL_TIMEOUT=3000`): `MCP server "cq-harness" tool "run" timed out after 3s`. Neither carries a harness prefix, so both take the transport-failure branch, which terminates the run with `error`/harness.                                                                                                                                                                                                                                                                                              |
| **i** config never re-read after startup         | **PASS, with a finding**           | After the server was killed, the CLI **reconnects**: it respawned the server, and a later call succeeded. The respawn used the **in-memory** config. The config file had been rewritten after startup to point at a marker-writing command, and the marker never appeared. Early deletion is therefore safe. The driver still fails closed on the first transport failure rather than trusting a silent respawn.                                                                                                                                                                                       |
| **j** claude-agent SDK init frame (0.3.270)      | **PASS after a fix. The finding:** | With the lane's previous options under **subscription** auth, the init frame listed about 13 claude.ai connector servers and about 60 extra tools on the worker's surface (`…Gmail__send_message`, `…Google_Drive__share_file`, …). They were not pre-approved, so headless mode would deny them, but they were exposed. **API-key** auth showed none. With `settingSources: []` plus `strictMcpConfig: true`, both auth modes report exactly `['StructuredOutput', 'mcp__cq-harness__read']` and `[{name:'cq-harness', status:'connected'}]`. The lane now passes both options and asserts the frame. |
| **k** full pinned argv; env merge                | **PASS**                           | The full A.4 argv loads the harness. That includes `--setting-sources ""`, `--json-schema` and `--allowedTools` as one space-joined element; `--resume` was covered by g. The server receives the CLI's env **merged** with the config `env`: a config canary was present, alongside CLI-injected variables such as `CLAUDE_CODE_MESSAGING_TOKEN`. That makes the startup env scrub load-bearing. A `run env` child saw only `HOME PATH TMPDIR` plus what the shell itself sets.                                                                                                                       |

Driver-level leg (`test/driver/harness-live.test.ts`, built `dist`, the shipped `zai` route, `glm-4.5-air`,
isolated `HOME`), 4/4 passed:

- **`mode: 'none'`:** the builtins are absent. Nothing executed, the empty init surface verified, `denials: []`,
  and no config file was left behind.
- **Read- and Bash-style attempts through the harness** were denied with harness-classified reasons:
  `path escape: …` and `command not allowed by harness config allowlist: …`.
- **Structured output under `--tools ""`** works through the driver, and the `run` child's `env` did not contain
  the route token.
- **A `sessionRef` resume** re-spawned the server on the same workspace and read a file written between the runs.

## Additional live finding — oversized MCP output

A harness `read` of a 184,799-character file, which is under the default `read.maxOutputChars` of 200,000, came
back from CLI 2.1.280 as `Error: result (184,799 characters across 2,200 lines) exceeds maximum allowed tokens.
Output has been saved to <HOME>/.claude/projects/…/tool-results/…txt`. `is_error` was **not** set, so the fold
treats it as an ordinary result: no false transport-failure termination and no false denial. Two consequences
are recorded rather than fixed here, because the harness defaults are shared across lanes:

- **Usability:** on this lane, the model never sees harness output above the CLI's MCP token budget. Deployments
  should keep `read`/`run` `maxOutputChars` below about 80k chars (roughly the CLI's default budget).
- **Data remnant:** the CLI copies the full oversized output into `HOME/.claude/projects/…`, outside the
  workspace, even with `--no-session-persistence`. The closed surface gives the model no tool that reaches that
  path, because the harness `read` is contained to the workspace. The copy still outlives the run.

## Post-review changes (after CodeRabbit cycle 2 — not CLI-reviewed)

The mandatory Opus improvement pass (a fresh read-only critic) found one major issue and four minor ones. All are
fixed in `79247f4`, and gate run 3 was taken after that commit:

1. **Major, fail-open:** two concurrent runs on one session shared the config path. Run B's stale-file
   rm-and-retry could swap run A's binding, for example serving `workspace-write` to a `read-only` run. The
   config name is now unique per run (`<sessionId>.<uuid>.cq-harness-mcp.json`), and `EEXIST` is a hard error.
2. A call cancelled while it waited in the queue still executed. It now returns the stable denial `cancelled: …`
   without running.
3. EPIPE on the server's stdout is now treated as EOF, so in-flight groups are killed. `bin` aborts in-flight
   calls on an uncaught exception.
4. Uncapped `run` output retention is now bounded at 1 MiB per stream, and output past that is truncated. The
   old `exec` path had a 1 MiB buffer.
5. A reused in-flight JSON-RPC id is refused with `-32600`.

## Named limitations (carried from the design)

- A same-uid `run` command can still read an ancestor's environment (`ps eww`, `/proc/<pid>/environ`). Closing
  that channel is OS confinement (T1.8/RS-13), and it is not claimed here.
- A server killed without SIGTERM (SIGKILL or a crash) orphans an in-flight command group until that group exits
  on its own.
- W1.5 dependency: on the claude-agent lane, `run` children still inherit the host `process.env`. Passing an
  explicit `buildChildEnv` there belongs to W1.5.
