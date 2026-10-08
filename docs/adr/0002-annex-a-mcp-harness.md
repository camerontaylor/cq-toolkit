# ADR-0002 Annex A — MCP harness server

- **Status:** accepted (G1, 2026-09-26)
- **Date:** 2026-09-25
- **Amends / Related:** [ADR-0002](0002-worker-driver-seam-v2.md) (seam v2), [Annex B](0002-annex-b-config.md)
  (configuration keys)

Post-acceptance note N2 in the [ADR index](README.md#post-acceptance-notes) narrows part of this record.

The toolkit's read/edit/run harness is served to the `subprocess` and `claude-agent` lanes as an MCP server named
`cq-harness`, so both lanes run the same tools under the same confinement. Per
[ADR-0002](0002-worker-driver-seam-v2.md), the server binds to `invocation.workspace` (resolved by the driver) and
`DriverRequest.harness`, adds no `OpInvocation` fields, and sits behind the same `ResolvedDriver` on both lanes.

## A.1 Shared core (both lanes)

[src/harness/surface.ts](../../src/harness/surface.ts) is vendor-free, belongs to the driver family and imports
nothing from the kernel. It is the single implementation of:

- **Naming.** `HARNESS_MCP_SERVER_NAME = 'cq-harness'`, `qualifiedToolName(n) = 'mcp__cq-harness__' + n`, and its
  inverse `harnessToolName`. Tool names are the harness names `read`/`edit`/`run`. The server name contains no `__`,
  tool names match `[A-Za-z0-9_.-]{1,128}`, and spellings are byte-exact, because the CLI matches the whole
  `mcp__server__tool` triple case-sensitively.
- **Selection.** `selectHarnessSurface(harness, toolPolicy)`: `allowlist` → harness ∩ `allow`; `unrestricted` → all
  enabled harness tools; `none` → `[]`.
- **Binding.** A strict plain-data manifest, constructed only by `buildManifest`:
  ```ts
  { v: 1,
    workspace: string,          // realpath of the workspace resolved per ADR-0002 §2.4; existing directory
    sandbox: SandboxLevel,      // invocation.sandboxPolicy.level
    tools: ToolkitToolName[],   // selectHarnessSurface(...); non-empty — empty ⇒ no server is registered
    harness: HarnessConfig,     // DriverRequest.harness, else the lane default; never plan JSON
    envNames: string[] }        // extra env NAMES `run` children may inherit (the lane's envAllowlist); default []
  ```
- **Execution.** `createHarnessSurface(manifest)` returns `buildTools(harness, workspace, sandbox)` filtered to
  `tools`, and throws unless the result equals `tools` exactly. Calls are serialized per surface. Each call returns
  the MCP `CallToolResult` `{content:[{type:'text', text}], isError?: true}` (harness output or denial reason) with
  the harness outcome; the executor gains an additive `execute(input, {signal?})`. `run` spawns each command in its
  own process group and kills the group on abort, timeout and server shutdown.
- **Surface assertion.** A comparator over an init report: the `{name, status}` projection of `mcp_servers` is
  exactly `cq-harness`/`connected` (or no server when the selection is empty), and `tools` is exactly the qualified
  selected names plus any CLI-internal tool that A.5a pins.
- **Error-text classification.** `isHarnessDenial(text)` is true only for the stable harness denial prefixes (the
  [src/harness/tools.ts](../../src/harness/tools.ts) header).

**Environment of `run` children (a dependency, not decided here).** `run` children get an explicit `buildChildEnv`
environment plus `envNames`, never the inherited process environment, so provider credentials are absent from
model-chosen commands on both lanes. A same-uid process can still read an ancestor's environment; closing that
belongs to OS confinement (D14), not this annex.

## A.2 Transports

- **claude-agent (in-process).** The lane adapts the core's tools to the Agent SDK's `tool()` and
  `createSdkMcpServer({name:'cq-harness'})`, with the core's `call` as handler. It keeps its execute-boundary
  session-record append and denial accumulation, passes `tools: []` and `allowedTools = tools.map(qualifiedToolName)`,
  and applies the A.1 surface assertion to the SDK init frame **once A.5j has probed that frame**.
- **subprocess (stdio).** The lane serves the core through the stdio server (A.3), which the CLI launches from a
  per-run MCP config (A.4).
- **Parity (normative conformance).** One manifest and one scripted sequence (read, edit, path not allowed, path
  escape, command not allowed, metacharacter command, read-only sandbox) yields byte-identical `CallToolResult` JSON
  through the stdio server, claude-agent's registered handler and the core directly, and identical
  `WorkerResult.denials` from each lane's fold. **Exception:** for schema-invalid input the Agent SDK pre-validates
  (rejecting type-invalid calls and stripping extra keys) while the strict core schema on stdio denies both, so parity
  asserts only that each transport rejects the call and executes nothing.

## A.3 The stdio server

- **Entry point.** [src/harness/mcp/server.ts](../../src/harness/mcp/server.ts) (`serveStdio`) and
  [src/harness/mcp/bin.ts](../../src/harness/mcp/bin.ts). The package declares the bin `cq-harness-mcp` for operators
  and third-party MCP hosts. **Toolkit dispatch never resolves it through `PATH`, `npx` or plan data**: it launches
  `process.execPath` with the module-relative absolute path of the built `bin.js` (P1, as in ADR-0002 §2.5).
- **Arguments.** Exactly one: the manifest as JSON. JSON-RPC 2.0 is hand-rolled, with **no runtime dependency on
  `@modelcontextprotocol/sdk`** (a devDependency, used only as the conformance client).
- **Startup checks, before any JSON-RPC message is read:** validate the manifest strictly; check that
  `realpath(workspace) === workspace` and that it is a directory; construct the core surface, which must equal
  `tools`; `chdir(workspace)`; replace the process environment with the `buildChildEnv` default allowlist plus
  `envNames`. Any failure writes one line to stderr and exits 78; the server never serves a surface.
- **Protocol: a closed subset.** `initialize` returns capabilities `{tools:{listChanged:false}}` and
  `serverInfo.name = 'cq-harness'`, and echoes the client's `protocolVersion` if it is in the supported set
  (`2024-11-05` … `2026-07-28`), else answers the newest supported version.

  > Narrowed: see post-acceptance note N2 in the [ADR index](README.md#post-acceptance-notes).

  Also served: `notifications/initialized`, `notifications/cancelled` (aborts the in-flight call and kills its
  process group), `ping`, `tools/list` (the selected surface only, strict JSON Schemas from the harness zod inputs)
  and `tools/call`. An unlisted tool → `-32602`; any other request → `-32601`; unparseable input → `-32700`; a batch
  or a non-object → `-32600`.

- **Framing.** UTF-8, newline-delimited, protocol only on stdout. An inbound line over 1 MiB is a protocol break: the
  server reports it on stderr and exits non-zero; it never truncates.
- **Lifetime.** One server process per CLI run. On stdin EOF, `SIGTERM` or `SIGINT` the server kills every in-flight
  command group and exits, so the lane's SIGTERM-first ladder reaches commands through the server. **Residual:** a
  server killed without SIGTERM, or one that crashes, orphans an in-flight command group. The server holds no
  session state and no `sessionsDir` path; the driver is the only writer of the session record.

## A.4 Subprocess lane binding

- **Config file.** When the selection is non-empty, the lane creates `<sessionsDir>/<sessionId>.cq-harness-mcp.json`
  exclusively (`O_EXCL`) with mode 0600, never in the workspace, where the worker could tamper with it. Its content
  is `{"mcpServers":{"cq-harness":{"command":<execPath>,"args":[<bin.js>,<manifest JSON>],"env":{}}}}`. The lane
  deletes it as soon as `system/init` reports `cq-harness` connected, and again when the run settles, whatever the
  verdict and the `sessionRetention`.
- **Argv**, in order:
  `-p --output-format stream-json --verbose [--json-schema …] --tools "" --setting-sources "" --strict-mcp-config
[--mcp-config <file>] --allowedTools "<qualified names, space-joined, one argv element; empty when none>"
--model <id> [--resume <id>]`.
  A comma-joined allowlist is forbidden: the CLI then silently pre-approves only the first entry. A conformance leg
  pins the argv byte-exactly.
- **Init-surface assertion.** On the first `system/init` event the lane applies the A.1 comparator. A mismatch (a
  missing or failed harness, an extra server such as a leaked connector, a builtin that `--tools ""` did not strip)
  terminates through the existing ladder and settles `stopReason:'error'`, `errorClass:'harness'` (ADR-0002 §2.2),
  with narration `{cq:'harness-surface-mismatch', expected, observed}`.
- **Fold.** Qualified tool names map back through `harnessToolName`, so `WorkerResult.denials` and session-record
  tool messages use harness names, as on claude-agent. An `is_error` result on a harness tool is (1) a harness
  denial `{tool, reason}`, verbatim, when `isHarnessDenial(text)` holds; (2) a CLI permission denial (outside
  `--allowedTools`), with the existing mapping; (3) **otherwise a transport failure**: terminate and settle `error`,
  `errorClass:'harness'`, narration `{cq:'harness-transport-failure', tool, text}`.
- **Sandbox marker.** The harness now enforces tool-level sandbox and containment on this lane, so
  `sandbox-level-unenforced` narration is emitted only for the OS layer (`layer:'os'`).
- **Stock mode** (null-hypothesis evals only) bypasses this annex. It is an option of the **directly constructed**
  subprocess lane only (the `./driver` subpath, ADVISORY per ADR-0002 §2.5), never a `DriverFactoryConfig` key, and
  it adds no Annex B entry.

## A.5 Preconditions for the live conformance leg

The live conformance leg (W1.4) verifies each item against the real CLI or SDK; any failure escalates rather than
widening the surface. Verdicts: [docs/methods-w1-4.md](../methods-w1-4.md).

- **a.** `--json-schema` structured output works under `--tools ""`; record `init.tools` in that mode and pin any
  CLI-internal tool into the comparator. If it does not work, ADR-0002 §2.3's native subprocess transport is
  unavailable, and that is an ADR matter.
- **b.** A server exiting 78 before `initialize` is reported as not connected.
- **c.** A ladder abort mid-`run` leaves no surviving server or command process.
- **d.** The CLI's MCP call timeout exceeds the harness `timeoutMs`.
- **e.** The CLI's `protocolVersion` is in the supported set.
- **f.** Denial text arrives verbatim.
- **g.** `--resume` re-spawns the server against the same workspace.
- **h.** The transport-failure branch catches the CLI's `tool_result` text for a server killed mid-call and for an
  MCP timeout (both recorded).
- **i.** The CLI never re-reads the config file after startup, including on reconnect.
- **j.** Record the claude-agent SDK init frame (`tools`, `mcp_servers`) with `outputFormat`, under API-key and
  subscription auth, before enabling the assertion on that lane.
- **k.** The full A.4 argv loads the harness, and the server receives the CLI's env merged with `"env":{}`.
