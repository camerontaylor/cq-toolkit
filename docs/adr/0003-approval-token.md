# ADR-0003 annex — Approval token

- **Status:** accepted (G1, 2026-09-26)
- **Date:** 2026-09-25
- **Amends / Related:** part of [ADR-0003](0003-governed-runner.md) (§2.7); implements W4.3 and guards the A16
  forged-approval attack.

Post-acceptance note N5 in the [ADR index](README.md#post-acceptance-notes) narrows parts of this record.

The token replaces the plan-data boolean `approved: true`, which any plan author can write, in the analyze ops
(`applyRemediation`, the ast-grep codemod engine primitive, and `playbookDispatch`, which used to self-satisfy the
boolean). It is a signed, state-bound, single-use capability checked at the moment of the write.

## 1. Threat model

- **Checked parties** (untrusted): plan JSON and CLI plan files; PR head content; model workers and anything they
  can write or execute (P1); review text.
- **Trusted:** the approver's private key; the signer list and nonce ledger **as snapshotted at `runPlan` start**
  from the P1-trusted layer (§4a). **Out of scope:** the embedding program (the owner acting).
- **Guarantees by environment:**

| Environment                                                           | Plan-data attacker (A16) | Worker, in-run     | Worker, cross-run (same host)                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI, signers/ledger from default-branch `vars.*`/runner-external state | blocked                  | blocked            | blocked (the worker can't write the trusted layer)                                                                                                                                                                   |
| Local, `CQ_SANDBOX=required` (certified backend)                      | blocked                  | blocked            | blocked (the worker can't reach `$XDG_STATE_HOME` or the signer path)                                                                                                                                                |
| Local, `CQ_SANDBOX=off` (`solo-maintainer`), **attended**             | blocked                  | blocked (snapshot) | **not blocked**: an allowlisted command running worker-edited code as the operator's uid can append a public key to the signer file or truncate the ledger for a _later_ run. The human's presence is the mitigation |
| Local, `CQ_SANDBOX=off`, **unattended**                               | —                        | —                  | **Approval-required jobs are refused** (`needs-human: approval jobs need attended:true or CQ_SANDBOX=required`)                                                                                                      |

The third row's residual is recorded for the owner next to the sandbox-off residual (D14). **`attended` is
operator-declared and unverified:** setting it for unattended automation (e.g. an agent fleet composing the `cq`
command line) moves a run from the fourth row to the third and removes the refusal.

**Goal:** an `approval.required` job's write happens only if a human, holding a key registered before the run,
approved _this_ op on _this_ input against _this_ workspace in _this_ state, recently, once, checked **at the moment
of the write**.

## 2. Token format

```
cqa1.<b64url(claimBytes)>.<b64url(ed25519Signature(claimBytes))>
```

`claimBytes` is the UTF-8 JSON as signed. The verifier checks the signature over these exact bytes before parsing.

```jsonc
{
  "v": 1, "typ": "cq-approval", "kid": "cam-2026",
  "iat": 1790000000000, "exp": 1790086400000,            // exp − iat ≤ maxTtl (blank 24 h)
  "nonce": "9f1c…32 hex",                                 // 128-bit random; single use (§5)
  "subject": { "op": "analyze.applyRemediation", "planId": "…", "jobId": "…", "inputsHash": "sha256:…" },
  "state": {                                              // MANDATORY for mutating ops
    "kind": "git",
    "workspace": "/abs/realpath/of/worktree",             // binds the workspace, not only the SHA
    "headSha": "…",
    "treeClean": true                                     // predicate in §4c step 1
  },
  "note": "≤ 200 chars, display only"
}
```

**Ed25519** (`node:crypto`, no dependency) because verifiers hold only public keys, so CI and unattended runners
cannot mint; HMAC was rejected for this reason. SSHSIG (agent or hardware keys) is a v1.2 envelope option with the
same claim.

## 3. Issuing (`cq approve`)

```
cq approve --plan <file> --job <id> --state git:<dir> [--ttl 4h] --key <path> > approval.cqa
```

It computes the job's `inputsHash` (`makeManifest`) and resolves the state (`realpath(dir)`, `HEAD`, the clean
predicate); prints the op, job, input summary and state, and **for `playbookDispatch` the derived child targets**
computed on that state; requires a typed confirmation on a TTY (a speed bump: key custody, passphrase-protected
PKCS#8, is the control); and signs. `CQ_APPROVAL_KEY*` is on the harness env-scrub deny list (W1.5).

## 4. Verification: split into _admission_ and _exercise_

### 4a. At `runPlan` start (once, before any job dispatches)

**Snapshot** the signer list (`CQ_APPROVAL_SIGNERS`, P1-trusted layer only; a path inside the workspace under review
is refused) and the operator ledger's consumed-nonce set. If either is configured but unreadable or unparseable,
**fail closed**: every approval-required job becomes `needs-human`. Signers added later are ignored for the run.

### 4b. At job admission (job gate)

For a job whose entry declares `approval.required(input) === true`:

1. **Environment gate:** unattended + `CQ_SANDBOX=off` → `needs-human` (§1 table).
2. **Candidate tokens** match `subject.planId` + `subject.jobId`. None → `needs-human`.
3. **Envelope:** `cqa1`, 3 segments, base64url, ≤ 4 KiB.
4. **Key** in the snapshot and not past `notAfter`. **Signature** verifies.
5. **Claim:** `v`/`typ`; `iat ≤ now + 60 s`, `now < exp`, `exp − iat ≤ maxTtl`; `subject.op === job.op`,
   `subject.inputsHash === manifestJob.inputsHash`; `state` present, with
   `state.workspace === realpath(op's declared workspace)`.
6. **Nonce not spent** in snapshot ∪ folded `approval-consumed` ∪ this run's consumed set.
7. Create the **`ApprovalGrant`** (§6), carrying the claim's `state` and `nonce`, on `currentJobContext().approval`.

**Nothing is consumed at admission**: a job later refused (attempt cap, quarantine, ADVISORY lane, exhausted,
tripped) never burns its token.

### 4c. At exercise: `exerciseGrant(grant)`, called by the engine primitive immediately before its first write

It runs under the **per-workspace mutation lock**: the plan-lock primitive
([ADR-0003 §2.5](0003-governed-runner.md#25-crash-resume-lock-and-ungoverned-runs)) keyed on
`sha256(realpath(workspace))`, held **through the write** and released by the primitive when the write completes
or fails. **Where its record lives is open** (O-5): an environment-derived location (`os.tmpdir()`,
`$XDG_STATE_HOME`) would reintroduce §2.5's split-brain, and sidecars never go in the workspace (a tamper vector).
Non-approval writers don't take this lock; the closing rule is open (O-6, ADR-0003 §2.7).

> Open: see post-acceptance note N5 in the [ADR index](README.md#post-acceptance-notes).

1. **Re-compute the state and require deep equality** with `grant.state`: `realpath` matches;
   `git rev-parse HEAD === headSha`; and the clean predicate, `git status --porcelain=v1 --untracked-files=all` is
   empty (untracked files count as dirty; ignored files are **out of scope**, a stated residual since an ignored
   file can influence a codemod that reads it).
2. **Nonce check-and-append, in one critical section** of the ledger lock (the same primitive): re-read the
   ledger, check against snapshot ∪ in-run ∪ fresh read, then append the nonce **durably to the operator ledger
   first**.
3. Append `approval-consumed` to the journal, durably, with `workspace` and, for `playbookDispatch`, `children[]`.
4. Return. The primitive writes; the mutation lock is released after the write.

A crash between steps 2 and 3 burns the token (safe; it can't be replayed from a fresh journal dir). A crash after
step 3 and before the write completes leaves the job's reservation (if any) unresolved → quarantine (ADR-0003 §2.5).

Any failure → `needs-human` with a specific reason (`approval state changed since approval: HEAD <x> ≠ <y>`,
`workspace dirty`, `nonce spent`, `ledger unreadable`). Only kid, nonce and subject hash are journalled, never token
bytes. A token grants nothing beyond its subject and never relaxes budgets, sandbox or tool policy.

## 5. Single-use scope and resume

- **Two nonce records:** the journal (audit and replay), and the operator ledger `CQ_APPROVAL_LEDGER` (blank
  `$XDG_STATE_HOME/cq/approvals.ndjson`; P1-trusted layer only, never inside a workspace).
- **Same host, fresh `--journal-dir`:** blocked by the ledger.
- **Across hosts or ephemeral runners:** bounded by the mandatory state (workspace + HEAD + clean tree) plus
  `exp`/TTL. A worker holding `git` could restore the pre-apply state (`reset --hard`) and re-perform the
  _identical_ approved change; the harm is low and accepted (with the sandbox off it could make the change directly).
- **Resume:** consumed approvals don't carry over. A job that did not finish `ok` needs a fresh token; an unresolved
  reservation also quarantines it.

## 6. The in-process capability

```ts
// src/kernel/approval.ts
declare const grantBrand: unique symbol;
export interface ApprovalGrant {
  readonly [grantBrand]: true;
  readonly jobId: string; readonly op: string; readonly inputsHash: string;
  readonly nonce: string; readonly kid: string;
  readonly state: Readonly<ApprovalState>;           // carried, so exercise can re-check it
}
const issued = new WeakSet<object>();               // only the §4b verifier adds
const exercised = new WeakSet<object>();            // exerciseGrant is at-most-once per grant
export function isApprovalGrant(x: unknown): x is ApprovalGrant;
export function exerciseGrant(grant: ApprovalGrant, write: () => Promise<void>): Promise<void>; // §4c, lock held through `write`
```

- Engine primitives (`makeAstGrepCodemod` apply, `applyRemediation`) take `grant` instead of `approved: boolean`,
  and perform their writes **inside** `exerciseGrant(grant, write)`. A grant exercised twice throws. A grant is not
  serializable, and only the kernel verifier creates one.
- **`ExercisedScope`.** Inside `exerciseGrant`, the kernel hands `write` an in-lock, non-serializable
  `ExercisedScope` (branded like `ApprovalGrant`, valid only until `write` settles). Engine primitives accept
  **either** a grant (they exercise it) **or** an `ExercisedScope` (they write under the already-held lock and
  already-consumed nonce, without re-exercising).
- **`playbookDispatch`** no longer self-satisfies approval: it exercises its own grant **once**, runs the derivation
  under the mutation lock before the write, and passes the derived child applies its `ExercisedScope`, never the raw
  grant (which would throw on a second exercise and re-acquire the non-re-entrant lock). The state re-check thus
  covers exactly the workspace the derivation read. `children[]` subjects are journalled.
- **Plan-JSON `approved`:** during migration it is `approved?: unknown`, ignored, with a narration; it is then
  removed. A16 expects `needs-human` in both phases.

## 7. Tests (P3)

- **Unit:** each failure in §4a–4c → `needs-human`, and a spy shows no write: wrong kid, bad signature, a flipped
  claim byte, expired, TTL too long; wrong op, inputsHash or workspace; state changed between admission and
  exercise; a dirty tree from an untracked file; a spent nonce, an unreadable ledger; a signer added mid-run.
- **TOCTOU:** two jobs on one workspace; job A's commit lands between B's admission and B's exercise → B is
  `needs-human (HEAD changed)`, with no write, and B's nonce is **unspent**.
- **TOCTOU during the write:** a concurrent non-approval writer tries to change the workspace between B's step-1
  re-check and the end of B's write → under the O-6 rule it is not co-scheduled or waits on the lock, and B's write
  sees the re-checked state.

  > Open: this case is conditional on O-6; see post-acceptance note N5 in the
  > [ADR index](README.md#post-acceptance-notes).

- **Nested grant:** `playbookDispatch` with two derived child applies → one `approval-consumed`, both children write
  via the `ExercisedScope`, and no "grant exercised twice" throw.
- **Burn order:** a token on a job refused by the attempt cap, an **ADVISORY refusal** or an `exhausted` trip stays
  unspent (consumption happens only at exercise).
- **A16 e2e:** `approved:true` in plan JSON for `playbookDispatch`/`applyRemediation`, no token → `needs-human`,
  untouched workspace.
- **Replay:** same token → `nonce spent`; fresh `--journal-dir` → ledger refuses; ledger wiped → state refuses (HEAD
  moved or tree dirty); a second clean worktree at the same SHA → workspace mismatch.
- **Environment gate:** unattended + `CQ_SANDBOX=off` → `needs-human` before token parsing.
