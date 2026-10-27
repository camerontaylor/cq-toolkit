# ai-sdk step timeout: what it covers and whether to time out on idle

Investigation for PR F (2026-10-27). Sources: `ai@7.0.99` `dist/index.js`
(`node_modules/ai`), `@ai-sdk/openai-compatible` and `@ai-sdk/openai` `dist`,
and two live streaming probes (below).

## a. What `timeout.stepMs` covers

- generateText arms **one timer per loop iteration** (`setAbortTimeout`,
  `index.js` ~5810) and clears it in the iteration's `finally` (~6286), which
  runs after `executeTools` (~6156). One step therefore covers the model call
  **including the SDK's own retry** (`maxRetries: 1` re-enters inside the same
  timer) **and the step's tool execution**. It is not per HTTP request and it
  does not span the whole turn. `timeout.totalMs` (whole call) is unset.
- The earlier in-code comment ("per-request") was wrong; fixed in this PR.
- Product bounds on a whole review: `runAgentReviewer`'s `wallMs`
  (`budgets.run.wallMs`; default 20 min in `resolveCqConfigDefaults`, this
  repo's `cq.json` sets 4 h) enforced by an abort timer plus a deadline check;
  the token allowance (`budgets.run.maxTokens`, token-fold `stopWhen`);
  `maxSteps` per session; the governor job-context signal. The 60-minute eval
  guard is the eval harness's, not the product's.

## b. Timing out on idle instead

**ai@7 streamText supports it.** `timeout` accepts `totalMs`, `stepMs`,
`firstChunkMs` and `chunkMs` (generateText logs "only supported by streaming
functions" for the last two, `index.js` ~5597):

- `firstChunkMs`: armed when the step's stream starts (after `prepareStep`),
  cleared by the first **output chunk**. This is time-to-first-byte.
- `chunkMs`: re-armed on **every output chunk**; fires if no output chunk
  arrives for that long. Output chunks (`isOutputChunk2`, ~9252) are non-empty
  `text-delta`, **`reasoning-delta`**, `tool-input-delta`, `tool-call`, `file`.
- `stepMs`/`totalMs` behave as in generateText; the step timer likewise spans
  tool execution (cleared at `cleanupStepTimeouts`, ~10903).
- All timers are `setAbortTimeout` inside the SDK, so I8 (no raw timers in
  driver code) is unchanged.

**Do the providers stream, with reasoning visible?** Probed with a small
reasoning prompt (`/tmp`, no repo code), 2026-10-27:

| provider                          | SSE                              | TTFB  |            reasoning deltas | text starts | max gap          |
| --------------------------------- | -------------------------------- | ----- | --------------------------: | ----------- | ---------------- |
| zai / glm-5.3-flash               | yes                              | 2.9 s | 1,093 (`reasoning_content`) | 25 s        | 2.9 s (the TTFB) |
| opencode-go / deepseek-v4.1-flash | yes (needs `x-opencode-session`) | 1.4 s |   370 (`reasoning_content`) | 12 s        | 1.4 s            |

Both emit steady chunks during thinking. **Catch:** zai goes through
`@ai-sdk/openai-compatible`, which maps `reasoning_content` to `reasoning-delta`
(`dist/index.js` ~862). opencode-go uses `createOpenAI(...).chat`, whose chat
parser has no `reasoning_content` handling, so the SDK would see **no output
chunk during DeepSeek's thinking**. A stall timer on that path would fire on
healthy long thinking. It needs the opencode-go handle moved to
`@ai-sdk/openai-compatible` (a new direct dependency; already a transitive one).

**Feasibility of generateText -> streamText.** The main path is one
`generateText` call (index.ts ~784) plus a one-step repair call (~1290, can stay
generateText). `prepareStep`, `activeTools`, `onStepFinish`, `stopWhen`,
`output` and `timeout` all exist on streamText. The upload gate
(`beforeRequest`) and the pre-request ceiling are `wrapLanguageModel`
middleware (`transformParams`), which applies to `doStream` too. Work and risk:

- errors: streamText reports failures as stream error parts / `onError`, not a
  rejected promise, so the classifier and "completed steps keep their usage"
  paths must be re-derived; abort and `NoOutputGeneratedError` semantics differ;
- the result must be drained (`consumeStream`) before reading steps/output;
- the pre-request ceiling documents its model of generateText's retry loop
  (`pre-request-ceiling.ts` header); streaming has `streamRetries` and a
  different retry boundary, so its reservation accounting needs re-verifying;
- tests mock `doGenerate` (16+4 files); they need `doStream` mocks or a switch.

## Options

1. **Keep generateText, longer `stepMs`** (this PR, 20 min). No change risk; a
   hung request is detected only after 20 min.
2. **Streaming behind an option** (`AiSdkDriverOptions.streaming`, default off),
   opt-in for the reviewer, with stall/first-chunk/total timers. Lowest risk;
   keeps generateText as the fallback.
3. **Streaming by default** after option 2 has telemetry.

## Recommendation

Do option 2, then 3. Prerequisite: map `reasoning_content` for opencode-go
(openai-compatible). Defaults for the streaming path:

| bound                 | default | rationale                                                                                                                                                                  |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firstChunkMs` (TTFB) | 180 s   | probes saw 1.4-2.9 s on a tiny prompt; a 130k-token prompt prefill plus queueing is tens of seconds; 3 min is generous yet catches a dead connection 7x sooner than 20 min |
| `chunkMs` (stall)     | 120 s   | both providers emit reasoning/text continuously (max gap = TTFB); only a tool-argument stream or a gateway hiccup pauses, and 2 min is far above any healthy gap           |
| `stepMs`              | 20 min  | unchanged runaway cap while chunks keep flowing                                                                                                                            |
| `totalMs`             | unset   | the review wall budget and token budget own the run                                                                                                                        |

Estimate: ~2 PRs. PR 1 (~300 LOC): openai-compatible for opencode-go, streaming
option in the driver incl. error/abort mapping, timer options, ceiling
re-verification, `doStream` test helper. PR 2 (~150 LOC + test churn): flip the
reviewer default and migrate the remaining mocks.
