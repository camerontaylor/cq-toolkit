# Explicit one-job preparation and repair

Since 2026-11-02 (owner: "turn on the fixers; cq/GLM only") committed policy
enables repair, and path/timer invocations with no selector drain the inbox
automatically (see the crq-python README). This document covers the separate
operator path: preparing a revalidated current-tip job from a historical one,
then repairing exactly that job. Sections below that describe Codex/Paseo lanes
or a held activation are historical; no committed role uses those drivers now.

## Activating the drain on a host

1. Deploy a runner containing this change; set the private overlay's
   `repair.enabled` to `true` (it is a host switch; `false` keeps repair off).
2. Write `~/.config/crq/repair.env` (mode 0600, outside Git) containing exactly
   `ZAI_API_KEY=...`. Without it the service refuses before any dispatch.
3. `repair.cq_bin` must point at a built cq `dist/cli.js` whose directory also
   holds `driver/ai-sdk/index.js` and `driver/served-model.js` (judge bridge).
4. Install the rendered units, then:
   `systemctl --user daemon-reload && systemctl --user enable --now crq-repair.timer crq-repair.path`.

## Prepare a new current-tip job

After independent source review and desk approval, the sole tick owner may run:

```sh
python3 crq.py repair-prepare <historical-job-id> \
  --source-sha <full-current-main-sha> \
  --revalidation <private-reviewed-evidence-json>
```

The existing tick lock covers preparation. Evidence must bind `source_sha`,
`finding_sha256` (SHA256 of canonical sorted compact finding JSON),
`source_blob_sha`, `verdict: "still-valid"`, a named `reviewer`, and a concrete
`reason`. Structural binding is not proof the reviewer is independent or the
reason technically correct. The desk must approve that evidence explicitly.

The historical inbox file, source pin, run, verdict and queue state are not
rewritten. A deterministic NEW job and NEW repair-run record link `origin_job`
and preserve evidence identity. No review cycle is fabricated. Repeated identical
preparation is idempotent and current-pin round ceilings remain. The full pinned
source file goes through the same path-scoped denylist and gitleaks policy before
it can become model context. A failed scan enrolls nothing. Incomplete preparation
cannot dispatch without the matching tick-owned queue record.

## Select exactly one job

Only after separate exact-configuration approval and hard-budget evidence:

```sh
python3 crq_repair.py --job <new-job-id> \
  --source-sha <full-prepared-current-source-sha> \
  --finding-sha256 <full-finding-sha256>
```

No glob or inbox enumeration occurs. Historical jobs cannot be silently repinned.
Selection verifies exact job identity, finding digest, current tip, revalidation,
lineage, and the one-job queued record under the repair-service lock. It refuses
if the queue tip moved, so revalidate and prepare a new job through the tick owner.
The detached worker remains unable to write the queue, push or call GitHub.

Fixer and judge payloads contain a pinned Git-object source snapshot, its blob
SHA, full source SHA, finding digest and historical lineage. The snapshot reads
no working-tree path or symlink target. It preserves source line numbering,
returns at most 16,000 excerpt characters and marks incomplete context. Judges
must return `unsure` rather than guess when the excerpt cannot establish validity.
CQ judges retain `toolPolicy.mode=none` and read-only sandbox policy. Those policies
remove model filesystem/command authority. This is not proof of Codex/Paseo
read-only capability, nor a hard token budget. Terminal results carry source and
finding bindings which the tick rechecks before harvesting.

Publication remains the tick's verified, final-secret-scanned path. A local
FIXED verdict or ordinary development commit does not resolve the old queue job.
Reconcile only after shipped code and verified disposition evidence. Existing
normal non-author I2 and exact candidate CI requirements remain.

## Budget and credential blockers

All configured Codex/Paseo lanes still require the existing verified-launcher
flags and a verified Paseo read-only mode. None is set or inferred here. CQ's
completed-step `stopWhen` observes usage after a request, so it is not a strict
pre-request ceiling. A model prompt, post-hoc accounting or process timeout
cannot establish a hard token budget.

A strict guard must reserve the complete input/context, schemas, prior transcript,
reasoning and provider-enforced maximum output before EVERY request. Refuse if a
trusted exact tokenizer or conservative proven bound is unavailable, if the
reservation exceeds the remaining whole-job ceiling, or if the provider cannot
enforce that output reservation. Account for repeated input/cache tokens and
all retries/structured-output repair. A whole-job wall-clock guard must remain
alive through all children, attempts, judge and mechanical stages, terminating
only the exact owned process group. Remote Paseo requires a persistent per-agent
guard, not a wrapper around background creation. The inspected interfaces do not
supply verified hard capability. Therefore this path remains BLOCKED for spend.

Proposed first automated job envelope, NOT operational evidence: one revalidated
heavy-lock finding at the exact current source, 32,000 tokens for the whole job,
at most 8,000 per dispatch across three fixer attempts and one judge, 120 seconds
per model dispatch and 600 seconds for the whole job including mechanical work.
Current source cannot enforce that whole-job envelope. The existing default-window
A0/A1 model is `zai/glm-5.3-flash`; A2 is `gpt-6.1-sol`, which separately lacks a
verified Codex hard-budget launcher. No role is silently changed to bypass it.

Encrypted CQ credential presence is not service availability. Proposed wiring is
only the existing encrypted-secret render path into a private CQ-only
`EnvironmentFile`, with the CQ key mapped to exactly `ZAI_API_KEY`. Do not inherit
broader secret environments, print values, store plaintext in Git or alter signer
units, custody, keys or transport. Confirm names/presence and modes only. The
repair service currently has no such verified environment wiring.
