# DD-1 result — does abort stop spend? (the T1.6 spike)

**Run date:** 2026-09-14 · **Lane models:** `glm-4.6` (Z.AI) · **Script:**
`scripts/dd1-abort-spike.mjs` (committed; standalone — never runs in
`npm test`) · **Governed channel:** `runLadder` with `wallClockMs: 5000`
(rung-1 signal fires at 5 s; the driver obeys; the governor decides WHEN) ·
**Declared spend ceiling:** `Budget.maxUsd: 2`, `toolPolicy: 'none'` per run.

## Method

One long fixture prompt (a ten-section essay instruction, deliberately
unfinished at 5 s) per lane, inside the governor's own channel. The spike
records, per lane:

- **settledAtMs / settleLatencyMs** — ms from dispatch to the driver verdict
  settling, and the residual after the 5 s signal. This is the COOPERATIVE
  settle latency the ladder's rung-1 → rung-2 `abortGraceMs` must cover.
- **stopReason** — must be `'aborted'` (the lane obeyed the governed signal).
- **usageAtAbort** — the usage the lane's verdict carries at the abort
  verdict.
- **post-abort poll (5 s)** — whether anything kept producing after the
  abort: for the claude-agent lane, the CLI's LOCAL transcript message count
  at settle vs after the poll (growth = the worker kept producing) plus a
  `pgrep` for surviving agent worker processes; for the ai-sdk lane there is
  no post-settle accrual channel to observe (the abort destroys the
  in-process fetch) — the poll is held anyway for wall-time parity and the
  limitation is stated here, not papered over.
- **spendStopped** — `stopReason === 'aborted'` AND prompt settle AND no
  transcript growth AND no surviving worker process.

**Client-side honesty limit:** no client can observe provider-side metering
or tokens already in flight when the request died. `spendStopped` is the
client-observable verdict — the worker stopped producing and nothing of ours
kept running — not an invoice. The lanes route through Z.AI's
anthropic-compatible endpoint (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`,
auth via the `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` child env the
drivers inject from `ZAI_API_KEY`); keys are read from the environment and
never printed or persisted.

## Measured — lane `ai-sdk` (`@ai-sdk/zai`, OpenAI-compat host)

| sample | settledAtMs | settleLatencyMs | stopReason | usageAtAbort      | post-poll                                       | spendStopped  |
| ------ | ----------- | --------------- | ---------- | ----------------- | ----------------------------------------------- | ------------- |
| 1      | 5006        | **6**           | `aborted`  | zeros (by design) | no accrual channel exists; poll held for parity | **true**      |
| 2      | 568         | —               | `error`    | —                 | —                                               | — (see below) |
| 3      | 569         | —               | `error`    | —                 | —                                               | — (see below) |

- Sample 1 is the abort datum: the verdict settled **6 ms** after the signal,
  `stopReason: 'aborted'`, zero cost claim (the unmeasured-abort rule).
- `usageAtAbort` is zeros because ai@7's `generateText` THROWS on abort and
  surfaces NO usage — the frozen rule that abort/error verdicts carry no
  costUSD exists precisely because this lane cannot measure partial spend.
- Samples 2–3 are NOT abort data: the run failed ~570 ms in with
  `AI_APICallError: Cannot connect to API` — the OpenAI-compat host
  (`api.z.ai/api/paas/v4`) refused connections in that window (`curl` exit
  000), while the anthropic-compat endpoint answered `200` in the same
  minute. Endpoint-side, reproduced twice; not spend-related, not retried
  further per the spike protocol. The abort measurement (sample 1) predates
  the outage and stands.

## Measured — lane `claude-agent` (agent SDK, anthropic-compat host)

| sample | settledAtMs | settleLatencyMs | stopReason | usageAtAbort                   | transcript at settle → after 5 s poll | lingering workers | spendStopped |
| ------ | ----------- | --------------- | ---------- | ------------------------------ | ------------------------------------- | ----------------- | ------------ |
| 1      | 7006        | **2006**        | `aborted`  | zeros (no assistant frame yet) | 1 msg → 1 msg                         | none              | **true**     |
| 2      | 7008        | **2008**        | `aborted`  | zeros (no assistant frame yet) | 1 msg → 1 msg                         | none              | **true**     |

- Both samples settled **~2.0 s** after the signal (2006 / 2008 ms — tight
  variance; the latency is the SDK's child teardown: the abort controller
  kills the CLI worker process and the iterator rejects). This ran LIVE
  against the Z.AI anthropic-compatible endpoint; the model id `glm-4.6`
  rode through unchecked, per the lane's no-allowlist rule.
- `usageAtAbort` is zeros because the agent had not produced its first
  assistant frame by the 5 s signal (the CLI session transcript held exactly
  the one user message at settle). Where assistant frames HAVE arrived, this
  lane folds their usage into the abort verdict — real partial-usage
  reporting, unlike the ai-sdk lane.
- The post-abort poll is the accrual check: transcript stayed at 1 message
  over the 5 s watch (the worker did NOT keep producing after the abort) and
  no agent worker process survived (the SDK's cleanup killed the child).

## Verdict

**Abort stops spend, client-side, in both lanes — but at very different
speeds.**

- `ai-sdk`: cooperative settle ≈ **6 ms** after the signal (in-process fetch
  abort; nothing left running by construction).
- `claude-agent`: cooperative settle ≈ **2.0 s** after the signal (the SDK
  terminates its CLI worker process; verified no transcript growth and no
  surviving process over a 5 s poll). Abort DOES propagate to a real
  out-of-process worker and DOES stop it.

Whether the provider meters a fraction of a second of already-in-flight
generation after the socket dies is not client-observable in either lane;
the spike's claim is deliberately scoped to what was measured.

## Governor config implication

The rung-1 → rung-2 grace must let the SLOWEST lane's cooperative settle
finish before the ladder escalates to the harder cancel. Measured worst
cooperative settle: **~2.0 s** (claude-agent, two consistent samples). The
pre-spike default `DEFAULT_ABORT_GRACE_MS = 2_000` sits exactly AT the
measurement — zero headroom; rung 2 would fire in the same instant the
cooperative path settles. The spike-derived default is therefore:

```ts
// src/kernel/governor.config.ts — the single source of truth
export const DEFAULT_ABORT_GRACE_MS = 5000; // ≈2.5× the measured worst cooperative settle (~2.0 s)
```

`DEFAULT_KILL_GRACE_MS` (rung 2 → rung 3) stays `5_000`: this spike gathered
no evidence about SIGTERM→SIGKILL resistance (nothing survived the
cooperative abort to be escalated), so the T1.5 process-ladder measurements
stand and the constant does not move.

The test `test/kernel/governor-config.test.ts` parses the default from THIS
document (the regex `export const DEFAULT_ABORT_GRACE_MS = <n>`) and asserts
the exported constant equals it — the doc is the single source of truth; the
code cannot drift from the write-up silently.
