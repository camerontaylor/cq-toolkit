# Tree snapshots (P5)

P4's commit request and P3's lease/state bytes stay unchanged. The worker may
instead supply `--tree=<40hex>` to `cq dev.review`; exactly one of `--head` and
`--tree` is required. The base is an immutable commit already available in the
runner clone. The tree must already exist in the worker repository. For example,
`git write-tree` names the staged snapshot; later working-file edits are excluded.
P5 itself never stages files, changes HEAD/the real index, or checks out content.
It reads `CQ_AUTHOR_REPO` (default cwd). No model/provider choice is built in.

```sh
cq dev.review --action=enroll --requestId=tree-cycle-1 --base=<40hex> --tree=<40hex> --target=origin/merge-queue --cycle=1 --json
```

The operator must configure `CQ_AUTHOR_SNAPSHOT_SCANNER` as an absolute path to
an executable. It receives three argv values: repository, base commit, synthetic
head commit. No shell is used. It must scan **all outgoing object contents**, not
just textual diff lines, including new binary files, filenames and excluded or
untracked content explicitly placed in the tree. It must apply the operator's
publication denylist and credential rules, and return nonzero on tool errors,
missing policy or findings. Without a configured successful scan, no snapshot is
sent. The executable is trusted operator configuration, never a worker request
field; P5 does not install or configure it. Its output is not reflected to callers.
The runner additionally applies its existing path-aware denylist/gitleaks scan
to every incoming blob in quarantine, including binary and attribute-suppressed
content, as well as the ordinary diff. It matches actual paths and raw content
lines as structured values, so blob text cannot forge patch headers or an
allowlisted path
and retains the usual pre-review-upload scan. Scanner approval never starts a run.

## Identity and wire

A deterministic synthetic commit binds tree and base. Its exact UTF-8 body is:

```text
tree <tree>
parent <base>
author cq snapshot <snapshot@localhost> 0 +0000
committer cq snapshot <snapshot@localhost> 0 +0000

cq author snapshot v1
```

Every displayed line ends with LF, including the last. Its Git commit SHA-1 is
the existing P3 binding's `head`. Different contents/base produce a different
binding. Status/fallback derive this same SHA locally and send the original v1
request without re-uploading objects or rescanning. They retain P3's one-shot
fallback rule, immutable binding, timeout policy and author-start quota.

Enrollment uses the same separate `author-v1` forced command as P4, never the
promotion spool. The new envelope is `{v:2,op:"enroll",binding,snapshot}`;
`snapshot` is `{v:1,tree,objects,sha256}`. Objects are the exact reachable
`head ^base` closure, sorted by unique OID, with `{oid,type,data}` fields. Data is
canonical base64 of **uncompressed** Git-object content; no archive extraction,
pack inflation or filesystem paths are accepted. The digest is SHA-256 of each
object's `oid + NUL + type + NUL + data + LF`, concatenated in that order.
Only blobs, trees and the exact synthetic commit are accepted. Gitlinks are
refused. Limits are 4 MiB decoded content, 4096 objects, and 6 MiB wire bytes.
The worker has a 30-second capture budget and a separate 30-second scanner
budget. The existing server alarm bounds the entire request to 30 seconds;
individual server Git commands have a 10-second limit and bounded output reads.
The assembled path-aware scan input also has a 6 MiB limit, including repeated
blob references and decoded binary content; exceeding it refuses admission.
The P4 SSH deadline/connection limits and 8 KiB response bound are unchanged.

## Admission, recovery and rollback

The runner holds `tick.lock` throughout validation, scanning, installation and
P3 enrollment. A conflicting request ID is refused before object mutation.
Objects are written into a private temporary bare quarantine with read-only
alternates to the review clone. Object hashes, exact commit bytes, reachable
closure, types, missing objects, modes and nonempty diff are checked before the
runner scan and before copying any object into the review clone. No snapshot
hooks, external diff/textconv commands, replacement refs or inherited Git config
are executed. The private temporary directory is cleaned on normal errors;
SIGKILL may leave an inert OS-temp quarantine for operator cleanup, without queue
admission. A future retry validates from scratch; a partial transfer is refused.

After validation, objects enter the clone and a versioned ref
`refs/crq/author-snapshots/v1/<head>` pins the commit **before** enrollment. A crash
before that pin leaves only unreachable objects; a crash after it leaves a safe
pin with no issuer. Identical replay enrolls idempotently; conflicting replay
cannot rebind the request. Natural Python ticks alone acquire leases and issue
reviews. Pins intentionally remain for the review/recovery lifetime. There is no
automatic GC of pins in P5; operator retention/GC is a later change. Never delete
a pin still referenced by queue state, reviews or recovery records.

No persisted queue/item/run fields are added. The only new persistent state is
that versioned Git-ref namespace and its immutable Git objects. Older P4 code
refuses the v2 envelope but tolerates existing P3 author items and pins. Rollback
withdraws tree enrollment first; admitted synthetic heads continue to plan as
ordinary commits. Do not prune their refs on rollback. No signer, spool, units,
host overlay or deployment changes are part of this PR.

Characterization tests preserve the pre-P5 commit-only behavior. Offline real-Git
and TS-to-Python tests cover immutable capture, enrollment/planning, GC retention,
wire versioning, corruption, missing/unrelated objects, size limits, unsupported
modes, scans, conflicting trees, crash recovery and concurrent delivery.
