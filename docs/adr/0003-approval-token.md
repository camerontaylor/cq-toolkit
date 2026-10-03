# ADR-0003 annex — Human-approval token for `approved:true` jobs

Status: **accepted** (owner G1 sign-off, 2026-09-26; drafted as proposed, revision r1; part of ADR-0003; implements W4.3, closes J4 M3, guards A16).

- Critic round 1 dispositions: `adr-0003-r1-dispositions.md` (private `toolkit-research` repository, not published here) (M5, M6, m9 touch this annex).

Anchors (cq-toolkit `5e52707`):

- `ops/analyze/applyRemediation.ts:95,172-188,195-198` (the boolean gate; sidecar digests bound to analysis time);
- `ops/analyze/codemod/astGrep.ts:614-624,677-681,714-755` (the engine primitive's boolean; the **intra-op**
  freshness anchor);
- `ops/analyze/playbooks/registry.ts:20-27,400-411` (dispatch self-satisfies `approved: true`; runtime
  derivation);
- `ops/analyze/registry.ts:260,279`;
- `kernel/manifest.ts:27,46-64`;
- `harness/tools.ts:29-37` (`run` has host privileges when the sandbox is off).

## 1. Threat model (r1: scoped honestly)

- **Checked parties** (untrusted): plan JSON and CLI plan files; PR head content; model workers and anything they
  can write or execute (P1); review text.
- **Trusted:** the approver's private key; the signer list and nonce ledger **as snapshotted at `runPlan` start**
  from the P1-trusted layer (§4).
- **Out of scope:** the embedding program (the owner acting).
- **Guarantees by environment:**

