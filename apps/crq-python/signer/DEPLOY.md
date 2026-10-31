# Signer installation

## Ledger-only root operation

After the owner grants the runner App Contents write permission and approves the
installation update, install the reviewed `crq-signer.py` and `spool-shell` by
the pinned artifact process below. Install `crq-ledger-publish.socket` and
`crq-ledger-publish@.service` root-owned mode 0644 in `/etc/systemd/system`.
Also install `apps/crq-python/review_ledger.py` and
`policy/review-ledger.schema.json` as root-owned mode 0644 beside the signer
under `/opt/cq-reviewer/`. The root operation refuses caller-writable validators.
Run `systemd-analyze verify` on both units before `daemon-reload`, then enable
and start only `crq-ledger-publish.socket`. The existing promotion daemon keeps
its dedicated `crq` user; each ledger connection starts the separate root
entrypoint with private temporary storage. Its socket is root:crq-ledger-publish
0660. Owner provisioning creates a dedicated publisher SSH principal in that
group and a separate runner-only key, whose forced command is
`/opt/cq-reviewer/spool-shell ledger-only` with the existing SSH restrictions.
The ordinary promotion key retains its existing forced command and cannot
invoke ledger publication; the ledger-only key cannot invoke promotion verbs.
Do not add the ordinary spool account to the publisher socket group.

Provision `publisher_spool` in the private `state/backfill-rollout.json` with
the dedicated `ssh_alias` (literal `user@host`) and `ssh_key` path. This is an
owner credential action, separate from code installation. The publisher refuses
missing transport configuration and never falls back to the promotion key.

The forced SSH transport accepts `ledger-publish <base> <head>` and a bounded
Git bundle, never a repository path, token, remote or ref. The root entrypoint
mints a repository-scoped Contents-write token, fetches only the ledger, checks
the exact advertised commit, its single parent and one add-only regular record,
validates record schema, hashes and complete ledger sequence, and uses a normal
fast-forward push to the fixed ledger branch. The service bounds memory to
256 MiB without swap, temporary storage to 128 MiB, individual files to 64 MiB,
address space to 512 MiB and execution to 330 seconds before unpacking any
caller bundle. These limits contain compressed or unreachable object abuse.
It revokes the
token after use. Tokens remain in the root process environment and API headers;
neither tokens nor the PEM reach the caller, command arguments or response.

A lost reply retains the publication outbox: refetch reconciles the same event
without another vendor review. A moved base requires rebuilding on the fetched
head. Permission refusal leaves publication pending; never enable a human SSH
fallback or relax the App-only ruleset. Stop the socket to disable new ledger
publication; retain all ledger/outbox records and let active connections finish.

The installed `crq-override` has documented host-name drift. Preserve it unless
its separate owner-approved update is explicitly required; ledger installation
does not require overwriting that artifact.

## Promotion daemon artifacts

Installed and activated on queue-host 2026-10-10 (owner-authorized); evidence and
hashes: toolkit-research `plans/s2-signer-install-record-20261010.md`. Every
redeploy repeats steps 1–2 from a NEW pinned commit, then `daemon-reload` and
`restart` — only while no `results/<id>.claimed` lacks its `results/<id>.json`
and no `requests/.<id>.json.claiming` exists (a restart kills the CodeRabbit
child; that id is recorded `interrupted` and never reviewed again), otherwise
wait. Use the final exact reviewed commit,
never working-tree bytes.

1. Export `git archive <reviewed-full-sha> signer/` into a fresh staging directory.
   Record SHA256 of daemon, override, spool-shell, record_ids.py and service unit.
2. Owner installs these non-secret artifacts root-owned:

   - `/opt/cq-reviewer/crq-signer.py`, `crq-override`, `spool-shell`: mode0755;
   - `/opt/cq-reviewer/record_ids.py`: mode0644;
   - `/etc/systemd/system/crq-signer.service`: mode0644.

   Unit ExecStart is `/usr/bin/python3 -I /opt/cq-reviewer/crq-signer.py`.
   Compare installed hashes with staged committed hashes. Static systemd unit
   verification may run; no daemon/probe starts are implied.
3. Owner prepares the v1 spool directories/group and dedicated forced-command
   SSH key/authorized_keys per README. Prepare requests/.transport.lock owned
   root:crq-spool mode0660; both signer and dedicated transport account need that
   group. Private key stays outside every Git checkout. No general SSH fallback:
   crq runs ssh with `-F none` and a literal `user@host` (README "Transport
   isolation"); never the Tailscale SSH address, which ignores authorized_keys.
4. Owner installs runtime config `/etc/cq-reviewer/runtime.json` root:root0644
   containing the actual `record_base`, and supplies key custody/binary integrity
   and S2-a/S2-b evidence separately. Do not print tokens, PEM contents or CLI logs.
5. Activation: `systemctl daemon-reload && systemctl enable --now crq-signer.service`
   (done 2026-10-10). Queue host handover remains governed by
   ../ops/CUTOVER-COMMANDS.md and its mutually exclusive runner fencing.

Rollback: stop the signer and let exact owned CLI processes terminate; retain
private coverage/start ledgers and public results/claims. Never clear claims to
force a retry. Roll back root-owned committed artifacts only while stopped; use
orphan recovery on the next authorized start. Keep all keys and spool evidence.

Single source reconciliation: install artifacts from the final integrated reviewed
head of impl/crq-review-repair-20261009, not the older standalone f43b48f branch.
Queue and signer use the same structured policy contract on origin/main. Missing
policy or unset host identity refuses promotion; no workflow-text heuristic.
