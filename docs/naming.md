# Package-name record — cq-toolkit (T0.5)

> **Plan identifiers:** `T0.5` and `plan §6` come from the toolkit's development
> plan, maintained outside this repo (private research notes). Inlined rule:
> plan §6 = "the publication checklist, which allows an early 0.0.0
> name-reservation publish shipping only LICENSE + README".

Decision record for the npm package name. Every availability and status check
in this record was made on 2026-09-14 (the one check date for everything
below; the lane leader verified the same facts the same day) against the
public npm registry (https://registry.npmjs.org) and GitHub repository search.

## Registry status of names checked

| candidate                   | npm status                                                                                              | GitHub name collisions                                                                                                    | decision                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `cq-toolkit`                | free (404) — see below                                                                                  | 17 repos match `cq-toolkit in:name`; only exact-name hit besides ours is `csiberlin/CQ-Toolkit` (unrelated personal repo) | chosen                                |
| `@camerontaylor/cq-toolkit` | free (404) at T0.5 check time — published by the owner later the same day, see the decision at the foot | not checked — fallback only                                                                                               | fallback; not needed, kept on record  |
| `cq`                        | taken — 0.0.1 exists (see legacy note below)                                                            | not applicable                                                                                                            | never a candidate (legacy note below) |

## Legacy note: the bare short name was taken

The plan suspected the bare short name was already occupied on npm; confirmed:
package `cq` exists at version 0.0.1 (registry). That occupancy is the reason
the short name was never a candidate.

## Decision

The unscoped name `cq-toolkit` was chosen over the scoped fallback: it names
the toolkit without tying the package to one account, and both forms were free
(see the registry-status table above), the scoped one held in reserve. Per
plan §6 the name is to be reserved early rather than left to race the v1
release.

> **Reservation status: BLOCKED — publish-capable npm credentials missing
> (2026-09-14; superseded — the owner's scoped publish cleared the block, see
> the decision at the foot of this record).** The lane leader attempted the
> placeholder publish — a
> tarball whose payload is LICENSE + README.md — plus the package.json that
> npm itself always includes in every tarball — at `0.0.0`, per the plan §6
> allowance (it does not violate the no-staging rule, which governs the v1
> feature release).
>
> Historical note (2026-09-14): this procedure records the blocked attempt
> verbatim, under the then-chosen unscoped name. The block was cleared the
> same day — the owner published the placeholder as the scoped
> `@camerontaylor/cq-toolkit@0.0.0` (the decision at the foot of this
> record); the procedure stands as recorded — substitute the scoped name if
> the recipe is ever reused.
>
> Exact procedure, reproducible as written:
>
> 1. Create a temp dir OUTSIDE this repo and work there. Publishing from the
>    repo's own manifest would NOT produce the placeholder payload: its
>    `files` allowlist is `["dist", "policy", "LICENSE", "README.md"]`, so the
>    tarball would ship dist/ and policy/. The temp-dir manifest override in
>    the next step is what keeps the payload to LICENSE + README + the
>    npm-mandatory package.json (npm never builds a tarball without the
>    manifest).
> 2. In that dir, write a minimal package.json:
>    `{"name":"cq-toolkit","version":"0.0.0","description":"…","license":"MIT","files":["LICENSE","README.md"],"private":false}`
> 3. Copy LICENSE and README.md from the repo root into that dir.
> 4. Put the auth token in an `.npmrc` inside that dir, then run
>    `npm publish --access public` from there.
>
> npm rejected the publish with HTTP 403 "You may not perform that action
> with these credentials" twice; the host's rendered `NPM_TOKEN` is a
> 40-character token that authenticates but has no publish rights (likely
> read-only or scoped without this package). The name remains FREE at the
> registry (404 at every check). Re-try the publish once a publish-capable
> token is rendered, reusing this procedure.

Executor re-verification: `npm view cq-toolkit` and
`npm view @camerontaylor/cq-toolkit` both returned registry 404 at re-check
time (2026-09-14, before the owner's scoped publish recorded below) —
consistent with the blocked reservation above; the publish attempt and
its failure are the lane leader's record, stated here verbatim.

## GitHub repo-name near-matches (informational only)

Repository-name collisions are informational only — npm availability is the
deciding axis for the package name, and GitHub repo names live in a separate
namespace this record does not gate. Search `cq-toolkit in:name`
(https://api.github.com/search/repositories?q=cq-toolkit+in:name):
17 repositories match. The only exact-name match, case-insensitively, besides
this repo (`camerontaylor/cq-toolkit`) is `csiberlin/CQ-Toolkit`, an unrelated
personal repository. The other matches are different names —
`wttech/CQ-Unix-Toolkit`, `FangHeng/CQU_SimpleDES_Toolkit`,
`cavli-wireless/cqm22x-toolkit-apt`, and similar — none of them the same
package name.

## Sources

- https://registry.npmjs.org/cq-toolkit — 404
- https://registry.npmjs.org/@camerontaylor%2fcq-toolkit — 404 at T0.5 check time (published by the owner later the same day — see the owner decision above)
- https://registry.npmjs.org/cq — exists, version 0.0.1
- https://api.github.com/search/repositories?q=cq-toolkit+in:name — 17 results
- package.json of this repository — `"name": "@camerontaylor/cq-toolkit"`, `"version": "1.0.0"` (the v1.0.0 release line; it was `0.0.0` from the T0.5 placeholder until then — unscoped `cq-toolkit` was the T0.5-era name; see the owner decision above)

## Owner decision 2026-09-14 — scoped name adopted

The owner reserved the npm placeholder as **@camerontaylor/cq-toolkit@0.0.0** (scoped;
the publish token is granular-scoped to @camerontaylor packages). The unscoped
`cq-toolkit` record above stands as history; the shipped package name is the
scoped form. T0.5's publish block is cleared. Folded into the T1.5 PR per the
owner's one-line-fold-in instruction.
