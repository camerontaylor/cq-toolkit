# ADR-0007 — Fix task evidence identity

- **Status:** E2 implementation decision, 2026-10-28
- **Scope:** failed-attempt refs and commits in `sweep.unit`

## Failed-attempt refs

A failed-attempt ref has the form `<runPrefix>/failed/<kind>/<slug>/<task>/a<n>`.
Each new component has a readable ASCII prefix (or `id` if none survives), a
hyphen and a SHA-256 digest of its complete raw identity. Each component is at
most 80 bytes. The task component hashes the full static-task signature when
present, while the report and `Cq-Task` trailer retain the original task ID.
The commit also carries `Cq-Ref-Identity`, a base64url encoding of the exact
JSON tuple `[kind, slug, fullTaskIdentity]`.

The initial digest is 16 hex characters. A ref under the candidate identity
path consumes an attempt number only when its recorded tuple matches exactly.
An absent or different tuple is a conflict: extend every component digest by
eight hex characters, up to the full 64, and choose the new path. If a conflict
persists at the full digest, refuse creation. A truncated digest is a routing
hint, not a proof of unique identity. The atomic `update-ref` zero-old-value
create still guards concurrent writers; after an occupied-ref race, recheck
the recorded identity before choosing another attempt number.

Attempt numbering starts at the requested ordinal and advances only over
occupied refs of that same identity. Existing old-format refs remain intact and
can still be read from saved reports; new writes use the new format and never
rename or delete retained evidence.
