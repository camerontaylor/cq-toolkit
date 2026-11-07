# Review operation v1 vectors

`vectors.json` is shared by Python and TypeScript. Each row has `type`, `value`
and `valid`; identity rows also pin canonical ASCII JSON bytes and SHA-256.
The schema validates the tagged wrapper `{type, value}`. Wire messages carry
only `value`; the wrapper selects the validation concern.

## Original-commit snapshots

`submit.inputs.head_commit` always names the original commit. Snapshot v1 sends
its original commit bytes, the intervening original commits, and all trees/blobs
in `git rev-list --objects HEAD ^BASE` (not objects already reachable from base).
The server must have base already. It verifies each Git SHA-1, the complete
closure, and the claimed head/base trees before admitting work. No synthetic
commit or synthetic-to-original mapping is needed in this representation.

Objects are unique and sorted lexicographically by OID. `data` is canonical
base64 of the uncompressed Git object contents. Snapshot `sha256` hashes the
concatenation of `oid + NUL + type + NUL + data + LF` for every sorted object.
`tree` equals the original head tree. The snapshot fixture's base is a placeholder
`aaaaaaaa…`; installation tests must supply a real reachable base.

The full JSON request is bounded at 6 MiB, the canonical snapshot JSON at 5 MiB,
decoded object contents at 4 MiB,
and objects at 4096. Oversize or incomplete snapshots fail with actionable limits;
objects are never truncated. The snapshot cap leaves 1 MiB for the surrounding request. All bounds apply
together; content/object maxima do not waive the encoded snapshot byte cap.

## Results

`result.index` defaults to zero and selects a 3072-byte chunk of canonical receipt
bytes. Responses include `index`, `chunks`, total `bytes`, base64 `data`, a chunk
SHA-256, and the whole-receipt `sha256` (equal to `receipt_id`). `next_index` is
null after the last chunk. Consumers verify chunk and whole digests; matching
shape alone does not establish integrity or scope. Capabilities report the exact
reader, content, object and chunk limits before clients construct a snapshot.