| Environment                                                           | Plan-data attacker (A16) | Worker, in-run     | Worker, cross-run (same host)                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI, signers/ledger from default-branch `vars.*`/runner-external state | blocked                  | blocked            | blocked (the worker can't write the trusted layer)                                                                                                                                                                   |
| Local, `CQ_SANDBOX=required` (certified backend)                      | blocked                  | blocked            | blocked (the worker can't reach `$XDG_STATE_HOME` or the signer path)                                                                                                                                                |
| Local, `CQ_SANDBOX=off` (`solo-maintainer`), **attended**             | blocked                  | blocked (snapshot) | **not blocked**: an allowlisted command running worker-edited code as the operator's uid can append a public key to the signer file or truncate the ledger for a _later_ run. The human's presence is the mitigation |
| Local, `CQ_SANDBOX=off`, **unattended**                               | —                        | —                  | **Approval-required jobs are refused** (`needs-human: approval jobs need attended:true or CQ_SANDBOX=required`)                                                                                                      |

The residual in the third row is recorded for the owner at G1, next to the V11PLAN §14 sandbox-off residual.
**`attended` is operator-declared and unverified** (G1 reconciliation, critic r2 m-k): setting it for unattended
automation, e.g. an agent fleet composing the `cq` command line, moves a run from the fourth row to the third and
removes the refusal.

- **Goal:** an `approval.required` job's write happens only if a human, holding a key that was registered before
  the run, approved _this_ op on _this_ input against _this_ workspace in _this_ state, recently, once. It is
  checked **at the moment of the write**.

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
    "workspace": "/abs/realpath/of/worktree",             // r1 (m9): binds the workspace, not only the SHA
    "headSha": "…",
    "treeClean": true                                     // predicate in §4 step 6
  },
  "note": "≤ 200 chars, display only"
}
```

- **Why Ed25519** (`node:crypto`, no dependency): verifiers hold only public keys, so CI and unattended runners
  have no minting capability. HMAC was rejected for exactly this reason.
- SSHSIG (agent or hardware keys) is a v1.2 envelope option. The claim is unchanged.

## 3. Issuing (`cq approve`)

```
cq approve --plan <file> --job <id> --state git:<dir> [--ttl 4h] --key <path> > approval.cqa
```

1. It computes the job's `inputsHash` (`makeManifest`) and resolves the state:
   `realpath(dir)`, `HEAD`, and the clean predicate.
2. It prints the op, job, input summary and state. **For `playbookDispatch` it also prints the derived child
   targets** computed on that state.
3. It requires an interactive typed confirmation on a TTY. That is a speed bump; key custody is the control
   (passphrase-protected PKCS#8).
4. It signs.
5. `CQ_APPROVAL_KEY*` is on the harness env-scrub deny list (W1.5).

## 4. Verification: split into _admission_ and _exercise_ (r1, M5)

### 4a. At `runPlan` start (once, before any job dispatches)

- **Snapshot** the signer list (`CQ_APPROVAL_SIGNERS`, P1-trusted layer only; a path inside the workspace under
  review is refused) and the operator ledger's consumed-nonce set.
- **Fail closed** if either is configured but unreadable or unparseable (M6 ii). Every approval-required job
  becomes `needs-human`.
- Signers added after this point are ignored for the whole run (M6 i).

### 4b. At job admission (job gate)

For a job whose entry declares `approval.required(input) === true`:

1. **Environment gate:** unattended + `CQ_SANDBOX=off` → `needs-human` (§1 table).
2. **Candidate tokens** match `subject.planId` + `subject.jobId`. None → `needs-human`.
3. **Envelope:** `cqa1`, 3 segments, base64url, ≤ 4 KiB.
4. **Key** in the snapshot and not past `notAfter`. **Signature** verifies.
5. **Claim:**
   - `v`/`typ`;
   - `iat ≤ now + 60 s`, `now < exp`, `exp − iat ≤ maxTtl`;
   - `subject.op === job.op`, `subject.inputsHash === manifestJob.inputsHash`;
   - `state` is present, and `state.workspace === realpath(op's declared workspace)`.
6. **Nonce not spent** in snapshot ∪ folded `approval-consumed` ∪ this run's consumed set.
7. Create the **`ApprovalGrant`** (§6). It carries the claim's `state` and `nonce`, and is put on
   `currentJobContext().approval`.

**Nothing is consumed at admission.** A job that is later refused (attempt cap, quarantine, ADVISORY lane,
exhausted, tripped) never burns its token.

### 4c. At exercise: `exerciseGrant(grant)`, called by the engine primitive immediately before its first write

It runs under the **per-workspace mutation lock**. That lock is the same primitive as the plan lock (ADR §2.5, as
reconciled: a lock record at a location every contender agrees on, socket + pid/bootId liveness, record-nonce
fence), keyed on `sha256(realpath(workspace))`, and it is held **through the write** and released by the primitive
when the write completes or fails. **Where its lock record lives is open** (reconciliation O-5): an
environment-derived location (`os.tmpdir()`, `$XDG_STATE_HOME`) would reintroduce ADR §2.5's split-brain, and
sidecars never go in the workspace (tamper vector #26). The ledger lock's record sits beside the ledger file.
**Non-approval writers don't take this lock** (critic r2 m-c): the closing rule is open (O-6, ADR §2.7). The steps:

1. **Re-compute the state and require deep equality** with `grant.state`:
   - `realpath` matches;
   - `git rev-parse HEAD === headSha`;
   - the clean predicate: `git status --porcelain=v1 --untracked-files=all` is empty. Untracked files count as
     dirty. Ignored files are **out of scope** (a stated residual: an ignored file can influence a codemod that
     reads it).
2. **Nonce check-and-append, in one critical section** of the ledger lock (the same primitive): re-read the
   ledger, check against snapshot ∪ in-run ∪ fresh read, then append the nonce **durably to the operator ledger
   first** (m9).
3. Append `approval-consumed` to the journal, durably. It includes `workspace`, plus `children[]` for
   `playbookDispatch`.
4. Return. The primitive writes. The mutation lock is released after the write.

Crash analysis:

- A crash between step 2 and step 3 burns the token (safe). It can't leave the token replayable from a fresh
  journal dir.
- A crash after step 3 and before the write completes means the job's reservation (if any) is unresolved →
  quarantine (ADR §2.5).

Any failure → `needs-human` with a specific reason: `approval state changed since approval: HEAD <x> ≠ <y>`,
`workspace dirty`, `nonce spent`, `ledger unreadable`. Only kid, nonce and subject hash are journalled; token
bytes never are. A token grants nothing beyond its subject. It never relaxes budgets, sandbox or tool policy.

## 5. Single-use scope and resume

- **Two nonce records:**
  1. The journal (audit and replay).
  2. The operator ledger `CQ_APPROVAL_LEDGER`, blank `$XDG_STATE_HOME/cq/approvals.ndjson`. It is P1-trusted
     layer only, and never inside a workspace.
- **Same host, fresh `--journal-dir`:** blocked by the ledger.
- **Across hosts or ephemeral runners:** bounded by the mandatory state (workspace + HEAD + clean tree), plus
  `exp`/TTL.
  - A worker holding `git` could restore the pre-apply state (`reset --hard`) and re-perform the _identical_
    approved change. The harm is low, as the critic accepted.
  - With the sandbox off, the same worker could equally make the change directly. The token adds no capability.
- **Resume:** consumed approvals don't carry over. A job that did not finish `ok` needs a fresh token. An
  unresolved reservation also quarantines it.

## 6. The in-process capability

```ts
// src/kernel/approval.ts
declare const grantBrand: unique symbol;
export interface ApprovalGrant {
  readonly [grantBrand]: true;
  readonly jobId: string; readonly op: string; readonly inputsHash: string;
  readonly nonce: string; readonly kid: string;
  readonly state: Readonly<ApprovalState>;           // r1: carried, so exercise can re-check it
}
const issued = new WeakSet<object>();               // only the §4b verifier adds
const exercised = new WeakSet<object>();            // exerciseGrant is at-most-once per grant
export function isApprovalGrant(x: unknown): x is ApprovalGrant;
export function exerciseGrant(grant: ApprovalGrant, write: () => Promise<void>): Promise<void>; // §4c, lock held through `write`
```

- Engine primitives (`makeAstGrepCodemod` apply, `applyRemediation`) take `grant` instead of `approved: boolean`,
  and perform their writes **inside** `exerciseGrant(grant, write)`. A grant exercised twice throws.
- **`ExercisedScope` (G1 reconciliation, critic r2 m-c(ii)).** Inside `exerciseGrant`, the kernel hands the `write`
  callback an in-lock, non-serializable `ExercisedScope` capability (branded like `ApprovalGrant`, valid only until
  `write` settles). Engine primitives accept **either** a grant (they exercise it) **or** an `ExercisedScope` (they
  write under the already-held lock and already-consumed nonce, without re-exercising).
- **`playbookDispatch`:**
  - It no longer self-satisfies approval (`playbooks/registry.ts:409`). It exercises its own grant **once**.
  - The derived child applies receive the parent's `ExercisedScope`, never the raw grant. r1's "forwards its grant"
    would have exercised it twice (which throws) and re-acquired the non-re-entrant lock.
  - The state re-check therefore covers exactly the workspace the derivation read.
  - The derivation itself runs under the mutation lock, before the write.
  - `children[]` subjects are journalled.
- **Plan-JSON `approved`:** during migration it is `approved?: unknown`, ignored, with a narration. It is then
  removed. A16 expects `needs-human` in both phases.
- A grant is not serializable. Only the kernel verifier creates one.

## 7. Tests (P3)

- **Unit:** each failure in §4a–4c → `needs-human`, and a spy shows no write. Cases:
  - wrong kid, bad signature, a flipped claim byte, expired, TTL too long;
  - wrong op, wrong inputsHash, wrong workspace;
  - state changed between admission and exercise;
  - a dirty tree from an untracked file;
  - a spent nonce, an unreadable ledger;
  - a signer added mid-run (ignored → `needs-human`).
- **TOCTOU (M5):** two jobs on one workspace; job A's commit lands between B's admission and B's exercise → B is
  `needs-human (HEAD changed)`, with no write, and B's nonce is **unspent**.
- **TOCTOU during the write (G1 reconciliation, critic r2 m-c):** a concurrent non-approval writer on the same
  workspace attempts a change between B's step-1 re-check and the end of B's write → per the O-6 rule, the writer
  is not co-scheduled or waits on the lock; B's write sees the re-checked state.
- **Nested grant:** `playbookDispatch` with two derived child applies → one `approval-consumed`, both children write
  via the `ExercisedScope`, and no "grant exercised twice" throw.
- **Burn order:** a token on a job refused by the attempt cap, by an **ADVISORY refusal**, or by an `exhausted`
  trip stays unspent. This test is now consistent: the ADVISORY refusal happens before any write, and
  consumption happens only at exercise.
- **A16 e2e:** plan JSON with `approved:true` to `playbookDispatch`/`applyRemediation` and no token →
  `needs-human`, untouched workspace.
- **Replay:** the same token again → `nonce spent`. Fresh `--journal-dir` → refused by the ledger. Ledger wiped →
  refused by the state (HEAD moved or tree dirty). A second clean worktree at the same SHA → refused (workspace
  mismatch).
- **Environment gate:** unattended + `CQ_SANDBOX=off` → `needs-human` before token parsing.
