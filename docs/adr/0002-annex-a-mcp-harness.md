<!--
INSERTION MARKER — ADR-0002 (reconciled, research/g1-adr-reconciliation @ bf5f540, adr-0002-draft.md).
Replace the section "## Annex A — MCP harness server (RS-12) — *slot*" (its heading and three constraint
bullets) with everything between BEGIN ANNEX A and END ANNEX A. §2–§7 are not changed. At insertion, the header
line "Annex slots: A — …; B — …. Both are placeholders." should read "A is filled (RS-12); B is a placeholder".
That is a status edit, not a contract change.
Evidence and critic dispositions: research/research-20260925-v11/rs12-mcp-harness.md (branch research/rs12-mcp-harness).
-->

<!-- BEGIN ANNEX A -->

## Annex A — MCP harness server (RS-12)

Filled by RS-12 (`rs12-mcp-harness.md`, cq-toolkit anchors at `5e52707`; CLI facts from RS-1/RS-1b,
`research/rs1-cli-surface` @ `241843e`, CLI 2.1.280). The fixed constraints of the slot, verbatim:

- "The server binds to `invocation.workspace`, resolved by the driver, and to `DriverRequest.harness`."
- "It adds no `OpInvocation` fields."
- "It is shared by the subprocess and claude-agent lanes behind the same `ResolvedDriver`."

### A.1 Shared core (both lanes)

`src/harness/surface.ts` is vendor-free and belongs to the driver family, with no kernel import. It is the
single implementation of:

- **Naming.** `HARNESS_MCP_SERVER_NAME = 'cq-harness'`, `qualifiedToolName(n) = 'mcp__cq-harness__' + n`, and
  its inverse `harnessToolName`. Tool names are the harness names `read`/`edit`/`run`. By construction the
  server name contains no `__`, and tool names match `[A-Za-z0-9_.-]{1,128}` (MCP tool-name rules). Spellings
  are byte-exact wherever they appear (RS-1b b3: matching is case-sensitive over the whole triple).
- **Selection.** `selectHarnessSurface(harness, toolPolicy)`. `allowlist` → harness ∩ `allow`; `unrestricted` →
  every enabled harness tool; `none` → `[]`. This replaces both per-lane copies of `allowedToolNames`.
- **Binding.** A strict plain-data manifest. Only `buildManifest` constructs one:
  ```ts
  { v: 1,
    workspace: string,          // realpath of the workspace the driver resolved per §2.4; existing directory
    sandbox: SandboxLevel,      // invocation.sandboxPolicy.level
    tools: ToolkitToolName[],   // selectHarnessSurface(...); non-empty — empty ⇒ no server is registered
    harness: HarnessConfig,     // DriverRequest.harness, else the lane default; never plan JSON
    envNames: string[] }        // extra env NAMES `run` children may inherit (the lane's envAllowlist); default []
  ```
- **Execution.** `createHarnessSurface(manifest)` returns `buildTools(harness, workspace, sandbox)` filtered to
  `tools`. It throws unless the result equals `tools` exactly. Calls are serialized per surface. Each call
  returns the MCP `CallToolResult` `{content:[{type:'text', text}], isError?: true}`, where the text is the
  harness output or the harness denial reason, together with the harness outcome.
  - The executor gains an additive `execute(input, {signal?})`.
  - `run` spawns each command in its own process group, and kills the group on abort, on timeout and on server
    shutdown.
- **Surface assertion.** A comparator over an init report. It checks:
  - the `{name, status}` projection of `mcp_servers`: exactly `cq-harness`/`connected`, or no server when the
    selection is empty;
  - `tools`: exactly the qualified selected names, plus any CLI-internal tool that A.5a pins.
- **Error-text classification.** `isHarnessDenial(text)` is true only for the stable harness denial prefixes
  (`src/harness/tools.ts` header).

