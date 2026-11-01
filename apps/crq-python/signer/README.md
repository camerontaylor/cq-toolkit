# crq review-ledger signer

`crq-signer.py ledger-publish` is the root-owned publication capability for the
CodeRabbit backfill. It accepts a bounded stdin frame, validates exact add-only
ledger commits, and pushes to `cq/review-ledger` with a repository-scoped App
token. The App identity, keys, root-owned validators and dedicated SSH transport
retain their existing custody. No promotion reviews or commit statuses run.

The independent `crq-ledger-publish.socket` and service remain installed.
`spool-shell ledger-only` exposes the ledger capability over its dedicated key;
old promotion spool files remain historical. The daemon, probe, promotion override
and daemon service are retired. See [DEPLOY.md](DEPLOY.md) for the drained switch.
