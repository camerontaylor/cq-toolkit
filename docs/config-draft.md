# Configuration draft (retired)

The RS-15 Annex B registry and resolver (`src/config/`) and its bundled
profiles (`policy/profiles/`) were unreachable and were deleted in Phase 0.2
(ADR-0005-D-C). Git history is the archive: see the last commit before the
deletion for the registry, resolver and profile files.

Reviewer sessions can opt into a late tool-step countdown with
`review.session.stepCountdown: true` in `cq.json`. It defaults to false.
The ai-sdk driver appends “N tool steps left” only on the final three tool
steps; the final answer step retains its existing schema instruction.