**W1.5 dependency, not decided here:** `run` children get an explicit `buildChildEnv` environment plus
`envNames`, never the inherited process environment. On that basis, provider credentials are absent from the
environment variables of model-chosen commands on both lanes. A same-uid process can still read an ancestor's
environment. That channel is OS confinement (T1.8/RS-13), and this annex does not claim to close it.

### A.2 Transports

- **claude-agent (in-process).**
  - The lane adapts the core's tools to the Agent SDK's `tool()` and `createSdkMcpServer({name:'cq-harness'})`.
    The handler is the core's `call`.
  - It keeps its execute-boundary session-record append and its denial accumulation.
  - It passes `tools: []` and `allowedTools = tools.map(qualifiedToolName)`.
  - It applies the A.1 surface assertion to the SDK init frame **once A.5j has probed that frame** and named any
    option the lane needs.
- **subprocess (stdio).** The lane serves the core through the stdio server in A.3, launched by the CLI from a
  per-run MCP config (A.4).
- **Parity (conformance, normative).** One manifest and one scripted sequence: read, edit, path not allowed,
  path escape, command not allowed, metacharacter command, read-only sandbox.
  - It yields byte-identical `CallToolResult` JSON through the stdio server (driven by an MCP client), through
    claude-agent's registered handler, and through the core directly.
  - Each lane's fold over the same sequence yields identical `WorkerResult.denials`.
  - **Scoped exception:** schema-invalid input. The Agent SDK pre-validates the registered, non-strict shape,
    so a type-invalid call is rejected before the handler runs and extra keys are stripped. On stdio the strict
    core schema denies both. Parity asserts only that each transport rejects the call and executes nothing.

### A.3 The stdio server

- **Entry point.** `src/harness/mcp/server.ts` (`serveStdio`) and `src/harness/mcp/bin.ts`. The package declares
  the bin `cq-harness-mcp` for operators and third-party MCP hosts. **Toolkit dispatch never resolves it through
  `PATH`, `npx` or plan data.** It launches `process.execPath` with the module-relative absolute path of the
  built `bin.js` (P1: plan data never names an executable, as in §2.5).
- **Arguments.** Exactly one: the manifest as JSON.
- **Startup checks, before any JSON-RPC message is read.**
  - Validate the manifest strictly.
  - Check that `realpath(workspace) === workspace` and that it is a directory.
  - Construct the core surface; it must equal `tools`.
  - `chdir(workspace)`.
  - Replace the process environment with the `buildChildEnv` default allowlist plus `envNames`.

  Any failure writes one line to stderr and exits 78, and the server never serves a surface.

- **Dependency.** The JSON-RPC 2.0 is hand-rolled. There is **no runtime dependency on
  `@modelcontextprotocol/sdk`**, which is a devDependency used only as the conformance client.
- **Protocol: a closed subset.**
  - `initialize`: capabilities `{tools:{listChanged:false}}`, `serverInfo.name = 'cq-harness'`. Version
    negotiation: echo the client's `protocolVersion` if it is in the supported set (`2024-11-05` …
    `2026-07-28`), else answer the newest supported version.
  - `notifications/initialized`.
  - `notifications/cancelled`, which aborts the in-flight call and kills its process group.
  - `ping`.
  - `tools/list`: the selected surface only, with strict JSON Schemas from the harness zod inputs.
  - `tools/call`. An unlisted tool → `-32602`.
  - Any other request → `-32601`. Unparseable input → `-32700`. A batch or a non-object → `-32600`.
- **Framing.** UTF-8, newline-delimited, protocol only on stdout. An inbound line over 1 MiB is a protocol break:
  the server reports it on stderr and exits non-zero; it never truncates.
- **Lifetime.** One server process per CLI run. On stdin EOF, `SIGTERM` or `SIGINT`, the server kills every
  in-flight command group and exits. The lane's SIGTERM-first ladder therefore reaches commands through the
  server (A.5c).
  - **Named residual:** a server killed without SIGTERM, or a server crash, orphans an in-flight command group.
- **Session records.** The server holds no session state and no `sessionsDir` path. The driver is the only
  writer of the session record.

