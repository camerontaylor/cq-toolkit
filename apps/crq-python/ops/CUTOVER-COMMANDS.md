# Prepared handover command sheet

Candidate: the reviewed head that contains this sheet (it carries the `-F none`
spool transport; 946a96b does not); record the exact SHA in
state/implementation-deployment.json. Execute sections in order, inspecting each
result. This is a command sheet, not an
automatic deployment script. worker-host remains owner until section 4 completes.
Repair remains disabled. No tests, probes, or credential output are permitted.

## 1. Non-secret readiness and owner evidence

Identity lane must hand over the reviewed source commit, signer service unit,
forced-command spool-shell artifact, installation paths/ownership, v1 request,
snapshot and withdrawal contract, and signed status target_url support. Pin the
App/bot/install to 5230901/339373542/169119051 from the owner record.

S2 owner evidence is separate: owner-installed custody key and dedicated spool
SSH public-key registration, restrictive modes, exact forced-command restriction,
and any already-authorized installation/probe attestation. Private key provisioning
is owner-only. Request paths, public fingerprints and evidence references, never
secret contents. No new probe is authorized by this sheet. Until ready, signed
promotion stays fail-closed; no user identity or plain-shell fallback.

```sh
ssh queue-host 'git -C /home/operator/repos/coderabbit-queue rev-parse HEAD'
ssh queue-host 'systemctl --user is-active crq-tick.timer crq-tick.service crq-repair.service crq-repair.path crq-repair.timer crq-watchdog.timer crq-records.service'
ssh queue-host 'test -f /home/operator/repos/coderabbit-queue/state/runner-disabled'
```

