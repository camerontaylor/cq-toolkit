# claude-code fixtures — recorded, version-labelled vendor frames

These files are RECORDED vendor frame shapes used as deterministic test
fixtures for the `driver/claude-code` lane's refusal detection and shared
worker accounting (D-E′ Phase 1.9 acceptance handoff, methods.md). They are
NOT live network captures: each file transcribes the vendor's documented
stream-json / SDK message vocabulary for a NAMED pin (labelled below), and
each was recorded on 2026-10-17 from the vendor's published format
documentation and changelog entries cited in the research matrix
(`research-20261017-de-prime-spike`). No secrets, no endpoints, no
credentials — every URL and session id is inert.

| File                                | Recorded shape                                                                                                                                                                                    | Version label                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `refusal-cli-stream.jsonl`          | CLI stream-json run whose assistant message and result frame carry `stop_reason: "refusal"` WHILE the result still delivers a schema-shaped `structured_output` (the pre-0.3.302 delivery defect) | CLI 2.1.30x vocabulary; defect fixed in 0.3.302/2.1.302                        |
| `refusal-sdk-frames.json`           | SDK message-stream frames, same refusal-with-payload shape                                                                                                                                        | SDK ≥0.3.162 (`stop_reason`), ≤0.3.301 delivery shape                          |
| `usage/sdk-modelUsage-result.json`  | success result frame with BOTH the flat main-loop `usage` (subagent spend excluded) and the per-model `modelUsage` aggregates (subagent spend included)                                           | SDK 0.3.302-shaped; `modelUsage` present since the 0.3.x modelUsage vocabulary |
| `usage/cli-resume-per-call.jsonl`   | resumed-session run whose reported usage is PER-CALL (resumed sessions started their totals at zero)                                                                                              | CLI < 2.1.277                                                                  |
| `usage/cli-resume-cumulative.jsonl` | resumed-session run whose reported usage is SESSION-CUMULATIVE                                                                                                                                    | CLI ≥ 2.1.277                                                                  |

Re-recording rule: when a version bump changes one of these shapes, record a
NEW labelled file and update the consuming test's label — never silently
rewrite a labelled recording (the labels ARE the version-gate evidence).
