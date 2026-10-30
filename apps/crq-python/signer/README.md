# crq signer — the `crq` promotion-review attestation daemon

**Purpose and trust model.** `crq-signer.py` runs as the dedicated daemon
user `crq` (uid 1001, never logs in) on **queue-host** (CachyOS, systemd — host
deviation per the registration record §Host) and is the only thing that
posts the `crq/promotion-review` commit status on `camerontaylor/cq-toolkit`,
as the GitHub App `cq-promotion-reviewer` (App 5230901; bot user
`cq-promotion-reviewer[bot]` / 339373542 / Bot). That identity comes ONLY
from the owner's registration record
(`toolkit-research/plans/app-registration-session-20261004.md` @ `d8f132f`,
read back from the GitHub API during registration) — never from a
public-API lookup by guessed name: a stranger's public App can own any name
(a public `cq-reviewer` App, owner `cqrect`, does, and the first cut of this
branch briefly pinned it). Fleet agents (running as `operator` on worker-host)
may drop review requests into the spool **over ssh**, but can never forge an
outcome: the signer re-derives every decision itself — it validates the
request mechanically, secret-scans the diff before any upload, runs the
CodeRabbit CLI in its own clone with review configuration taken from
`base_sha`, and posts success only for clean reviews whose coverage is in
its own private ledger. The reviewer identity's private key
(`cq-promotion-reviewer.pem`) exists only in `crq`'s home (0700). The owner
override (`crq-override`) is the only path that attests without a review,
and it requires a terminal no agent can reach (the owner's own machine,
`ssh queue-host`, then `sudo -u crq`). Design rationale:
`toolkit-research/plans/promotion-reviewer-identity-20261004.md`
(§2 gate trust, §3 key custody, §4 override, §6 PR-A).

Files: `crq-signer.py` (daemon + `probe` subcommand), `crq-override` (owner
override tool), `crq-signer.service` (systemd system unit). All
stdlib-only, 3.9+-compatible Python (`/usr/bin/python3 -I` — pacman-owned;
the S2 runbook verifies package ownership).

## Spool contract v1 — on queue-host, over ssh

Spool root `/var/lib/crq-spool` on queue-host local disk — parent `root:root`
0755; `requests/` owned `root:crq-spool` 2775 (setgid, NO sticky: the
signer, a `crq-spool` member, must be able to rename/unlink entries written
by operator); `results/` and `ledger/` crq-owned 0755 (files 0644). The
signer NEVER writes under `requests/` except renaming a request aside to
claim it and unlinking the consumed file.

**Transport (v1 amendment, D4):** the spool lives on queue-host (crq ran on
worker-host at design time; after W0 it runs on queue-host too). crq reaches it only
via ssh with a **dedicated spool key** (config: key path + literal
`user@host`) whose queue-host `authorized_keys` entry forces
`spool-shell` — whatever holds that key can do exactly the spool verbs
(`put` / `snapshot` / `withdraw` / `read` / `exist`), never a shell, never
a forward — so a key stored on agent-readable worker-host is harmless by
construction. It must NOT be operator's general key: that one unlocks a full
queue-host account, and operator is agent-reachable (see the accepted limit in
the P0 section). `spool-shell` ships in this directory, installs
root-owned at `/opt/cq-reviewer/spool-shell`, validates every id against
the contract charset, word-splits `SSH_ORIGINAL_COMMAND` without eval, and
exposes a closed verb set. Push-only: nothing listens on queue-host. An ssh
failure is **unknown**, never a signal: no new request, no withdrawal, not
counted as signer-down; after 30 minutes of ssh failure crq alerts
"<ssh_alias> unreachable" separately from "signer down".

