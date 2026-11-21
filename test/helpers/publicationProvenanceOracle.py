"""Differential oracle for the repair provenance table: the real
`repair_tick.repair_provenance` (apps/crq-python/repair_tick.py) over a throwaway
state tree, plus a builder for valid review-ledger records.

Test tooling only. Usage: python3 -I publicationProvenanceOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is one of

  {"op": "provenance", "repo": str, "run": <json>, "record": <json>,
   "files": {"<path under state/>": text | {"hex": "<bytes>"} | {"dir": true}},
   "outside": {"<path under the sibling outside/ dir>": text}}
  {"op": "review", "source": str, "findings": [{"title": str}]}

`${OUT}` anywhere in a "provenance" case is replaced by the absolute path of
the `outside/` directory, a sibling of the repository root, so a source run can
point outside `STATE.parent` (the `relative_to` `ValueError`).

A "provenance" result is {"ok": [line]} or {"error": "<exception family>"}, the
family being the first of OSError, ValueError, KeyError, TypeError, AttributeError
the exception is an instance of. A
"review" result is {"ok": {"record": <review>, "finding_ids": [str]}}: a
schema-valid review with the findings the production normalizer produced, its
`id` re-derived, and a fixed artifact reference (validation does not read the
artifact). No network, git, forge or child process.
"""
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
import finding_delivery  # noqa: E402
import repair_tick  # noqa: E402
import review_ledger as ledger  # noqa: E402
import test_review_ledger  # noqa: E402

ARTIFACT = {'sha256': 'c' * 64, 'location': '/artifacts/sha256/' + 'c' * 64}


def build_review(case):
    findings = [finding_delivery.normalize('crq-runner-app', case['source'], {
        'severity': 'major', 'path': 'src/a.ts', 'blob': 'a' * 40, 'intervals': [[1, 2]],
        'title': f['title'], 'body': 'body'}) for f in case['findings']]
    record = test_review_ledger.review([ARTIFACT], case['source'], findings)
    test_review_ledger.rehash(record)
    ledger.validate(record)
    return {'record': record, 'finding_ids': [f['id'] for f in findings]}


def lay_out(base, files):
    for rel, content in files.items():
        path = base / rel
        if isinstance(content, dict) and content.get('dir'):
            path.mkdir(parents=True, exist_ok=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, dict):
            path.write_bytes(bytes.fromhex(content['hex']))
        else:
            path.write_text(content)


def provenance(case):
    with tempfile.TemporaryDirectory(prefix='crq-provenance-oracle-') as tmp:
        tmp = Path(tmp).resolve()
        root, outside = tmp / 'root', tmp / 'outside'
        state = root / 'state'
        state.mkdir(parents=True)
        outside.mkdir()
        case = json.loads(json.dumps(case).replace('${OUT}', str(outside)))
        lay_out(state, case.get('files', {}))
        lay_out(outside, case.get('outside', {}))
        c = SimpleNamespace(STATE=state, REPO=case['repo'])
        return repair_tick.repair_provenance(c, case['record'], case['run'])


def family(exc):
    """The class `repair_provenance`'s callers and its own `except` clauses see:
    OSError (FileNotFoundError, IsADirectoryError, ...) and ValueError
    (JSONDecodeError, UnicodeDecodeError, ledger.IntegrityError, ...) collapse
    to their base, since TypeScript raises one `PyError` per family."""
    for base in (OSError, ValueError, KeyError, TypeError, AttributeError):
        if isinstance(exc, base):
            return base.__name__
    return type(exc).__name__


def main():
    results = []
    for case in json.load(sys.stdin)['cases']:
        try:
            ok = build_review(case) if case['op'] == 'review' else provenance(case)
            results.append({'ok': ok})
        except Exception as exc:  # noqa: BLE001 - the exception family is the result
            results.append({'error': family(exc)})
    json.dump({'results': results}, sys.stdout)


main()
