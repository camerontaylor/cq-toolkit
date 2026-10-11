# C2 promotion verification — 2026-10-11

Dated handover record for the C2 cutover, per
`plans/c2-cutover-plan-20261011.md` step 7 (toolkit-research). Every fact
below was re-verified live from the GitHub API and remote refs at the time
of writing (2026-10-11, after the step-6 `noop` certification). This file is an ordinary
non-protected documentation change: it touches no protected path, and its
merge through the queue is the first promotion carried by the ARMED
`cq-gate` (`gate.yml`, workflow ID 368318299).

## The cutover in one paragraph

The one flip+delete PR (#310, branch `c2/flip-and-retire-old-gate`, head
`d84c9ca`) was delivered by the LAST old-gate promotion: merged into
`merge-queue` and promoted to `main` by the retired `merge-queue-gate.yml`
(workflow ID 357240137) after its full signer review. Both branch refs then
froze, the replay marker bootstrapped once, the owner applied the marker
ruleset, and the new gate was enabled and certified with a completed
`noop` at equal refs. From here `main` advances only by `cq-gate`'s
single atomic, leased push of `main` + `refs/heads/cq/promoted` + the
unchanged leased `refs/heads/merge-queue` refspec.

## Handover facts

| fact                                            | value                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Cutover date                                    | 2026-10-11                                                                                                                       |
| `S` (flip+delete queue merge, promoted subject) | `9660c4ce83eac84f88ef62ef81086db5890a0c76` (PR #310, head `d84c9ca`)                                                             |
| Last old-gate promotion run                     | [run 38118219254](https://github.com/camerontaylor/cq-toolkit/actions/runs/38118219254)                                          |
| Replay marker after bootstrap                   | `refs/heads/cq/promoted` = `S`                                                                                                   |
| Marker ruleset (owner-applied, step 5)          | ID `24868640` — `cq-c2-replay-marker`, `active`, rules `deletion` + `non_fast_forward` on `refs/heads/cq/*`, `bypass_actors: []` |
| Step-6 `noop` certification                     | [run 38118620358](https://github.com/camerontaylor/cq-toolkit/actions/runs/38118620358) — verdict `noop`, tip = `main` = `S`     |
| Retired promoter                                | workflow ID `357240137` (`merge-queue-gate.yml`) — state `deleted` from `main`                                                   |
| Armed promoter (sole)                           | workflow ID `368318299` (`gate.yml`, `cq-gate`) — state `active`, `CQ_GATE_PROMOTES: 'true'`                                     |

## Live read-back at writing time

- `git ls-remote origin` for `refs/heads/main`, `refs/heads/merge-queue`
  and `refs/heads/cq/promoted`: all three = `9660c4ce83eac84f88ef62ef81086db5890a0c76`.
- `GET /actions/workflows/368318299` → `active`, path `.github/workflows/gate.yml`.
- `GET /actions/workflows/357240137` → `deleted` (the record survives for history; the file is gone from `main`, where the adopter-only template `policy/templates/merge-queue-gate.yml` remains as a reference).
- `GET /rulesets/24868640` → `cq-c2-replay-marker`, `active`, `[deletion, non_fast_forward]`, no bypass actors.

## What this means going forward

- The marker is a replay high-water mark: never rewound or deleted; the
  marker ruleset (no bypass actors) blocks deletion and non-fast-forward
  updates on `refs/heads/cq/*` while ordinary fast-forwards by the
  promoter credential keep working.
- The old gate can no longer push: its workflow is deleted from `main`,
  its dispatch is removed from `sync-merge-queue.yml`, and crq retry
  selects `gate.yml` (no `sha` input) once the old workflow is absent
  (cutover plan step 8).
- Every future promotion is `cq-gate`'s: subject-bound, base-equality,
  verified-runs, marker-advancing, one atomic leased push of `main`, the
  marker and the unchanged leased `refs/heads/merge-queue` refspec — with
  the red-on-refused policy that came with the flip.
