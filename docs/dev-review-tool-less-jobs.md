# Tool-less development review jobs

This is an offline inventory of the current call sites. A role name does not
authorize tools. The invocation's `toolPolicy` and the evidence already in its
prompt determine whether a job can answer without a workspace read.

| Job                                                               | Question and supplied evidence                                                                                                    | Current tools and schema                                                                                                                                                              | Repair or uncertainty behavior                                                                                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review session (`src/ops/review/internal/reviewSession.ts`)       | Find issues in the scanned diff slices placed in the prompt.                                                                      | `plan.tools=false` sends `mode: none`; when true it offers `read`, optionally `grep` and `glob` under `searchTools`. Output is `review.agent/v3` findings.                            | A missing slice or needed repository context calls for a bounded read-enabled plan, not an invented finding. The ai-sdk structured-output repair keeps definitions but has no executors. |
| Analyze remediation (`src/ops/analyze/agenticRemediation.ts`)     | Propose a remedy from the cluster members, signature and confidence in the prompt.                                                | Defaults to `mode: none`, read-only sandbox, and `analyze.agenticRemediation/v1` proposal.                                                                                            | A wider tool or sandbox policy remains approval-gated by `approved: true`. The op returns the driver's failure or uncertainty taxonomy; it does not apply a patch.                       |
| Address edit/feedback/closure (`src/ops/review/addressWorker.ts`) | Act on a finding or judge closure using the selected prompt and workspace.                                                        | Current invocation offers `read` and, for editable work, `edit`; reviewer search may add `grep`/`glob`. Closure uses `review.address.closure/v1`, others `review.address.outcome/v1`. | Closure is already tool-equipped; this inventory does not infer that it can safely become tool-less. A failed result is handled by the existing address budget and refusal path.         |
| Classifier cell                                                   | The research card mentions a classifier cell, but this tree has no concrete `src/ops` dispatch with role `classifier` to inspect. | No tool or schema claim is made from the role name alone.                                                                                                                             | Identify the actual caller and its supplied evidence before changing its policy.                                                                                                         |

## Fixed request definitions and synthetic size

The driver constructs tool definitions once for a session. Its forced final
step changes the trailing instruction, and the one structured-output repair
replays the definitions without executors. The final-step executor denies any
tool call instead of running it. `test/driver/ai-sdk.test.ts` compares the
**complete serialized prepared function definitions**, tool choice and system
text on every main, final and repair request for injected `opencode-go`, `zai`
and `ai-sdk` models; the alias fixture checks the complete definitions for
`run` as well as `read`.

For each fixture request the test records
`Buffer.byteLength(JSON.stringify({ tools, toolChoice, system }), 'utf8')`
and separately sums the serialized `inputSchema` bytes. The `read` schema is
**410 synthetic bytes per request**, or **1,640 synthetic bytes over four
requests** (1,230 beyond one copy). These are **synthetic serialized bytes,
not provider tokens or billing**. SDK transport, provider serialization and
tokenization can differ; this measurement cannot establish an overcount or a
metering change.

The prompted OpenCode-Go fixture already checks absent `responseFormat`, one
copy of the task prompt per request, a schema-invalid final answer and one
repair. The final-denial and repair-tool fixtures check that neither turn
executes a forbidden call. The retained-evidence fixture checks that repair
sees the scanned tool result once. These tests use injected models and no
provider network call.

## Legacy Anthropic JSON-tool compatibility

The production `AiSdkDriverOptions` exposes provider-factory injection but no
fetch override for its default Anthropic factory. The offline fixture injects
the public Anthropic adapter with a fake fetch and the older
`claude-sonnet-4-20250514` model, whose adapter capability selects the legacy
JSON-tool route. It captures one outbound request containing both `read` and
the adapter's `json` response tool, with no `output_config`, then returns a
synthetic non-retryable 400 response. This characterizes the outbound fallback
shape only; it does not prove a successful response or provider billing. No
production transport or metering change follows from it.
