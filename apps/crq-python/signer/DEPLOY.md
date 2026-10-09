# Prepared signer installation — owner execution only

No commands here have been executed. Do not enable until artifact review and
owner-held dependencies are complete; worker-host remains sole queue runner.
Use the final exact reviewed commit, never working-tree bytes.

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
   group. Private key stays outside every Git checkout. No general SSH fallback.
4. Owner installs runtime config `/etc/cq-reviewer/runtime.json` root:root0644
   containing the actual `record_base`, and supplies key custody/binary integrity
   and S2-a/S2-b evidence separately. Do not print tokens, PEM contents or CLI logs.
5. Activation is a later authorized step, currently suspended. Only then reload
   system units and enable crq-signer.service. Queue host handover remains governed
   by ../ops/CUTOVER-COMMANDS.md and its mutually exclusive runner fencing.

Rollback: stop the signer and let exact owned CLI processes terminate; retain
private coverage/start ledgers and public results/claims. Never clear claims to
force a retry. Roll back root-owned committed artifacts only while stopped; use
orphan recovery on the next authorized start. Keep all keys and spool evidence.