Ordering: cut over only after cq-toolkit `origin/main` carries
`policy/promotion-reviewer.json` (the bootstrap promotion is cut by the
user-mode worker-host runner and promoted by main's pre-PR-B gate). Before that the
candidate halts promotion (`signer_unconfigured`); after it the worker-host runner's
User statuses are refused by the gate, so do not leave worker-host running past it.

Deliver the candidate. The queue-host checkout's `origin` is the bundle path
`/tmp/crq-implementation-20261009.bundle`; `config.json` there is generated, so
discard it before moving the checkout, then re-render it:

```sh
git -C /srv/operator/repos/worktrees/crq-implementation-20261009 bundle create /tmp/crq-implementation-20261009.bundle impl/crq-review-repair-20261009
scp /tmp/crq-implementation-20261009.bundle queue-host:/tmp/crq-implementation-20261009.bundle
ssh queue-host 'cd /home/operator/repos/coderabbit-queue && git fetch origin && git restore config.json && test -z "$(git status --porcelain)" && git merge --ff-only origin/impl/crq-review-repair-20261009 && python3 ops/prepare-host.py'
ssh queue-host 'cd /home/operator/repos/coderabbit-queue && python3 -c "import json;s=json.load(open(\"config.json\"))[\"promotion\"][\"signer\"];print(s[\"app_login\"],s[\"reviewer_bot_id\"],s[\"spool\"][\"ssh_alias\"],s[\"spool\"][\"ssh_key\"])"'
# expect: cq-promotion-reviewer[bot] 339373542 operator@127.0.0.1 ~/.ssh/crq-spool-ed25519
```

`prepare-host.py` renders from the committed `HEAD:config.json`, so re-running
it is idempotent. After the handover NEVER run it plain (it marks the runner
inert). Live update procedure (code or committed config change):
`systemctl --user stop crq-tick.timer`, wait for `crq-tick.service` inactive,
`git restore config.json`, fast-forward, `python3 ops/prepare-host.py
--live-config` (holds the tick lock, rewrites config.json only — live-only edits
are overwritten and repair stays disabled), `systemctl --user start
crq-tick.timer`, then confirm the next `~/.local/state/crq/heartbeat.json` has
`"alert_agent_host": "worker-host.tailnet.example:6767"`. Verify the spool with crq's exact argv:

```sh
ssh queue-host '/usr/bin/ssh -F none -i ~/.ssh/crq-spool-ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none -o BatchMode=yes operator@127.0.0.1 exist promo-0000000000'   # promo-0000000000 0
ssh queue-host '/usr/bin/ssh -F none -i ~/.ssh/crq-spool-ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none -o BatchMode=yes operator@127.0.0.1 id'   # spool-shell: operation refused, exit 2
```

Expected: delivered reviewed head, every unit inactive, marker present. Inspect
host config without dumping it: repairs false, both quiet-gate endpoints set,
dedicated runtime clone, dedicated signer transport or explicit unavailable
signer. The dedicated toolkit build is 2d58441298f52561167166a88797b72ceb33582b.
Spend/ZAI are repair-only prerequisites, not ordinary tick blockers.

## 2. Pause, drain and retain rollback material

```sh
paseo schedule pause schedule-example --json
```

Inspect only selected schedule ownership fields; retain its exact definition for
rollback. Wait for its current agent/tick and queue-owned review/addressing PIDs
to finish. Match PID plus command/run identity; do not kill unrelated processes.
Require no reviewing/addressing/requested/signer_running queue records and no
unresolved remote signer ownership before migrating. Schedule pause alone does
not stop an already-running tick.

Acquire and hold an exclusive Python fcntl.flock on
/srv/operator/repos/coderabbit-queue/state/tick.lock throughout snapshot
and transfer. Keep that lock holder alive until worker-host inertness is established.
Under the lock, retain an immutable dated rollback directory containing:

- state archive excluding tick.lock, repair/service.lock and runner-disabled;
- queue digest, exact schedule definition, old summary/watchdog script and plist;
- Git object bundle from the configured queue clone.

Before bundling, recursively collect full commit hashes from queue.json and every
runs/*/meta.json. Verify each with git cat-file; pin each available commit under
refs/crq/cutover/<sha> using git update-ref. Then git bundle create with --all.
The preparation inventory found 252 commits, none missing; repeat while locked.
This retains old synthetic objects that a fresh remote clone does not contain.
Abort on missing objects needed by nonterminal items; record historical gaps.
Never archive or delete unpushed worktrees.

## 3. Import while both destinations are inert

Copy archive/bundle to queue-host with scp. Extract state into the dedicated checkout
while preserving its runner-disabled marker. Do not transfer host-local locks.
Import bundle objects without moving the runtime checkout:

```sh
ssh queue-host 'git -C /home/operator/repos/crq-toolkit-runtime fetch /path/to/retained-queue.bundle "+refs/*:refs/crq/cutover-import/*"'
```

Replace the placeholder with the retained bundle path. Compare source/destination
queue SHA256 and verify all retained commit objects exist on queue-host. Record source
and destination digests, reviewed queue head and toolkit head. Preserve the
prepared host config; state migration must not overwrite it.

## 4. Transfer runner ownership exactly once

Create worker-host state/runner-disabled while holding its tick lock. Old worker-host
main does not honor this marker: paused/deleted scheduling and process drain are
the actual ownership fence. After successful import, delete the old schedule:

```sh
paseo schedule delete schedule-example --json
launchctl bootout gui/$(id -u)/com.crq.watchdog
```

If bootout reports absent service, confirm absence explicitly. Prove schedule
absent, old marker present, and no matching owned tick/review/addressing process.
Only then release the old tick lock and remove queue-host's marker:

```sh
ssh queue-host 'rm /home/operator/repos/coderabbit-queue/state/runner-disabled && systemctl --user start crq-records.service && systemctl --user enable --now crq-tick.timer crq-watchdog.timer'
```

Do not enable repair service/path/timer. Inspect unit state/journal and the first
ordinary completed tick; this is runtime operation, not a probe. Do not claim
24-hour acceptance from the first tick.

## 5. Preserve fleet-reader compatibility

After queue-host publishes a valid schema-2 XDG summary, copy ops/fleet-reader.py to
~/Library/Application Support/crq/fleet-reader.py and its plist to
~/Library/LaunchAgents/com.crq.fleet-reader.plist on worker-host, then:

```sh
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.crq.fleet-reader.plist"
```

Verify mirrored source_host=queue-host and unchanged source last_tick. The actual fleet
consumer remains unidentified; this preserves both documented legacy and XDG
locations. Record deployment evidence in state/implementation-deployment.json.

## Rollback

Stop queue-host tick/watchdog timers first; wait for exact owned reviews and signer
ownership to drain, then stop records service and mark queue-host inert. Lock both
hosts while retaining and migrating the latest queue state back; verify digests.
Repeat section 2's recursive commit inventory on the latest queue-host queue and run
metadata under the locks. Verify and pin those commits in the queue-host runtime clone,
then create a fresh --all Git bundle. Transfer that bundle with the latest state
to worker-host and import its refs into a retained namespace in worker-host's configured
queue clone, without moving its checkout. Verify every required commit object
exists on worker-host before restoring ownership; matching queue digests alone is
insufficient. Stop rollback on missing objects needed by nonterminal records.
Unload com.crq.fleet-reader before restoring worker-host summaries. Restore retained
watchdog artifacts and bootstrap its plist. Prove queue-host inert with no active
owned jobs before removing worker-host's marker and recreating the retained schedule
definition. Never use the original snapshot over newer queue state without
explicit reconciliation. Repair remains disabled on both hosts.

Once cq-toolkit `main` carries the reviewer policy, a worker-host runner on old code
(`da295ce`) can no longer promote (its mode detection predates the policy file).
Before removing worker-host's marker, move its runner checkout to this candidate or
later (identity pins, `-F none`, policy-file mode), then set
`promotion.signer.spool` to `operator@queue-host.local.example.invalid` +
`~/.ssh/crq-spool-ed25519` (LAN only; the committed default is queue-host loopback)
and verify from worker-host itself. `queue-host.local.example.invalid` is a
redacted deployment placeholder, not a usable hostname. Replace it in both the
spool configuration and the command below with the owner-provided reachable LAN
hostname before starting the runner:

```sh
/usr/bin/ssh -F none -i ~/.ssh/crq-spool-ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none -o BatchMode=yes operator@queue-host.local.example.invalid exist promo-0000000000   # promo-0000000000 0
```