### A.4 Subprocess lane binding

- **Config file.** When the selection is non-empty, the lane creates `<sessionsDir>/<sessionId>.cq-harness-mcp.json`
  exclusively (`O_EXCL`), mode 0600. It is never created in the workspace (tamper vector #26). Its content is
  `{"mcpServers":{"cq-harness":{"command":<execPath>,"args":[<bin.js>,<manifest JSON>],"env":{}}}}`. The lane
  deletes it as soon as `system/init` reports `cq-harness` connected, and again when the run settles as a
  backstop, whatever the verdict and whatever the `sessionRetention`.
- **Argv.** In order:
  `-p --output-format stream-json --verbose [--json-schema …] --tools "" --setting-sources "" --strict-mcp-config
[--mcp-config <file>] --allowedTools "<qualified names, space-joined, one argv element; empty when none>"
--model <id> [--resume <id>]`.
  A comma-joined allowlist is forbidden, because it silently pre-approves only the first entry (RS-1b b9/b10).
  A conformance leg pins the argv byte-exactly.
- **Init-surface assertion.** On the first `system/init` event, the lane applies the A.1 comparator. On a
  mismatch it terminates through the existing ladder and settles `stopReason:'error'`, `errorClass:'harness'`
  (§2.2: "spawn/exit/crash, protocol break"), with narration `{cq:'harness-surface-mismatch', expected,
observed}`. Mismatches include:
  - a missing or failed harness;
  - an extra server, such as a leaked connector;
  - a builtin that `--tools ""` did not strip.
- **Fold.**
  - Qualified tool names map back through `harnessToolName`, so `WorkerResult.denials` and session-record tool
    messages use harness names, as on claude-agent.
  - An `is_error` result on a harness tool is classified three ways:
    1. a harness denial when `isHarnessDenial(text)` holds: `{tool, reason}`, verbatim;
    2. a CLI permission denial (the call was outside `--allowedTools`): today's mapping;
    3. **anything else is a transport failure**: terminate and settle `error`, `errorClass:'harness'`, with
       narration `{cq:'harness-transport-failure', tool, text}`.
- **Sandbox marker.** Tool-level sandbox and containment are now enforced by the harness on this lane.
  `sandbox-level-unenforced` narration is emitted only for the OS layer (`layer:'os'`).
- **Stock mode (plan D6: null-hypothesis evals only).** It bypasses this annex. It is an option of the
  **directly constructed** subprocess lane only (the `./driver` subpath, ADVISORY per §2.5), and never a
  `DriverFactoryConfig` key. It adds no Annex B entry.

### A.5 Preconditions carried to W1.4's live conformance leg

RS-1/RS-1b did not probe these. W1.4 verifies each one against the real CLI or SDK. Any failure escalates rather
than widening the surface.

- **a.** `--json-schema` structured output works under `--tools ""`. Record `init.tools` in that mode and pin any
  CLI-internal tool into the comparator. If structured output does not work, §2.3's native subprocess transport
  is unavailable, and that is an ADR matter.
- **b.** A server exiting 78 before `initialize` is reported as not connected.
- **c.** A ladder abort mid-`run` leaves no surviving server or command process.
- **d.** The CLI's MCP call timeout exceeds the harness `timeoutMs`.
- **e.** The CLI's `protocolVersion` is in the supported set.
- **f.** Denial text arrives verbatim.
- **g.** `--resume` re-spawns the server against the same workspace.
- **h.** Record the CLI's `tool_result` text for a server killed mid-call and for an MCP timeout. The
  transport-failure branch must catch both.
- **i.** The CLI never re-reads the config file after startup, including on reconnect.
- **j.** Record the claude-agent SDK init frame (`tools`, `mcp_servers`) with `outputFormat`, under API-key and
  subscription auth, before enabling the assertion on that lane.
- **k.** The full A.4 argv loads the harness, and the server receives the CLI's env merged with `"env":{}`.

<!-- END ANNEX A -->
