# Independent source review

Reviewer: 00000000-0000-4000-8000-000000000005 (Sol profile, read-only).
Initial inspected head: a412643c6f6d4768ec8d68c039b515d86490a70e plus in-progress
restart/publication corrections. No tests, probes, paid dispatch or GitHub writes.

Ten major findings and corrections:

1. CQ judge schema belongs on seam-v2 invocation; complete normalized to ok;
   shared served-model assertion now wraps the judge.
2. Round ceilings use PR plus review merge-base pin across delta items; recurrence
   searches all repair histories of that PR.
3. CQ adapter recognizes the structured errorClass=rate-limit marker and defers.
4. Codex has no source-verified hard token-cap flag. Dispatch fails closed until
   a verified budget launcher is configured; startup validates all paid lanes
   before A0. Paseo similarly requires a persistent remote token guard.
5. A2 no-change after a valid judge is FAILED and needs human, never NOT-FIXED.
6. Publication record and item terminal state are saved together; terminal
   record harvesting reconciles a previously stranded repairing state.
7. Delta publication classification uses the actual reviewed PR branch, so a
   delta reviewed after merge produces a fix PR.
8. Authenticated signer summaries are materialized as local review evidence and
   enter detached repair; forced-command signer transport remains unchanged.
9. Promotion blockers carry per-run finding IDs and exact repair job identities;
   merged fixes resolve by job identity rather than global blocker numbering.
10. Missing legacy source evidence remains durable and prevents ledger archival.

Additional restart/publication corrections: journal dispatch before spend,
unknown interrupted outcomes require human reconciliation; preserve judge phase
across rate-limit retries without repeating fixers; escalation uses a fresh
worktree; immutable prepared publication refs and PR-creation pending journal
prevent repeated cherry-picks, pushes and ambiguous create retries. Existing fix
PR lookup includes closed/merged PRs before considering a deleted branch push.

Follow-up reviewed exact fef6b54ef21f5e3cacd8b1e9362d65c8e24af0d6, clean
worktree. Four additional findings, now corrected:

- Create local promotion blockers before enqueue binds repair identities.
- A2 first no-change plus valid J cannot dispatch another A2; exhausted => FAILED.
- Ceiling-skipped legacy findings prevent backfill completion and ledger archival.
- Paid-lane startup preflight also requires the Paseo endpoint/read-only mode.

The reviewer found no remaining duplicate push/PR retry defect in publication
recovery and confirmed pending-J deferrals avoid repeated fixer dispatch.
Final candidate review is requested against the exact committed HEAD. The
conductor saves the final independent attestation at
[state/implementation-review.json](../state/implementation-review.json) after
notification; this runtime evidence does not rewrite the reviewed source head.

Review binding 3d1982d1026f379c24043d14762af4bd98240894 found three further
issues; f90dab9bafff64c470a237957427c3072ec9c853 added one rollback finding.
Corrections: durable review/spool identity and quota before dispatch, explicit
queue-host marker removal only after worker-host inert proof, promotion status target_url
and visible repair rationale in the generated private-mesh record/status view,
and mirror unload plus watchdog restoration on rollback. Signed status target
links remain the separate signer's integration seam; transport is unchanged.
