# Signer installation

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
