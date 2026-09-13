# Package-name record — cq-toolkit (T0.5)

Decision record for the npm package name. All availability checks below were made
2026-09-14 against the public npm registry (https://registry.npmjs.org) and GitHub
repository search; the lane leader verified the same facts the same day, and this
record restates them with citations.

## Candidates

| candidate | npm status (2026-09-14) | GitHub name collisions | decision |
| --- | --- | --- | --- |
| `cq-toolkit` | free — registry 404 at check time (https://registry.npmjs.org/cq-toolkit); placeholder 0.0.0 publish attempted and BLOCKED on credentials (record below); this repo's package.json already carries the name | 17 repos match `cq-toolkit in:name`; only exact-name hit besides ours is `csiberlin/CQ-Toolkit` (unrelated personal repo) | chosen |
| `@camerontaylor/cq-toolkit` | free — registry 404 at check time (https://registry.npmjs.org/@camerontaylor%2fcq-toolkit) | not checked — fallback only | fallback; not needed, kept on record |
| `cq` | taken — version 0.0.1 exists (https://registry.npmjs.org/cq) | not applicable | never a candidate (legacy note below) |

## Legacy note: the bare short name was taken

The plan suspected the bare short name was already occupied on npm; confirmed:
package `cq` exists at version 0.0.1 (registry, checked 2026-09-14). That
occupancy is the reason the short name was never a candidate.

## Decision

The unscoped name `cq-toolkit` was chosen over the scoped fallback: it names the
toolkit without tying the package to one account, and it was free on npm at check
time while the scoped form was held in reserve. Per plan §6 the name is to be
reserved early rather than left to race the v1 release.

> **Reservation status: BLOCKED — publish-capable npm credentials missing
> (2026-09-14).** The lane leader attempted the placeholder publish (a tarball
> containing only LICENSE + README.md, `0.0.0`, `--access public`, per the plan
> §6 allowance — it does not violate the no-staging rule, which governs the v1
> feature release). npm rejected it with HTTP 403 "You may not perform that
> action with these credentials" twice; the host's rendered `NPM_TOKEN` is a
> 40-character token that authenticates but has no publish rights (likely
> read-only or scoped without this package). The name remains FREE at the
> registry (404 at every check, most recently 2026-09-14). Re-try the publish
> once a publish-capable token is rendered; the exact placeholder payload is
> reproducible from this section.

Executor re-verification (2026-09-14): `npm view cq-toolkit` and
`npm view @camerontaylor/cq-toolkit` both returned registry 404 at re-check time —
consistent with the blocked reservation above; the publish attempt and its
failure are the lane leader's record, stated here verbatim.

## GitHub repo-name near-matches (informational only)

Repository-name collisions are informational only — npm availability is the
deciding axis for the package name, and GitHub repo names live in a separate
namespace this record does not gate. Search `cq-toolkit in:name`
(https://api.github.com/search/repositories?q=cq-toolkit+in:name, 2026-09-14):
17 repositories match. The only exact-name match, case-insensitively, besides
this repo (`camerontaylor/cq-toolkit`) is `csiberlin/CQ-Toolkit`, an unrelated
personal repository. The other matches are different names — `wttech/
CQ-Unix-Toolkit`, `FangHeng/CQU_SimpleDES_Toolkit`, `cavli-wireless/
cqm22x-toolkit-apt`, and similar — none of them the same package name.

## Sources (all read 2026-09-14)

- https://registry.npmjs.org/cq-toolkit — 404, name free at check time
- https://registry.npmjs.org/@camerontaylor%2fcq-toolkit — 404, fallback free
- https://registry.npmjs.org/cq — exists, version 0.0.1
- https://api.github.com/search/repositories?q=cq-toolkit+in:name — 17 results
- package.json of this repository — `"name": "cq-toolkit"`, `"version": "0.0.0"`
