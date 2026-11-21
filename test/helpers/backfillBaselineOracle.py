"""Differential oracle for S4 baseline accounting: `backfill_report.summary`
over a real local Git repository.

Test tooling only. Usage: python3 -I backfillBaselineOracle.py <apps/crq-python dir>
Reads {"repo": path, "ranked": doc, "queue": doc, "baseline_text": str | null} on stdin
and writes {"ok": true, "report_b64": <canonical report bytes>} or
{"ok": false, "error": <message>, "class": <exception class>}. `baseline_text` is the
baseline.json text, decoded with `ledger.loads` exactly as
`backfill_runtime.run_inventory` does; null means no baseline file. The repository is
a temporary fixture the test created; no network, provider or live state is read.
"""
import base64
import json
import sys

sys.path.insert(0, sys.argv[1])
import backfill_accounting  # noqa: E402
import backfill_report  # noqa: E402
import review_ledger as ledger  # noqa: E402


def main():
    request = json.load(sys.stdin)
    try:
        repo = backfill_accounting.Repository(request["repo"])
        repo.begin_invocation()
        text = request.get("baseline_text")
        original = None if text is None else ledger.loads(text.encode("utf-8"))
        report = backfill_report.summary(repo, request["ranked"], request["queue"], original,
                                         findings_root=None)
        out = {"ok": True, "report_b64": base64.b64encode(ledger.canonical(report)).decode()}
    except Exception as exc:  # noqa: BLE001 - the differential records every refusal class
        out = {"ok": False, "error": str(exc), "class": type(exc).__name__}
    sys.stdout.write(json.dumps(out))


main()