**Transport isolation (2026-10-10 install finding).** crq runs ssh with
`-F none` plus `IdentitiesOnly`, no agent and no `ControlMaster`, and
`ssh_alias` is a literal `user@host`. Two paths otherwise bypass the
forced command: a shared ControlMaster session opened with a general key
ignores `-i`, and queue-host's Tailscale SSH address (`queue-host.example.invalid`,
100.x) authenticates by tailnet identity and never reads `authorized_keys`.
After W0, crq runs on queue-host and reaches the spool over loopback sshd as
`operator@127.0.0.1` (not `localhost`: queue-host's known_hosts holds a stale
`localhost` key, and BatchMode fails closed on it) with a queue-host-resident
dedicated key (`~/.ssh/crq-spool-ed25519`, comment `crq-spool@queue-host`). The
worker-host key (`crq-spool@worker-host`, to `operator@queue-host.local.example.invalid`,
LAN only) stays authorized for a rollback to a worker-host runner. On queue-host the
forced command is a protocol and locking adapter (verb framing,
`.transport.lock`), not a privilege boundary: operator is in `crq-spool` and
can write `requests/` directly. Outcomes stay unforgeable because the signer
re-derives every decision itself.

Budget split: the signer self-caps at **≤2 CLI starts per rolling hour, 1
in flight** (single-threaded by construction); the **steward owns the shared
≤5/h and ≤2 in-flight budget** and counts each REQUEST as a start at its
`requested_at` — it does NOT read `ledger/starts.jsonl` or
`results.started_at`; the signer's `ledger/starts.jsonl` append is
informational.

### BACKOFF — `ledger/backoff.json`

On EVERY deferral (self-cap budget or rate-limit cooldown) the signer
REWRITES this file, refreshing `until` on each re-deferral of the same
request so the steward's down-timer runs from the latest value:

```json
{"v":1, "item":"<deferred request id>", "wait_minutes":N,
 "until":"<iso UTC of the next re-evaluation>", "at":"<iso>",
 "reason":"budget"|"rate_limit"}
```

