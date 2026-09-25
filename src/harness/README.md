Toolkit-owned minimal tool surface (read/edit/run), per-op allowlists.
Land: phase 1 (WS-B).

- `config.ts` / `tools.ts` — the per-op config and the executors (every
  refusal a `{ tool, reason }` denial; `run` in its own process group,
  cancellable via `execute(input, { signal })`).
- `surface.ts` — the shared, vendor-free tool-surface core both driver
  lanes serve (W1.4, ADR-0002 Annex A.1): naming, selection, the manifest,
  the bound serialized surface, denial classification, the init-surface
  comparator.
- `mcp/` — the `cq-harness-mcp` stdio server (hand-rolled closed-subset
  JSON-RPC, zero runtime dependencies) the subprocess lane's CLI launches.
- `session.ts` — the session store and temp workspaces (I6).
