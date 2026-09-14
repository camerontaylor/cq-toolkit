// Governor config defaults derived from MEASUREMENT — not placeholders.
//
// DD-1 SPIKE RESULT (T1.6, 2026-09-14 — docs/dd-1-abort-spike.md): the
// cooperative-abort settle latency was measured live on both governed
// lanes, inside the governor's own channel (runLadder, rung-1 signal at
// 5 s):
//   - ai-sdk lane:  ≈6 ms after the signal (in-process fetch abort).
//   - claude-agent lane: ≈2.0 s after the signal (2006 / 2008 ms, two
//     consistent live samples — the SDK terminates its CLI worker process;
//     post-abort polls verified no transcript growth and no surviving
//     worker process, i.e. abort stops spend client-side in both lanes).
//
// The rung-1 → rung-2 grace must let the SLOWEST lane's cooperative settle
// finish before the ladder escalates, so the default carries ≈2.5× headroom
// over the measured worst case. The pre-spike placeholder (2_000) sat
// exactly AT the measured worst settle — zero headroom; rung 2 would fire
// in the same instant the cooperative path settles.
//
// This file is the SINGLE SOURCE OF TRUTH for the spike-derived default:
// src/kernel/governor.ts re-exports it, and
// test/kernel/governor-config.test.ts parses the value out of
// docs/dd-1-abort-spike.md and asserts this constant equals it — the
// write-up and the code cannot drift apart silently.
export const DEFAULT_ABORT_GRACE_MS = 5_000;