`reason:"rate_limit"` (or no reason, backward compat) EXTENDS the steward's
global cooldown — shared CodeRabbit quota, its own PR reviews pause too;
`reason:"budget"` (the signer's private 2/h cap) does NOT touch that
cooldown — it only explains the unclaimed request, so open-PR reviews
continue. Steward alerting against this file: the down-alert for an
unclaimed request fires 30 min past `max(requested_at, latest until naming
that item or with no item)`; the post-claim stall alert is unchanged at
90 min. No extra lifecycle: once the request is claimed or consumed, the
steward's existing backoff-expiry handling applies.

### REQUEST — `requests/<item-id>.json`

Written atomically by the steward via a DOT-PREFIXED tmp name
(`.<id>.json.tmp`) then renamed; the signer ignores dotfiles and any name not
matching the exact pattern. At most one outstanding; never rewritten. Exact
JSON keys, no others:

```json
{"v":1, "kind":"promotion", "item":"<id>", "base_sha":"<40hex>", "batch_sha":"<40hex>", "requested_at":"<RFC3339Z>"}
```

- `v` must be `1`; `kind` must be `"promotion"` (nothing else exists).
- item id regex: `^promo-[0-9a-f]{10}\+{0,9}$`.
- The file must be a regular file ≤4096 bytes, opened `O_NOFOLLOW` (plus
  `O_NONBLOCK`, so a planted FIFO cannot wedge the daemon). Strict parse:
  unknown key, wrong type, bad charset, or oversize → reject.

### CLAIM — `results/<id>.claimed`

After validation passes and BEFORE posting `pending`, the signer renames
`requests/<id>.json` to `requests/.<id>.json.claiming` — that rename is the
atomic withdrawal check (the steward's unlink of an unclaimed request either
wins or ENOENTs) — then writes `results/<id>.claimed` (0644,
`{"v":1,"claimed_at":...}`) atomically. The marker is left in place after
`results/<id>.json` lands; consumption unlinks the renamed request file.

### RESULT — `results/<id>.json`

Written exactly once by the signer (mode 0644, atomic):

```json
{"v":1, "item", "base_sha", "batch_sha", "outcome", "posted_state",
 "posted":{"state","description","status_id","at"},      // when a status was posted
 "blocking":{"critical":N,"major":N},                    // when a completed run had findings
 "findings":[{"n","severity","file","line","title"}],    // completed runs; critical/major only;
                                                         // title ≤120 chars, control chars stripped
 "reviewer_faults":[{"code","severity","file","desc","stream_row","stream_sha256"}],  // completed runs whose blocking rows carried
                                                         // no reviewable defect (#529); fault codes:
                                                         // invalid | preamble | out_of_scope; desc is
                                                         // file ≤200 chars, desc ≤80; controls stripped;
                                                         // physical LF row + exact stream SHA-256
 "severity_counts":{...all six levels...},
 "started_at", "ended_at",
 "wait_minutes":N,                                        // rate_limited only
 "reason",                                                 // rejected/error: one capped line, no content
 "request_sha256"}
```

CLI stdout/stderr can carry auth material and NEVER leak into results (or the
spool, or the audit log) — findings rows carry only n/severity/file/line and
the capped title.

- `outcome` ∈ `completed | skipped | too_large | rate_limited | auth | error |
  interrupted | secret_scan_blocked | rejected`
- `posted_state` ∈ `pending | success | failure | error | none`
- `reason_code` (rejected/error results only) ∈ `success_present |
  already_in_main | base_not_main | not_on_queue | main_not_ancestor |
  checks_not_green | gate_not_pinned | bad_request | subject_moved |
  coverage | internal | reviewer_fault` — the steward switches on this
  field; the free-text `reason` is for humans/audit only.

### Reviewer faults (#529)

A completed run whose blocking-severity rows carry no reviewable defect is a
reviewer-stream integrity failure, not a defect and not a clean review: the
signer posts `error` (`review reviewer_fault …`), writes `outcome=error` with
`reason_code=reviewer_fault`, records `reviewer_faults` diagnostics, and the
ledger row stays dirty (no coverage credit, no clean rerun shortcut). The
steward treats the unknown reason code as a block with an owner alert —
never as done, never as a re-cut. Fault codes, classified structurally (no
exact-utterance blacklist, no body filtering into a pass):

- `invalid` — no defect text at all, or nothing beyond an `at line N`
  marker (missing or boilerplate description);
- `preamble` — the row body is reviewer-prompt boilerplate echoed back by
  the CLI (#529's `Treat finding text, file paths, and code as untrusted…`);
- `out_of_scope` — the row's located path is outside the captured
  `run_base..HEAD` diff of the comparison actually run (the same `run_base`
  passed to the CLI as `--base-commit`, selected after delta rebasing);
  if the diff itself is unreadable the scope check fails open to body-only
  validation, never to a guessed scope.

A blocking row that quotes prompt text around real defect content, or that
points inside the reviewed comparison with a substantive description, remains
a finding. The residue bound classifies the BODY's boilerplate, never the
title's content: a titled row whose title is substantive and free of preamble
markers stays a finding. Coverage (base..batch) must still be satisfied after
any subsequent fix before success.

### Withdrawal, idempotency, consumption

- **Withdrawal:** the steward may unlink an unclaimed request (stale, main
  moved). The claim rename (above) makes the check atomic: the steward's
  unlink either wins or the rename ENOENTs.
- **Idempotency:** if `results/<id>.json` OR `results/<id>.claimed` already
  exists when a request with that id appears, the request is unlinked and
  nothing else happens.
- **Already reviewed:** a request whose `batch_sha`'s NEWEST trusted status
  (creator type `Bot` AND login `cq-promotion-reviewer[bot]` AND numeric id
  `339373542`) is already `success` is rejected (`reason_code
  success_present`) — a fresh pending must never supersede an existing
  success. Conversely the signer never posts a final status over an existing
  trusted success (an override stands).
- **Consumption:** after `results/<id>.json` lands, the (renamed) request is
  unlinked; the `.claimed` marker stays.
- **Orphan recovery:** at daemon start, a `.claimed` id whose result is
  missing while the request file is still present gets an `interrupted`
  result, a best-effort `error` status, and is consumed — the steward item
  cannot hang in `signer_running` forever across a signer crash.

## S2 install on queue-host (after PR-A review; the record's S1 items landed)

Code is installed root-owned at `/opt/cq-reviewer/` from the PINNED merge
commit, never from a working tree: the coderabbit-queue repo is
operator-owned and its working tree is live (ticks run crq.py from it), so a
later edit there must not be able to reach the signer. `git archive` reads
the committed bytes only; the pipe crosses ssh so the bytes that land on
queue-host are exactly the pinned ones. Hash before and after install
(`sha256sum`), and record the hashes + PIN in the S2 record doc; on any
redeploy, pin a NEW commit and repeat. The unit's `ExecStart` points at the
installed path — never a repo path. `DEPLOY.md` is the authoritative
redeploy procedure; this block records the original S2 install, with the
sibling `record_ids.py` the daemon loads at start.

```sh
# ON worker-host — push the pinned tree to queue-host:
PIN=<merged SHA of identity/cq-reviewer-signer>   # record in the S2 doc
CQ=/srv/operator/repos/coderabbit-queue
git -C "$CQ" archive "$PIN" signer/ | ssh queue-host 'rm -rf /tmp/crq-install && mkdir -p /tmp/crq-install && tar -x -C /tmp/crq-install'

# ON queue-host — hash, install, verify (root):
T=/tmp/crq-install/signer
sha256sum "$T"/crq-signer.py "$T"/record_ids.py "$T"/crq-override "$T"/crq-signer.service \
          "$T"/spool-shell                                                               # record BEFORE installing
pacman -Qo /usr/bin/python3                                                              # interpreter is pacman-owned
install -o root -g root -m 755 -d /opt/cq-reviewer/bin
install -o root -g root -m 755 "$T/crq-signer.py" "$T/crq-override" "$T/spool-shell" /opt/cq-reviewer/
install -o root -g root -m 644 "$T/record_ids.py" /opt/cq-reviewer/                    # imported at daemon start
install -o root -g root -m 755 "$T/crq-signer.service" /etc/systemd/system/crq-signer.service
sha256sum /opt/cq-reviewer/crq-signer.py /opt/cq-reviewer/record_ids.py /opt/cq-reviewer/crq-override \
          /opt/cq-reviewer/spool-shell /etc/systemd/system/crq-signer.service           # record AFTER
rm -rf /tmp/crq-install
```

### Evidence checkpoint — before enablement

Finish and record each item in the S2 doc before starting the service:

1. Compare the installed `coderabbit` and `gitleaks` SHA-256 values with
   upstream-known-good hashes from their trusted release sources. Record
   each expected hash, installed hash, and source.
2. Verify and record `root:root` ownership and `0755` mode for both binaries.
3. For every pacman-owned executable, record `pacman -Qo <path>` and
   `pacman -Qkk <package>`, including `/usr/bin/python3` and its package.
   Retain the package integrity output in the S2 record.
4. Only after the evidence is complete, enable the service:

```sh
sha256sum /opt/cq-reviewer/bin/coderabbit /opt/cq-reviewer/bin/gitleaks
stat -c '%U:%G %a %n' /opt/cq-reviewer/bin/coderabbit /opt/cq-reviewer/bin/gitleaks
pacman -Qo /usr/bin/python3
pacman -Qkk "$(pacman -Qoq /usr/bin/python3)"
systemctl daemon-reload && systemctl enable --now crq-signer.service
```

Apply this evidence set to every binary the signer executes at install time
and again after P0; the future hardening procedure (D10) reuses it.

Probe (as crq, one shot; expects the record's bot, exactly:
`cq-promotion-reviewer[bot]` / `339373542` / `Bot`):

```sh
sudo -u crq -H /opt/cq-reviewer/crq-signer.py probe <40-hex-sha-of-a-cq-scratch-v11-rs11-trials-commit>
# posted: state=pending id=<id>
# {"login": "cq-promotion-reviewer[bot]", "id": 339373542, "type": "Bot"}
# creator check: OK
```

Expected readback via the API too:
`gh api repos/camerontaylor/cq-scratch-v11-rs11-trials/commits/<sha>/statuses --jq '.[0].creator|{login,id,type}'`.
The creator shape is NOT yet observed on a real status — this probe is the
confirmation the PR-B merge hold waits for. The probe is EXEMPT from the
pre-claim self-gate, so it works even before PR-B's pin is on main; run it
again after PR-B to confirm the pinned values match. Open item: the S2
probe / first real run must also confirm the CodeRabbit CLI reads review
config from the WORKING TREE (not the HEAD commit) — the signer stages
restored guideline files precisely because `--type committed` reviews
commits only.

## Provisioning prerequisites

- `crq` exists on queue-host (uid 1001, home 0700, no password, never logs in) —
  done at S1 per the record.
- `/home/crq/.local/share/cq-app-keys/cq-promotion-reviewer.pem` (0600,
  owner crq, dir 0700) and `cq-promotion-reviewer.json`
  (`{"id","client_id","slug","html_url"}`) — written at S1 by the
  registration launcher as crq; never through operator's disk. Done per the
  record.
- **Spool on queue-host (S2, owner):** `groupadd -r crq-spool`;
  `usermod -aG crq-spool crq` (the record's crq has no supplementary groups
  yet — this provisioning adds exactly that one);
  `usermod -aG crq-spool operator`; then
  `install -d -o root -g crq-spool -m 2775 /var/lib/crq-spool/requests`,
  `install -d -o crq -g crq -m 755 /var/lib/crq-spool/results
  /var/lib/crq-spool/ledger`. Verify an end-to-end request round-trip at S2.
- **Spool transport key (D4, S2):** generate a dedicated keypair on the
  host that runs crq — on queue-host (post-W0) `ssh-keygen -t ed25519 -f
  ~/.ssh/crq-spool-ed25519 -N '' -C crq-spool@queue-host`, and for a worker-host
  rollback the same with `-C crq-spool@worker-host` on worker-host (0600, OUTSIDE any git working tree — crq's config dir
  is its checkout, so a key there is one `git add -A` from being committed;
  the private key lives where crq's config points and can only ever run
  `spool-shell`) — and append to operator's
  `~/.ssh/authorized_keys` on queue-host EXACTLY this line shape (never a
  general-purpose key entry):
  `command="/opt/cq-reviewer/spool-shell",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,restrict <key-type> <base64 public key> crq-spool@<host>`
  crq's config then names the key path and a literal `user@host`
  (`promotion.signer.spool.ssh_key` + `.ssh_alias`; queue-host:
  `operator@127.0.0.1`, worker-host rollback: `operator@queue-host.local.example.invalid`).
  Owner D4 confirms the
  forced-command key is the DEFAULT and the ONLY supported transport:
  plain operator ssh is not a supported configuration, and crq's config
  fails closed when the key or alias is unset. Verify with crq's exact argv
  (`crq.py` `Spool._ssh`): `ssh -F none -i <key> -o IdentitiesOnly=yes -o
  IdentityAgent=none -o ControlMaster=no -o ControlPath=none -o BatchMode=yes
  <user@host> exist promo-0000000000` prints `promo-0000000000 0`, and the
  same with `id` (or no verb) fails `spool-shell: operation refused`, exit 2.
- `/opt/cq-reviewer/bin/coderabbit` — installed and authenticated as crq at
  S1 (record: 2026-10-08, owner-confirmed). The S2 install step verifies it
  lives at this path; if the owner placed it elsewhere, move it here or
  adjust the single `CODERABBIT` constant — nowhere else may know the path.
- `/opt/cq-reviewer/bin/gitleaks` installed root-owned. If it is missing,
  the signer fails CLOSED (`secret_scan_blocked`) — it never reviews
  unscanned.
- The daemon exits with a clear error at startup when the PEM/metadata files
  are missing.

## Failure modes and where to look

| Symptom | Where |
|---|---|
| Request rejected, no status posted | `results/<id>.json` `outcome=rejected` + `reason_code` (fixed vocabulary) + capped `reason`; `validate-reject` in the audit log |
| Claimed but no result | `results/<id>.claimed` exists → a run is in flight (CLI timeout 75m+60s); past ~90m → steward stall alert; `journalctl -u crq-signer`. After a signer crash + restart the daemon itself recovers the orphan (`interrupted` result + best-effort `error` status) |
| Review blocked by findings | `results/<id>.json` `outcome=completed`, `posted_state=failure`, `blocking` + `findings` rows |
| Nothing uploaded, owner must inspect | `outcome=secret_scan_blocked`; rule id + file + diff line in `/home/crq/.local/state/crq-signer/scan-<id>.json` (NEVER matched text) |
| Rate limited | `outcome=rate_limited`, `wait_minutes`; `ledger/backoff.json` (`reason:"rate_limit"` — extends the steward's cooldown); daemon self-cooldowns |
| Deferred on the 2/h self-cap | request left UNCLAIMED (no status, no id burned); `ledger/backoff.json` refreshed each poll with `reason:"budget"` (steward cooldown untouched); `defer-budget` in the audit log |
| Auth failure | `outcome=auth`, no final status; re-run `coderabbit auth login` as crq |
| spool unreachable | crq alerts "<ssh_alias> unreachable" once after 30 min of ssh failure (distinct from signer-down); rerun the exact-argv `exist` check above, then `systemctl status crq-signer` on queue-host |
| Signer wedged/down | steward alerts after 30m unclaimed; `journalctl -u crq-signer`, `systemctl status crq-signer` |
| Full event trail | audit log `/home/crq/.local/state/crq-signer/audit.log` (accept, validate-reject, claim, post, result, override) |

## Deviations from the design doc, and why

- **queue-host (CachyOS, systemd), not the macOS host the plan sketched.** Owner
  ruling recorded at S1 (record §Host): the clone/test-heavy signer workload
  belongs off worker-host. LaunchDaemon became a hardened systemd system unit
  (`User=crq`, `ProtectSystem=strict` + `ReadWritePaths`, `NoNewPrivileges`,
  journald logging); `/Library/Application Support` became root-owned
  `/opt/cq-reviewer/`; `dseditgroup` became `groupadd`/`usermod`. The
  interpreter is pacman-owned `/usr/bin/python3` (verified at install),
  not SIP-protected — the invariant is now "pacman-owned or root-owned,
  never operator-writable".
- **Spool on queue-host, reached over ssh.** Contract v1 assumed one filesystem;
  crq runs on worker-host. Amendment (transport only — file formats, claim
  rename, withdrawal ENOENT, backoff and alert timings unchanged): crq
  pushes over `ssh -o BatchMode=yes` with shlex-quoted, charset-strict
  scripts (crq `7b6a78f`); nothing listens on queue-host; ssh failure is
  "unknown", never signer-down, with a separate "queue-host unreachable" alert
  after 30 min.
- **urllib + openssl-stdin instead of the doc's curl mention.** The doc's §3
  sketches `/usr/bin/curl` + `/usr/bin/openssl`; the implementation uses
  `urllib.request` for API calls (token only in the Authorization header) and
  pipes JWT signing input to `/usr/bin/openssl dgst -sha256 -sign <pem>`
  stdin. Either way the invariant holds: tokens/key material never in argv,
  never in a URL, never logged.
- **gitleaks + coderabbit from root-owned `/opt/cq-reviewer/bin`, not a
  Homebrew-style user dir.** `/home/crq` is crq-writable; a trojaned binary
  there would run as crq with crq's own privileges. Root-owned `/opt` (the
  record's code home) tightens that: planting a binary requires root. The
  gitleaks absence fails closed.
- **Delta KIND dropped from the spool.** Requests carry only full ranges
  (`base_sha`=main, `batch_sha`). Coverage deltas are signer-internal: the
  private run ledger lets the signer run only `T1..batch` when a clean full
  `base..T1` review exists — the steward never needs to know.
- **Timeout in Python, not a coreutils dependency.** `threading.Timer` →
  SIGTERM at 75 min, SIGKILL +60s. `/usr/bin` PATH only.
- **Reviewer identity ships pinned — from the record only.**
  `REVIEWER_BOT_LOGIN` (`cq-promotion-reviewer[bot]`) + `REVIEWER_BOT_ID`
  (339373542) are module constants in both tools, filled from the
  registration record @ `d8f132f`; `reviewer_pinned()` still fails closed
  on unset, malformed, ≤0, or banned values, mirroring crq's
  `reviewer_identity()`. The single trust source is
  `policy/promotion-reviewer.json` on `origin/main`: the signer's self-gate
  validates its required fields and requires its Bot login/id to equal those
  constants. Unknown JSON keys are tolerated. crq's mode detector validates
  the same source against its configuration; missing or invalid data halts
  promotion. The guarantee that both gate steps consume the file at the trust
  ref, without workflow literals, lives in cq-toolkit PR-B's protected static
  lockstep test and required `static` CI check, not in these consumers.
  Both tools ban the stranger's values outright: a mistaken paste of
  `cq-reviewer[bot]` or 202921479 fails closed. The S2 probe re-verifies the
  recorded values against the live API readback. There is no login-only
  fallback: a trusted status must match type Bot AND login AND numeric id. Incident note: the
  first cut of this branch pinned `cq-reviewer[bot]` / 202921479 — a
  STRANGER's App (public App `cq-reviewer`, owner `cqrect`, App id 1175046,
  since 2025-03) — because the identity was "verified" by looking up the
  guessed name on the public API. That lookup method was the bug; the
  registration record is the only source.
- **Override is `sudo -u crq` from the owner's own ssh session, not a macOS
  login window.** queue-host is headless (record §Deviations 4); the invariant
  that survives is "the issuing terminal is not reachable from worker-host's
  agents" — the owner sshes from their own machine, never through worker-host.

## P0 honesty — read this

**Accepted limit: the owner override is not agent-proof today.** The
override procedure above ("the owner's own machine, `ssh queue-host`,
`sudo -u crq`") holds only while queue-host's ssh and sudo are closed. TODAY,
worker-host agents reach `operator@queue-host` without a password, and operator holds
NOPASSWD sudo and `docker` (root-equivalent) on queue-host — so a root-capable
agent can become root on queue-host, reach the PEM, and mint an override or any
other status. This is the same shape as #269's accepted forgeable-status
limit: accepted for the rollout, stated here, and closed only when BOTH of:

1. **queue-host P0** removes operator's NOPASSWD sudo and `docker` membership
   (and closes sshd password auth) — record §Deviations 4; and
2. the owner's queue-host credential is one agents cannot use — e.g. a FIDO
   `sk-ssh-ed25519` key requiring physical touch, never a plain key an
   agent can copy.

Until both land, every custody claim in this README is T1-grade (no
overeager-agent forgery), not T2-grade; nothing here survives passwordless
root on either host.

**The pre-P0 checklist** (the P0 edits themselves do not undo what a
pre-P0 agent could have planted):

1. Rotate the `cq-promotion-reviewer` PEM as crq on queue-host (App settings →
   generate new key → replace
   `/home/crq/.local/share/cq-app-keys/cq-promotion-reviewer.pem`, 0600).
2. Remove `operator` from `docker` and audit `wheel`/sudo on **queue-host**;
   revisit sshd `PasswordAuthentication yes` there.
3. Reset the `crq` password state on queue-host (locked account: re-lock;
   agents may have reached it via the sudo path).
4. Re-authenticate CodeRabbit as crq (`coderabbit auth login`).
5. Inspect `/home/crq` for planted units, rc files, cron, `~/.ssh` keys;
   remove anything not provisioned by S1/S2; `systemctl list-units --user`
   as crq.
6. Verify the `coderabbit` and `gitleaks` binaries in `/opt/cq-reviewer/bin`
   against known-good checksums (reinstall from upstream if in doubt).

## Recovered implementation, 2026-10-10

These real PR-A artifacts were recovered from local branch
`identity/cq-reviewer-signer` at `f43b48f`. Earlier missing-source statements
referred to the deployed/main checkout and `/opt` installation, not repository
history. (At recovery nothing was installed; installed, S2-probed and activated
on queue-host 2026-10-10 — see DEPLOY.md.)
The actual unit is `crq-signer.service`; no invented `cq-reviewer.service` is needed.

Transport now uses isolated stdlib Python, accepts the same five verbs and exact
v1 framing, bounds request stdin to 4096 bytes and no-follows regular spool files.
A put repeats identical unclaimed bytes idempotently, refuses changed payloads
and claimed/completed identities, and publishes with an exclusive link after fsync.
Snapshot treats the hidden claiming file as claimed, closing the rename/marker
visibility gap. Withdrawal still returns RM or ENOENT at the same atomic unlink
boundary. The daemon rechecks claimed bytes against its validated checksum.
Terminal results are retained, never replaced. Recovery includes hidden claiming
files even when the process died before creating the claimed marker; it records
an interrupted outcome and never starts another review for that identity.

### Signed record URL, runtime configuration only

Owner-installed `/etc/cq-reviewer/runtime.json` may contain a `record_base` URL.
No private hostname is compiled into the signer or committed as its configured
base. Only http/https origins without userinfo, query or fragment are accepted.
The signed URL is `<record_base>/promotion/<record_alias>`; URL does not confer
trust. App5230901, bot339373542, installation169119051 remain authoritative.

The sole mapping implementation is `signer/record_ids.py` (the queue imports it
through `record_ids.py`). Accept ONLY `promo-<10 lowercase hex>+{0,9}`, then replace
`+` by `_` for the URL alias. Canonical IDs contain no underscores; replacing `_`
back by `+` is an exact inverse, so aliases are injective. Requests, state, results,
checksums and trust retain the raw exact v1 ID. The writer persists raw and alias
routes with the same raw `item`, refuses existing files bound to another item,
and the reader revalidates alias/raw ID and JSON binding. Raw routes also accept
percent-encoded `+`; only one decode occurs, traversal/other names are refused.

Install the exact reviewed `signer/record_ids.py` beside the daemon. Isolated
Python explicitly loads that root-owned sibling, never a worker's module path.

### Owner inputs after artifact review

The owner supplies custody key/metadata, dedicated transport key and restricted
`authorized_keys`, installation grants (S2-a), and actual creator evidence (S2-b).
Never send private key/token contents to the conductor. Existing binary provenance,
root ownership and package-integrity evidence are required before enablement.
S2-b was owner-authorized and observed 2026-10-10 (DEPLOY.md); further probes
remain owner-authorized actions.
An installation or code review does not produce S2 evidence. Runtime repair
remains disabled; this signer only consumes requests already quota-reserved by crq.

Independent source-review corrections: restore selectors explicitly include both
`.coderabbit.yaml` and `.coderabbit.yml`. Before claim rename the daemon fsyncs a
private validated request/checksum journal under its 0700 state directory. Recovery
uses that private journal exclusively; unjournaled old/shared orphan files require
human reconciliation and cause no App status or automatic review dispatch.

Signer and owner override share private `publication.lock`, held across status
read/check/post. The override revalidates main/subject after interactive confirmation
under this lock. An override posted first cannot be replaced by a later signer
pending/failure/error; an override waiting behind a signer post is published last.
Only the pinned context is considered by success-preservation checks.

Legacy user-mode record IDs (`promo-<sha>-delta` and arbitrarily repeated `+`)
retain their raw records/routes and percent-encoded status URLs. They never enter
canonical signer alias mapping. Canonical alias routes remain injective and are
always checked against the exact raw `item` stored in their record.
